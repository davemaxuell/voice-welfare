"""
복지 데이터(Agent B 근거): 한국사회보장정보원 중앙부처·지자체 복지서비스 API와 fixture 대체 자료.
서비스·출처는 JSON과 같은 camelCase 키의 dict로 다룬다.
"""
from __future__ import annotations

import html
import json
import logging
import time
import xml.etree.ElementTree as ET
from importlib import resources
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal, Optional, TypeVar

import httpx
import regex
from pydantic import BaseModel, ConfigDict, field_validator

from cheongeum.core.jsutil import compact, is_valid_url, now_iso, rx, today_iso

log = logging.getLogger("cheongeum.welfare")
T = TypeVar("T")

FIXTURE_DIR = resources.files(__package__).joinpath("fixtures")
DEFAULT_FIXTURE_PATH = str(FIXTURE_DIR.joinpath("welfare_services.json"))


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


class SourceRef(_M):
    title: str
    url: str
    lastCheckedAt: str
    version: str
    note: Optional[str] = None

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        if not is_valid_url(v):
            raise ValueError("invalid url")
        return v


class _Step(_M):
    step: str
    detail: str


class _Contact(_M):
    name: str
    value: str


class _Form(_M):
    name: str
    url: str


class WelfareServiceModel(_M):
    servId: str
    servNm: str
    summary: str
    target: str
    applyMethod: str
    source: SourceRef
    # 이하 공식 API 상세조회에서만 채워진다
    criteria: Optional[str] = None
    benefit: Optional[str] = None
    applySteps: Optional[list[_Step]] = None
    contacts: Optional[list[_Contact]] = None
    forms: Optional[list[_Form]] = None
    laws: Optional[list[str]] = None
    ministry: Optional[str] = None
    criteriaYear: Optional[str] = None
    onlineApply: Optional[bool] = None


class FieldGlossaryEntry(_M):
    fieldId: str
    term: str
    explanation: str
    source: SourceRef


class WelfareFixture(_M):
    version: str
    dataOrigin: Literal["fixture"]
    notice: str
    services: list[WelfareServiceModel]
    fieldGlossary: list[FieldGlossaryEntry]


# ---------------------------------------------------------------- XML (fast-xml-parser와 같은 모양으로)

_ARRAY_TAGS = {"servList", "applmetList", "inqplCtadrList", "inqplHmpgReldList", "basfrmList", "baslawList"}
_XML_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}


def _to_value(el: ET.Element) -> Any:
    children = list(el)
    if not children:
        return (el.text or "").strip()
    out: dict[str, Any] = {}
    for c in children:
        v = _to_value(c)
        if c.tag in _ARRAY_TAGS:
            out.setdefault(c.tag, []).append(v)
        elif c.tag in out:
            prev = out[c.tag]
            out[c.tag] = [*prev, v] if isinstance(prev, list) else [prev, v]
        else:
            out[c.tag] = v
    return out


def parse_xml(body: str) -> dict:
    """XML → {루트 태그: 값}. HTML 엔티티(&nbsp; 등)도 받는다. 형식이 아니면 빈 dict."""

    def fix(m) -> str:
        name = m.group(1)
        if name in _XML_ENTITIES or name.startswith("#"):
            return m.group(0)
        ch = html.unescape(m.group(0))
        return html.escape(ch, quote=False) if ch != m.group(0) else m.group(0)

    # 공공 API 응답에는 DTD가 없다. DTD·엔티티 선언이 있으면(XXE·엔티티 폭탄 위험) 파싱하지 않는다.
    if rx(r"<!(DOCTYPE|ENTITY)", regex.IGNORECASE).search(body):
        return {}
    try:
        cleaned = rx(r"&([A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);").sub(fix, body)
        root = ET.fromstring(cleaned.encode("utf-8"))
    except (ET.ParseError, ValueError):
        return {}
    return {root.tag: _to_value(root)}


def _as_dict(v: Any) -> dict | None:
    return v if isinstance(v, dict) else None


def items(v: Any) -> list[dict]:
    return [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []


_ENTITIES = {"times": "×", "divide": "÷", "ge": "≥", "le": "≤", "amp": "&", "lt": "<", "gt": ">", "quot": '"', "nbsp": " "}


def clean_api_text(raw: Any) -> str:
    """응답에 이중 인코딩된 HTML 엔티티(&amp;times; 등)와 &#13; 줄바꿈이 섞여 있어 정리한다."""
    if raw is None:
        return ""
    if isinstance(raw, (dict, list)):
        return ""
    s = str(raw)
    s = rx(r"&#(\d+);").sub(lambda m: chr(int(m.group(1))), s)
    s = rx(r"&([a-z]+);").sub(lambda m: _ENTITIES.get(m.group(1), m.group(0)), s)
    s = rx(r"\r\n?").sub("\n", s)
    s = rx(r"[ \t]+\n").sub("\n", s)
    return s.strip()


def _first(r: dict, *keys: str) -> Any:
    """r.a ?? r.b"""
    for k in keys:
        if r.get(k) is not None:
            return r[k]
    return None


def _split_list(v: Any) -> list[str]:
    s = "" if v is None else (v if isinstance(v, str) else "")
    return [x.strip() for x in s.split(",") if x.strip()]


class WelfareApiError(Exception):
    def __init__(self, reason: str, status: int | None = None) -> None:
        super().__init__(f"welfare api: {reason}")
        self.reason = reason
        self.status = status


def api_error_message(body: str) -> str:
    parsed = parse_xml(body)
    h = _as_dict((_as_dict(parsed.get("OpenAPI_ServiceResponse")) or {}).get("cmmMsgHeader"))
    return f"{clean_api_text(h.get('errMsg'))} ({clean_api_text(h.get('returnAuthMsg'))})" if h else "알 수 없는 응답 형식"


def parse_service_catalog(body: str, provider: Literal["central", "local"]) -> list[dict]:
    """목록조회 XML → 요약 목록(맞춤 찾기용). 중앙(lifeArray…)·지자체(lifeNmArray…, ctpvNm) 필드를 모두 받는다."""
    root = _as_dict(parse_xml(body).get("wantedList"))
    if root is None:
        raise WelfareApiError(api_error_message(body))
    out: list[dict] = []
    for r in items(root.get("servList")):
        online = clean_api_text(r.get("onapPsbltYn")) == "Y" if r.get("onapPsbltYn") is not None else None
        region = None
        if r.get("ctpvNm"):
            region = compact({"ctpv": clean_api_text(r.get("ctpvNm")), "sgg": clean_api_text(r.get("sggNm")) or None})
        out.append(
            compact(
                {
                    "servId": clean_api_text(r.get("servId")),
                    "servNm": clean_api_text(r.get("servNm")),
                    "summary": clean_api_text(r.get("servDgst")),
                    "lifeStages": [rx(r"\s*·\s*").sub("·", x) for x in _split_list(_first(r, "lifeArray", "lifeNmArray"))],
                    "targets": _split_list(_first(r, "trgterIndvdlArray", "trgterIndvdlNmArray")),
                    "themes": _split_list(_first(r, "intrsThemaArray", "intrsThemaNmArray")),
                    "onlineApply": online,
                    "provider": provider,
                    "region": region,
                    "ministry": clean_api_text(_first(r, "jurMnofNm", "bizChrDeptNm")) or None,
                    "detailUrl": clean_api_text(r.get("servDtlLink")),
                    "lastModified": clean_api_text(_first(r, "lastModYmd", "svcfrstRegTs")) or None,
                    "provision": clean_api_text(r.get("srvPvsnNm")) or None,
                    "cycle": clean_api_text(r.get("sprtCycNm")) or None,
                }
            )
        )
    return out


def _official_source(serv_nm: str, url: str, checked_at: str, year: str | None = None) -> dict:
    return {
        "title": f"복지로 '{serv_nm}' (한국사회보장정보원 중앙부처복지서비스 API)",
        "url": url or "https://www.data.go.kr/data/15090532/openapi.do",
        "lastCheckedAt": checked_at,
        "version": f"{year}년 기준" if year else "API 실시간",
        "note": "공식 API 실시간 조회",
    }


def parse_welfare_list(body: str, checked_at: str | None = None) -> list[dict]:
    """목록조회(callTp=L) XML → 서비스 요약. 필드는 실제 응답으로 확인함(2026-11-16)."""
    checked_at = checked_at or today_iso()
    root = _as_dict(parse_xml(body).get("wantedList"))
    if root is None:
        raise WelfareApiError(api_error_message(body))
    if str(root.get("resultCode") if root.get("resultCode") is not None else "0") != "0":
        raise WelfareApiError(str(root.get("resultMessage") or "resultCode != 0"))
    out = []
    for r in items(root.get("servList")):
        serv_nm = clean_api_text(r.get("servNm"))
        out.append(
            {
                "servId": clean_api_text(r.get("servId")),
                "servNm": serv_nm,
                "summary": clean_api_text(r.get("servDgst")),
                "target": "",
                "applyMethod": "",
                "ministry": " ".join(x for x in [clean_api_text(r.get("jurMnofNm")), clean_api_text(r.get("jurOrgNm"))] if x),
                "onlineApply": clean_api_text(r.get("onapPsbltYn")) == "Y",
                "source": _official_source(serv_nm, clean_api_text(r.get("servDtlLink")), checked_at),
                "dataOrigin": "official-api",
            }
        )
    return out


def parse_welfare_detail(body: str, detail_url: str, checked_at: str | None = None) -> dict:
    """상세조회(callTp=D) XML → 서비스 상세. 출처 링크는 목록조회의 servDtlLink를 넘겨받는다."""
    checked_at = checked_at or today_iso()
    r = _as_dict(parse_xml(body).get("wantedDtl"))
    if r is None:
        raise WelfareApiError(api_error_message(body))
    if str(r.get("resultCode") if r.get("resultCode") is not None else "0") != "0":
        raise WelfareApiError(str(r.get("resultMessage") or "resultCode != 0"))
    serv_nm = clean_api_text(r.get("servNm"))
    apply_steps = [
        {"step": rx(r"연락처목록|목록").sub("", clean_api_text(a.get("servSeDetailNm"))).strip(), "detail": clean_api_text(a.get("servSeDetailLink"))}
        for a in items(r.get("applmetList"))
    ]
    criteria_year = clean_api_text(r.get("crtrYr"))
    # 지자체 상세(LcgvWelfaredetailed)는 필드 이름이 다르다: sprtTrgtCn·aplyMtdCn·wlfareInfoReld*
    local = r.get("ctpvNm") is not None
    contacts = [
        {
            "name": clean_api_text(_first(c, "servSeDetailNm", "wlfareInfoReldNm")),
            "value": clean_api_text(_first(c, "servSeDetailLink", "wlfareInfoReldCn")),
        }
        for c in [*items(r.get("inqplCtadrList")), *items(r.get("inqplHmpgReldList"))]
    ]
    forms = [
        {"name": clean_api_text(_first(f, "servSeDetailNm", "wlfareInfoReldNm")), "url": clean_api_text(_first(f, "servSeDetailLink", "wlfareInfoReldCn"))}
        for f in items(r.get("basfrmList"))
    ]
    laws = [x for x in (clean_api_text(_first(law, "servSeDetailNm", "wlfareInfoReldNm")) for law in items(r.get("baslawList"))) if x]
    return {
        "servId": clean_api_text(r.get("servId")),
        "servNm": serv_nm,
        "summary": clean_api_text(_first(r, "wlfareInfoOutlCn", "servDgst")),
        "target": clean_api_text(_first(r, "tgtrDtlCn", "sprtTrgtCn")),
        "criteria": clean_api_text(r.get("slctCritCn")),
        "benefit": clean_api_text(r.get("alwServCn")),
        "applyMethod": apply_steps[0]["detail"] if apply_steps else clean_api_text(_first(r, "aplyMtdCn", "aplyMtdNm")),
        "applySteps": apply_steps,
        "contacts": contacts,
        "forms": forms,
        "laws": laws,
        "ministry": clean_api_text(r.get("jurMnofNm") if r.get("jurMnofNm") is not None else (r.get("bizChrDeptNm") if local else None)),
        "criteriaYear": criteria_year,
        "source": _official_source(serv_nm, detail_url, checked_at, criteria_year),
        "dataOrigin": "official-api",
    }


def _read_fixture(name: str) -> str:
    return FIXTURE_DIR.joinpath(name).read_text(encoding="utf-8")


def fixture_catalog(ctpv: str | None = None) -> list[dict]:
    """저장해 둔 실제 목록 응답(2026-11-16). API 키가 없거나 실패할 때의 대체 자료. 지자체는 부산 예시만."""
    central = parse_service_catalog(_read_fixture("welfare-catalog-central.xml"), "central")
    local = parse_service_catalog(_read_fixture("welfare-catalog-local-busan.xml"), "local") if ctpv == "부산광역시" else []
    return [*central, *local]


def _normalize(s: str) -> str:
    return rx(r"\s").sub("", s)


class FixtureWelfareDataProvider:
    mode = "fixture"

    def __init__(self, data: dict) -> None:
        self.data = data

    @classmethod
    def from_file(cls, path: str | None = None) -> "FixtureWelfareDataProvider":
        raw = json.loads(Path(path or DEFAULT_FIXTURE_PATH).read_text(encoding="utf-8"))
        WelfareFixture.model_validate(raw)  # 형식 확인
        return cls(raw)

    @property
    def notice(self) -> str:
        return self.data["notice"]

    async def catalog(self, ctpv: str | None = None) -> list[dict]:
        return fixture_catalog(ctpv)

    async def list_services(self, query: str = "") -> list[dict]:
        q = _normalize(query)
        return [
            {**s, "dataOrigin": "fixture"}
            for s in self.data["services"]
            if not q or q in _normalize(s["servNm"]) or _normalize(s["servNm"]) in q
        ]

    async def get_service(self, serv_id: str) -> dict | None:
        s = next((x for x in self.data["services"] if x["servId"] == serv_id), None)
        return {**s, "dataOrigin": "fixture"} if s else None

    async def find_service(self, name: str) -> dict | None:
        return next((s for s in await self.list_services(name) if _normalize(s["servNm"]) == _normalize(name)), None)

    async def get_field_glossary(self, field_id: str) -> dict | None:
        return next((g for g in self.data["fieldGlossary"] if g["fieldId"] == field_id), None)

    async def get_local_service(self, serv_id: str, detail_url: str = "") -> dict | None:
        return None


class OfficialCentralWelfareApiProvider:
    """
    한국사회보장정보원 중앙부처복지서비스 API (https://www.data.go.kr/data/15090532/openapi.do).
    오퍼레이션 경로와 응답 필드는 실제 호출로 확인했다. 실패하면 fixture로 대체하고 그 사실을 남긴다.
    조회 결과는 메모리에 캐시한다(기본 6시간).
    """

    mode = "official-api"

    def __init__(self, api_key: str, base_url: str, fallback: Any, timeout_ms: int = 10_000, cache_ms: int = 6 * 60 * 60 * 1000) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.fallback = fallback
        self.timeout = timeout_ms / 1000
        self.cache_ms = cache_ms
        self._cache: dict[str, tuple[float, Any]] = {}
        # 마지막 실패 사유(진단용). 성공하면 지워진다.
        self.last_error: str | None = None

    async def _get(self, url: str, params: dict[str, str]) -> tuple[int, str]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.get(url, params=params)
            return res.status_code, res.text

    async def fetch_raw(self, call_tp: Literal["L", "D"], serv_id: str | None = None, extra: dict[str, str] | None = None) -> dict:
        # 오퍼레이션별 경로(실제 호출로 확인): 목록 /NationalWelfarelistV001, 상세 /NationalWelfaredetailedV001
        operation = "NationalWelfarelistV001" if call_tp == "L" else "NationalWelfaredetailedV001"
        url = f"{self.base_url.rstrip('/')}/{operation}"
        params: dict[str, str] = {"callTp": call_tp}
        if call_tp == "L":
            # 목록조회 필수값(공공데이터포털 명세)
            params.update({"pageNo": "1", "numOfRows": "10", "srchKeyCode": "001"})
        if serv_id:
            params["servId"] = serv_id
        params.update(extra or {})
        request_url = str(httpx.URL(url, params=params))
        status, body = await self._get(url, {**params, "serviceKey": self.api_key})
        return {"status": status, "body": body, "requestUrl": request_url, "requestedAt": now_iso()}

    async def _cached(self, key: str, load: Callable[[], Awaitable[T]]) -> T:
        hit = self._cache.get(key)
        if hit and time.time() * 1000 - hit[0] < self.cache_ms:
            return hit[1]
        value = await load()
        self._cache[key] = (time.time() * 1000, value)
        return value

    async def _with_fallback(self, work: Callable[[], Awaitable[T]], fallback: Callable[[], Awaitable[T]]) -> T:
        try:
            v = await work()
            self.last_error = None
            return v
        except Exception as e:  # noqa: BLE001
            self.last_error = str(e) or "unknown"
            log.warning("[welfare] 공식 API 실패 → fixture 사용: %s", self.last_error)
            return await fallback()

    def _local_base_url(self) -> str:
        # 지자체복지서비스 API: 같은 기관(B554287)의 LocalGovernmentWelfareInformations (실제 호출로 확인)
        return rx(r"NationalWelfareInformationsV001/?$").sub("LocalGovernmentWelfareInformations", self.base_url)

    async def catalog(self, ctpv: str | None = None) -> list[dict]:
        async def work() -> list[dict]:
            async def load_central() -> list[dict]:
                res = await self.fetch_raw("L", extra={"numOfRows": "500"})
                if res["status"] != 200:
                    raise WelfareApiError(api_error_message(res["body"]), res["status"])
                return parse_service_catalog(res["body"], "central")

            central = await self._cached("C:central", load_central)
            if not ctpv:
                return central

            async def load_local() -> list[dict]:
                params = {"pageNo": "1", "numOfRows": "500", "srchKeyCode": "001", "ctpvNm": ctpv, "serviceKey": self.api_key}
                status, body = await self._get(f"{self._local_base_url()}/LcgvWelfarelist", params)
                if status != 200:
                    raise WelfareApiError(api_error_message(body), status)
                return parse_service_catalog(body, "local")

            local = await self._cached(f"C:local:{ctpv}", load_local)
            return [*central, *local]

        async def fallback() -> list[dict]:
            return fixture_catalog(ctpv)

        return await self._with_fallback(work, fallback)

    async def _list(self, query: str) -> list[dict]:
        async def load() -> list[dict]:
            res = await self.fetch_raw("L", extra={"searchWrd": query} if query else {})
            if res["status"] != 200:
                raise WelfareApiError(api_error_message(res["body"]), res["status"])
            return parse_welfare_list(res["body"])

        return await self._cached(f"L:{query}", load)

    async def _detail(self, serv_id: str, detail_url: str) -> dict:
        async def load() -> dict:
            res = await self.fetch_raw("D", serv_id=serv_id)
            if res["status"] != 200:
                raise WelfareApiError(api_error_message(res["body"]), res["status"])
            return parse_welfare_detail(res["body"], detail_url)

        return await self._cached(f"D:{serv_id}", load)

    async def list_services(self, query: str = "") -> list[dict]:
        return await self._with_fallback(lambda: self._list(query), lambda: self.fallback.list_services(query))

    async def get_service(self, serv_id: str) -> dict | None:
        return await self._with_fallback(lambda: self._detail(serv_id, ""), lambda: self.fallback.get_service(serv_id))

    async def find_service(self, name: str) -> dict | None:
        async def work() -> dict:
            hit = next((s for s in await self._list(name) if _normalize(s["servNm"]) == _normalize(name)), None)
            if not hit:
                raise WelfareApiError(f"'{name}' 서비스를 찾지 못함")
            return await self._detail(hit["servId"], hit["source"]["url"])

        return await self._with_fallback(work, lambda: self.fallback.find_service(name))

    async def get_local_service(self, serv_id: str, detail_url: str = "") -> dict | None:
        async def load() -> dict:
            status, body = await self._get(f"{self._local_base_url()}/LcgvWelfaredetailed", {"servId": serv_id, "serviceKey": self.api_key})
            if status != 200:
                raise WelfareApiError(api_error_message(body), status)
            s = parse_welfare_detail(body, detail_url)
            return {**s, "source": {**s["source"], "title": f"복지로 '{s['servNm']}' (한국사회보장정보원 지자체복지서비스 API)"}}

        try:
            return await self._cached(f"L:{serv_id}", load)
        except Exception:  # noqa: BLE001
            return None

    async def get_field_glossary(self, field_id: str) -> dict | None:
        # 모의 신청서 항목 설명은 fixture 용어집을 쓴다(공식 API에는 해당 정보 없음).
        return await self.fallback.get_field_glossary(field_id)


def create_welfare_data_provider(fixture_path: str | None = None, api_key: str | None = None, api_base_url: str | None = None):
    fixture = FixtureWelfareDataProvider.from_file(fixture_path)
    if api_key and api_base_url:
        return OfficialCentralWelfareApiProvider(api_key=api_key, base_url=api_base_url, fallback=fixture)
    return fixture
