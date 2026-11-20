"""
Agent B의 복지 정보 모듈: 정책 데이터(공식 API 또는 fixture)만 근거로 설명하고 항상 출처·확인일을 붙인다.
화면 텍스트나 사용자 입력을 정책 사실로 섞지 않으며, 수급 자격을 판정하지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from cheongeum.agents.welfare.discovery import (
    Match,
    describe_profile,
    match_services,
    other_district_left_out,
    program_district,
    residence_status,
)
from cheongeum.agents.welfare.open_data import ProgramShelf, ServiceLinkShelf, official_districts
from cheongeum.agents.welfare.rag import chunk_service, retrieve
from cheongeum.core.jsutil import AbortSignal, I, compact, jdumps, rx, today_iso, try_url
from cheongeum.core.region import parse_region_mention, province_name
from cheongeum.core.turn import AGENT_IDS
from cheongeum.safety import check_grounding, unsupported_numbers
from cheongeum.safety.verify import PUBLIC_FACT_LABELS, PublicEvidence, normalize_for_match
from cheongeum.speech.phrasing import speak_date


# 실시간 API가 아닌 저장 fixture·대체 자료에 붙이는 출처 말(C13).
FIXTURE_VERSION = "저장된 자료 기준"


def _is_fixture_version(version: str | None) -> bool:
    v = version or ""
    return v == FIXTURE_VERSION or v.startswith("fixture")


def _catalog_source(*, fixture: bool = False) -> dict:
    return {
        "title": "한국사회보장정보원 복지서비스 목록(중앙부처·지자체)",
        "url": "https://www.data.go.kr/data/15090532/openapi.do",
        "lastCheckedAt": today_iso(),
        "version": FIXTURE_VERSION if fixture else "API 실시간",
    }


def first_sentence(s: str, max_len: int = 60) -> str:
    one = rx(r"(?<=[.。])\s|(?<=니다)\s").split(s)[0]
    one = rx(r"[.。]$").sub("", one)
    return f"{one[:max_len]}…" if len(one) > max_len else one


PRECHECK_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["checks"],
    "properties": {
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["condition", "status", "note"],
                "properties": {
                    "condition": {"type": "string"},
                    "status": {"type": "string", "enum": ["met", "unmet", "unknown"]},
                    "note": {"type": "string"},
                },
            },
        },
    },
}


@dataclass
class GroundedAnswer:
    speech: str
    sources: list[dict] = field(default_factory=list)
    # 검증된 자료(fixture/공식 API)에 근거했는지 여부
    grounded: bool = False
    # 답변에 쓴 서비스(Agent A 인계용)
    service: dict | None = None
    # 답변 방식: 근거 검색+LLM 생성 / 주제 규칙 추출
    method: str | None = None
    # 검색된 근거 조각(평가용)
    retrieval: dict | None = None
    # 검증 담당 결과: 답의 숫자가 근거에 없어서 규칙 답변으로 바꿨다면 그 이유
    verification: dict | None = None
    count: int | None = None
    card: dict | None = None
    review_quotes: tuple[str, ...] = ()


class _RagOutput(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    answerable: bool
    answer: str = Field(max_length=600)
    usedChunkIds: list[str]


RAG_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["answerable", "answer", "usedChunkIds"],
    "properties": {
        "answerable": {"type": "boolean"},
        "answer": {"type": "string"},
        "usedChunkIds": {"type": "array", "items": {"type": "string"}},
    },
}

RAG_SYSTEM = """너는 디지털 기기 이용이 어려운 사람에게 한국 복지 제도를 안내하는 도우미다.
반드시 사용자 메시지의 "근거" 조각에 적힌 내용만으로 답한다. 근거에 없는 내용은 추측하지 말고 answerable=false로 둔다.
개인의 수급 자격을 판정하지 않는다. 금액·나이·날짜는 근거 그대로 쓴다.
질문의 결론부터 말하고, 최대 2문장 100자 안팎의 짧고 쉬운 존댓말로 답한다. 질문과 관련 없는 내용은 덧붙이지 않는다. 괄호 남발을 피한다.
usedChunkIds에는 답에 실제로 쓴 근거 id만 넣는다."""

# 질문 속 복지 제도 이름(예: 기초연금, 주거급여)
SERVICE_NAME = rx(r"([가-힣]{2,12}(?:연금|수당|급여|바우처|지원금|장려금|지원사업|보험료\s*지원))")

# MVP 첫 적용 대상. 질문에 다른 서비스명이 없으면 이것을 찾는다.
DEFAULT_SERVICE = "장애인연금"
ELIGIBILITY_NOTE = "자격은 담당 기관이 최종 판단해요."
_FORM_EXT = rx(r"\.(hwpx?|pdf)$", I)

# "지금 신청할 수 있어?" — 공식 기간·마감이 있을 때만 예/아니오.
_DEADLINE_Q = rx(r"(지금|현재).*(신청|접수).*(할\s*수|가능|돼|되나)|(신청|접수)\s*(기간|마감|기한)")
_AMOUNT_Q = rx(r"(얼마|금액|지급액|연금액|지원액|기준액|몇\s*원|[0-9][0-9,]*\s*(?:만\s*)?원)")
_MONEY = rx(r"\d[\d,.]*\s*(?:(?:[천만억조]|백만|천만)\s*)?원")
_YEAR_ROUND = rx(r"(신청|접수)\s*기간\s*[:：]?\s*연중|연중\s*(신청|접수)")
_DATE_YMD = rx(r"(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?")
_DATE_COMPACT = rx(r"(\d{4})(\d{2})(\d{2})")
_PERIOD_RANGE = rx(
    r"(?:신청|접수)\s*(?:기간|마감|기한)[^0-9]{0,12}"
    r"(?:(\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?|\d{8}))"
    r"\s*(?:[~～\-]|부터)\s*"
    r"(?:(\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?|\d{8}))"
)
_PERIOD_UNTIL = rx(
    r"(?:신청|접수)\s*(?:기간|마감|기한)[^0-9]{0,12}(?:(~|까지)\s*)?"
    r"(\d{4}\s*[.\-/년]\s*\d{1,2}\s*[.\-/월]\s*\d{1,2}\s*일?|\d{8})\s*까지"
)


def is_deadline_question(question: str) -> bool:
    return bool(_DEADLINE_Q.search(question))


def _phone_contact(s: dict) -> dict | None:
    """prepare와 같이, 숫자로 시작하는 문의처 하나."""
    return next((c for c in (s.get("contacts") or []) if rx(r"^\d").search(c["value"])), None)


def _parse_day(raw: str) -> date | None:
    t = (raw or "").strip()
    if not t:
        return None
    if rx(r"^\d{4}-\d{2}-\d{2}").search(t):
        try:
            return date.fromisoformat(t[:10])
        except ValueError:
            return None
    m = _DATE_YMD.fullmatch(t) or _DATE_COMPACT.fullmatch(t)
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def application_period(s: dict, today: str | None = None) -> tuple[str, str, list[str]]:
    """신청·접수에 직접 해당하는 필드와 기간 문구만 읽는다."""
    day = _parse_day(today or today_iso())
    if not day:
        return "unknown", "", []

    start = _parse_day(s.get("enfcBgngYmd") or "")
    end = _parse_day(s.get("enfcEndYmd") or "")
    if start and end and start <= end:
        return ("open" if start <= day <= end else "closed",
                f"시행 기간 {_spoken_date(start.isoformat())}부터 {_spoken_date(end.isoformat())}까지",
                ["enfcBgngYmd", "enfcEndYmd"])

    for field_name, text in (
        ("applyMethod", s.get("applyMethod") or ""),
        ("applySteps", "\n".join(step.get("detail") or "" for step in s.get("applySteps") or [])),
        ("summary", s.get("summary") or ""),
    ):
        if _YEAR_ROUND.search(text):
            return "open", "연중 신청 안내", [field_name]
        ranged = _PERIOD_RANGE.search(text)
        if ranged:
            start, end = _parse_day(ranged[1]), _parse_day(ranged[2])
            if start and end and start <= end:
                return ("open" if start <= day <= end else "closed",
                        f"신청 기간 {speak_date(start.isoformat())}부터 {_spoken_date(end.isoformat())}까지",
                        [field_name])
        until = _PERIOD_UNTIL.search(text)
        if until:
            end = _parse_day(until[2])
            if end:
                return ("open" if day <= end else "closed",
                        f"접수 마감 {_spoken_date(end.isoformat())}", [field_name])
    return "unknown", "", []


def cite(s: dict) -> dict:
    version = s.get("version")
    if _is_fixture_version(version):
        version = FIXTURE_VERSION
    return compact({"title": s["title"], "url": s["url"], "lastCheckedAt": s["lastCheckedAt"], "version": version, "note": s.get("note")})


def source_sentence(s: dict) -> str:
    """말로는 짧게(자세한 링크·확인일은 화면의 근거 자료 목록에 표시)"""
    who = "출처: 복지로" if s["title"].startswith("복지로") else f"출처: {s['title']}"
    version = f"연습용 예시, {FIXTURE_VERSION}" if _is_fixture_version(s.get("version")) else (s.get("version") or "")
    return f"({who}, {version})"


def answer_card(service: dict, answer: str, fields: list[str], *, grounded: bool = True, next_action: str | None = None) -> dict:
    source = service["source"]
    origin = service.get("dataOrigin") or "unknown"
    kind = "private-program" if service.get("provider") == "private" else "live" if origin == "official-api" else "stored"
    date_hint = source.get("version") or ""
    data_date = service.get("referenceDate") or (f"{service['criteriaYear']}년" if service.get("criteriaYear") else None)
    if not data_date:
        match = rx(r"^(\d{4}(?:-\d{2}-\d{2}|년))\s*기준").search(date_hint)
        data_date = match.group(1) if match else None
    contact = _phone_contact(service)
    if not next_action:
        next_action = "출처에서 해당 제도의 자세한 내용을 확인해 주세요." if grounded else (
            f"{contact['name']} {contact['value']}에 문의해 주세요." if contact else
            "보건복지상담센터 129에 문의해 주세요."
        )
    return compact({
        "answer": answer, "serviceId": service["servId"], "serviceName": service["servNm"],
        "fields": list(dict.fromkeys(fields)), "grounded": grounded, "source": cite(source),
        "dataKind": kind, "dataOrigin": origin, "dataDate": data_date, "nextAction": next_action,
    })


def _spoken_date(value: str) -> str:
    match = rx(r"^(\d{4})-\d{2}-\d{2}$").fullmatch(value)
    return f"{match[1]}년 {speak_date(value)}" if match else value


def speak_answer_card(card: dict, lang: str = "ko") -> str:
    source = card["source"]
    kind = card["dataKind"]
    data_date = card.get("dataDate")
    checked = source["lastCheckedAt"]
    title = source["title"]
    if lang == "ko":
        stored = f"연습용 예시, {FIXTURE_VERSION}" if card.get("dataOrigin") == "fixture" else FIXTURE_VERSION
        labels = {"live": "공식 API 실시간 조회", "stored": stored, "private-program": "공공데이터에 실린 민간 사업"}
        reference = _spoken_date(data_date) if data_date else "기준일 미기재"
        metadata = f"출처는 {title}이며, {labels[kind]}입니다. 자료 기준은 {reference}. 확인일은 {_spoken_date(checked)}입니다."
    else:
        labels, source_label, date_label, checked_label, missing = {
            "en": (("Live official API", "Stored source", "Private program in public data"), "Source", "Data date", "Checked", "Unspecified"),
            "zh": (("官方接口实时数据", "存档资料", "公共数据中的民间项目"), "来源", "数据日期", "核对日期", "未注明"),
            "ja": (("公式APIの最新照会", "保存資料", "公開データ掲載の民間事業"), "出典", "資料の基準日", "確認日", "記載なし"),
        }[lang]
        label = labels[("live", "stored", "private-program").index(kind)]
        if card.get("dataOrigin") == "fixture":
            label = {"en": "Practice example", "zh": "练习示例", "ja": "練習用の例"}[lang]
        metadata = f"{source_label} {title}. {label}. {date_label} {data_date or missing}. {checked_label} {checked}."
    answer = card["answer"]
    if answer[-1:] not in ".!?。！？":
        answer += "."
    return f"{answer} {metadata} {card['nextAction']}"


def eligibility_note(q: str) -> str:
    """자격 안내는 자격·대상을 물었을 때만 덧붙인다."""
    return f" {ELIGIBILITY_NOTE}" if rx(r"(대상|자격|받을\s*수|해당|되나요|돼\?)").search(q) else ""


def lines(text: str | None, n: int, max_chars: int = 220) -> str:
    """긴 공식 문구를 음성으로 듣기 좋게 앞부분 몇 줄만."""
    ls = [line.strip() for line in (text or "").split("\n") if line.strip()][:n]
    return " ".join(f"{line[:max_chars]}…" if len(line) > max_chars else line for line in ls)


def _service_ref(s: dict) -> dict:
    return {"servId": s["servId"], "servNm": s["servNm"], "dataOrigin": s["dataOrigin"]}


_ASK_SERVICE = GroundedAnswer(
    speech="어떤 제도에 대해 궁금하신가요? 예를 들어 기초연금, 주거급여, 아동수당처럼 제도 이름을 말씀해 주세요.",
    sources=[],
    grounded=False,
    method="none",
)

# met은 사용자가 말한 대로일 때만 맞다는 뜻이다(장애 정도·소득 수준은 공식 판정이 아님).
_WORD = {"met": "말씀하신 대로면 맞아요", "unmet": "맞지 않을 수 있어요", "unknown": "확인이 필요해요"}
_RESIDENCE = rx(r"(거주|주민등록|주소|관내)")
# '1년 이상 거주'·'전입 후 6개월' 같은 기간 조건. 맞춤 찾기에서 묻지 않으므로 사용자가 말한 적이 없다('2026년 기준'은 아님).
_DURATION = rx(r"\d+\s*(?:개월|년|일)\s*(?:이상|이내|미만|넘|동안|경과|지난|지나)|전입|거주\s*기간|계속\s*거주")
_GUIDE_CUE = rx(
    r"^(.+?)(?:의|은|는|을|를|이|가|에\s*대한|에서)?\s*"
    r"(?:신청\s*(?:방법|절차|하는\s*법|서류|서식|양식|기간|기한|대상|자격|조건|사이트|홈페이지|안내)"
    r"|(?:어떻게|어디(?:서|에서)?)\s*신청"
    r"|지원\s*(?:대상|내용|금액|조건|기준|기간|방법)"
    r"|선정\s*기준"
    r"|제출\s*서류|구비\s*서류|준비\s*서류|필요한?\s*서류|서류|서식|양식|신청서"
    r"|문의처?|전화번호|연락처"
    r"|(?:관련|공식)\s*(?:사이트|홈페이지|누리집|안내)"
    r"|홈페이지|누리집"
    r"|얼마|자격|대상|혜택|기간|마감|기한|안내|알려|찾아|확인해|보여)"
)
_SITE_REQUEST_CUE = rx(r"(?:관련|공식)?\s*(?:사이트|홈페이지|누리집)")
_FORM_REQUEST_CUE = rx(r"(?:서식|양식|신청서|다운로드|첨부)")


def _norm_key(text: str) -> str:
    return "".join(text.split()).casefold()


def _verified_bokjiro_url(raw_url: str | None, serv_id: str | None) -> str | None:
    url = try_url(raw_url or "")
    if not url or url.origin not in ("https://www.bokjiro.go.kr", "https://bokjiro.go.kr"):
        return None
    if not serv_id or url.param("wlfareInfoId") != serv_id:
        return None
    return url.href


def _verified_public_url(raw_url: str | None) -> str | None:
    text = (raw_url or "").strip()
    if not text:
        return None
    parts = urlsplit(text)
    url = try_url(text)
    if (not url or url.protocol not in ("http:", "https:") or not url.hostname or "." not in url.hostname
            or url.hostname in ("localhost", "127.0.0.1") or parts.username or parts.password):
        return None
    return url.href


def _resolve_region_hints(text: str, ctpv: str | None = None, sgg: str | None = None) -> tuple[str | None, str | None]:
    mention = parse_region_mention(text)
    province = mention.province or ctpv or None
    district = mention.districts[0] if mention.districts else (None if (mention.province and mention.province != ctpv) else (sgg or None))
    if district and not province:
        homes = official_districts().get(district, ())
        provinces = {p for p, _ in homes}
        if len(provinces) == 1:
            province = next(iter(provinces))
    return province, district


def _strip_region_prefix(name: str) -> str:
    tokens = name.strip().split()
    idx = 0
    while idx < len(tokens) - 1:
        tok = rx(r"(?:의|에서|에)$").sub("", tokens[idx].strip(".,!?"))
        if province_name(tok) or (tok.endswith(("시", "군", "구")) and tok in official_districts()):
            idx += 1
            continue
        break
    return " ".join(tokens[idx:]).strip() if idx else name.strip()


def _merge_direct_links(entries: list[dict]) -> list[dict]:
    merged: list[dict] = []
    seen: dict[str, int] = {}
    for entry in entries:
        url = _verified_public_url(entry.get("url"))
        if not url:
            continue
        parsed = try_url(url)
        host = parsed.hostname.removeprefix("www.") if parsed else ""
        path = "" if (parsed and parsed.pathname == "/") else (parsed.pathname.rstrip("/") if parsed else "")
        key = f"{host}{path}{parsed.search if parsed else ''}".casefold()
        if key in seen:
            if entry.get("name") and not merged[seen[key]]["name"]:
                merged[seen[key]]["name"] = entry["name"]
            continue
        seen[key] = len(merged)
        merged.append({"name": entry.get("name") or "", "url": url, "sourceId": entry.get("sourceId") or ""})
    return merged


def _detail_links(detail: dict, source_id: str) -> tuple[list[dict], list[dict]]:
    sites: list[dict] = []
    for item in detail.get("relatedSites") or []:
        if isinstance(item, dict) and (url := _verified_public_url(item.get("url"))):
            sites.append({"name": (item.get("name") or "").strip(), "url": url, "sourceId": source_id})
    if not sites:
        for item in detail.get("contacts") or []:
            if isinstance(item, dict) and (url := _verified_public_url(item.get("value"))):
                sites.append({"name": (item.get("name") or "").strip(), "url": url, "sourceId": source_id})
    forms = [
        {"name": (item.get("name") or "").strip(), "url": url, "sourceId": source_id}
        for item in (detail.get("forms") or [])
        if isinstance(item, dict) and (url := _verified_public_url(item.get("url")))
    ]
    return sites, forms


def _pick_related_site(sites: list[dict], query: str) -> dict | None:
    if not sites:
        return None
    if len(sites) == 1:
        return sites[0]
    q = _norm_key(query)
    named = [s for s in sites if s.get("name") and len(_norm_key(s["name"])) >= 2 and _norm_key(s["name"]) in q]
    if len(named) == 1:
        return named[0]
    primary = [s for s in sites if "129.go.kr" not in s["url"].casefold()]
    if len(primary) == 1:
        return primary[0]
    return None


class WelfareInformationAgent:
    id = AGENT_IDS.welfare

    def __init__(
        self,
        provider: Any,
        llm: Any = None,
        *,
        shelf: ProgramShelf | None = None,
        links: ServiceLinkShelf | None = None,
    ) -> None:
        self.provider = provider
        self.llm = llm
        self._shelf = shelf
        self._links = links
        # 직전에 이야기한 제도(“그럼 신청은 어디서 해?” 같은 이어지는 질문용)
        self._last_service: dict | None = None
        # 맞춤 복지 찾기
        self._matches: list[Match] = []
        self._shown = 0
        self._list_hinted = False
        self._left_out_told = False
        # 사용자가 고른 찾기 결과(목록 요약)
        self._picked: dict | None = None

    def _list_source(self) -> dict:
        """목록·찾기 출처. fixture이거나 API 실패 대체면 실시간 API라고 말하지 않는다(C13)."""
        fixture = getattr(self.provider, "mode", None) == "fixture" or bool(getattr(self.provider, "last_error", None))
        return _catalog_source(fixture=fixture)

    @property
    def last_service(self) -> dict | None:
        """직전에 이야기한 제도 상세(문의처 등). 없으면 None."""
        return self._last_service

    @property
    def current_service_name(self) -> str | None:
        """지금 대화의 기준 제도(없으면 None)"""
        if self._last_service:
            return self._last_service["servNm"]
        return self._picked["servNm"] if self._picked else None

    @property
    def current_is_private(self) -> bool:
        return (self._last_service or self._picked or {}).get("provider") == "private"

    def refers_to_selection(self, text: str) -> bool:
        """신청 명령이 고른 사업의 이름·번호를 말하거나 '그거 신청해줘'처럼 이어지는지 본다."""
        selected = self._picked
        if not selected:
            return False
        if self.find_in_matches(text) is selected:
            return True
        before_apply = text.partition("신청")[0].strip()
        return (
            rx(r"(?:그거|이거|그걸|이걸|그\s*(?:사업|제도)|이\s*(?:사업|제도))?(?:를|을)?").fullmatch(before_apply) is not None
            or (len(before_apply) >= 2 and before_apply in selected["servNm"])
        )

    @property
    def current_service_url(self) -> str | None:
        """지금 제도의 공식 상세 페이지(복지로) — Agent A가 열어 준다"""
        if self._picked and self._picked.get("detailUrl"):
            return self._picked["detailUrl"]
        if self._last_service and "bokjiro" in self._last_service["source"]["url"]:
            return self._last_service["source"]["url"]
        if self._last_service and self._links:
            hit = self._links.by_id(self._last_service.get("servId") or "") or self._links.by_name(self._last_service.get("servNm") or "")
            if hit:
                return _verified_bokjiro_url(hit.detail_url, hit.serv_id)
        return None

    @property
    def has_matches(self) -> bool:
        return bool(self._matches)

    def _list_speech(self, frm: int) -> str:
        page = self._matches[frm : frm + 3]
        self._shown = frm + len(page)
        # 목록은 이름만 짧게(듣고 고르기 쉽게). 설명은 번호를 말하면 그때.
        def label(entry: dict) -> str:
            private = "민간 사업 " if entry.get("provider") == "private" else ""
            area = program_district(entry)
            where = f"{area} " if area and area not in entry["servNm"] else ""
            return private + where + entry["servNm"]

        items = ", ".join(f"{frm + i + 1}번 {label(m.service)}" for i, m in enumerate(page))
        private = next((m.service for m in page if m.service.get("provider") == "private"), None)
        if private:
            items += " " + source_sentence(private["source"])
        more = " 더 들으려면 '더 알려줘'." if len(self._matches) > self._shown else ""
        hint = "" if self._list_hinted else " 번호를 말씀하시면 자세히 알려 드려요. 예: '1번 자세히', '1번 자격 확인해줘'."
        self._list_hinted = True
        return f"{items}이에요.{more}{hint}"

    def _page_sources(self, start: int) -> list[dict]:
        sources = []
        for match in self._matches[start:start + 3]:
            source = match.service.get("source") or self._list_source()
            if source not in sources:
                sources.append(source)
        return sources

    async def discover(self, profile: dict) -> GroundedAnswer:
        """프로필로 받을 수 있을 법한 제도를 찾는다(자격 판정 아님)."""
        catalog = await self.provider.catalog(profile.get("ctpv") or None)
        if self._shelf:
            catalog = [*catalog, *self._shelf.entries(today_iso())]
        self._matches = match_services(catalog, profile)
        self._picked = None
        self._shown = 0
        if not self._matches:
            return GroundedAnswer(
                speech="말씀하신 조건에 맞는 제도를 찾지 못했어요. 조건을 바꿔 말씀하시거나 보건복지상담센터 129에 문의해 보세요.",
                sources=[self._list_source()],
                grounded=False,
                count=0,
                method="topic-rule",
            )
        n = len(self._matches)
        left_out = ""
        if not self._left_out_told and other_district_left_out(catalog, profile):
            self._left_out_told = True
            left_out = " 다른 시·군·구 사업은 뺐어요."
        return GroundedAnswer(
            speech=f"받을 수 있을 법한 제도를 {'여러 개' if n > 10 else f'{n}개'} 찾았어요.{left_out} 관련 높은 순서로 {self._list_speech(0)} 실제로 받을 수 있는지는 기관이 판단해요.",
            sources=self._page_sources(0),
            grounded=True,
            count=n,
            method="topic-rule",
        )

    def more_matches(self) -> GroundedAnswer:
        if not self._matches:
            return GroundedAnswer(speech="아직 찾은 제도가 없어요. '받을 수 있는 복지 찾아줘'라고 해 보세요.")
        if self._shown >= len(self._matches):
            return GroundedAnswer(speech="찾은 제도를 모두 알려드렸어요.", sources=self._page_sources((self._shown - 1) // 3 * 3), grounded=True)
        start = self._shown
        return GroundedAnswer(speech=self._list_speech(start), sources=self._page_sources(start), grounded=True)

    def pick(self, ref: str | None) -> dict | None:
        """
        "1번", "첫 번째", "장애인연금", "기장군 교통비 지원"(일부·받아쓰기 오타 포함) → 찾기 결과에서 고르기.
        고르면 그 제도가 대화의 기준 제도가 된다.
        """
        if not ref:
            return self._picked
        hit = self.find_in_matches(ref)
        if hit:
            self._picked = hit
            if hit.get("source"):
                self._last_service = hit
            elif (self._last_service or {}).get("servId") != hit["servId"]:
                self._last_service = None
        return hit

    def find_in_matches(self, ref: str) -> dict | None:
        """찾기 결과 목록에서 말한 것 찾기(고르지는 않음)"""
        if not self._matches:
            return None
        ordinal = {"첫": 1, "두": 2, "세": 3, "네": 4, "다섯": 5}
        n = rx(r"(\d{1,2})\s*번").search(ref) or rx(r"(첫|두|세|네|다섯)\s*번\s*째").search(ref)
        if n:
            g = n.group(1)
            idx = (int(g) if g.isdigit() else ordinal[g]) - 1
            return self._matches[idx].service if 0 <= idx < len(self._matches) else None
        r = rx(r"\s").sub("", ref)
        exact = next((m.service for m in self._matches if rx(r"\s").sub("", m.service["servNm"]) in r), None)
        if exact:
            return exact

        # 이름 일부만 말하거나 받아쓰기 오타가 있어도: 말한 글의 2-gram이 제도 이름에 많이 들어 있으면 그 제도
        def grams(s: str) -> set[str]:
            return {s[i : i + 2] for i in range(max(0, len(s) - 1)) if rx(r"[가-힣]{2}").search(s[i : i + 2])}

        said = grams(rx(r"(신청|해줘|하고\s*싶|도와|알려|자세히|너가|네가|찾은|그거|그|이|저)").sub("", r))
        if len(said) < 3:
            return None
        best: tuple[dict, float] | None = None
        for m in self._matches:
            name = grams(rx(r"\s").sub("", m.service["servNm"]))
            shared = len([g for g in said if g in name])
            score = shared / len(said)
            if score >= 0.5 and shared >= 3 and (best is None or score > best[1]):
                best = (m.service, score)
        return best[0] if best else None

    async def _detail_of(self, s: dict | None, name: str | None = None) -> dict | None:
        if s and s.get("source"):
            return s
        if s and s.get("provider") == "central":
            return (await self.provider.get_service(s["servId"])) or (await self.provider.find_service(s["servNm"]))
        if s and s.get("provider") == "local":
            fn = getattr(self.provider, "get_local_service", None)
            return await fn(s["servId"], s.get("detailUrl") or "") if fn else None
        if name:
            return await self.provider.find_service(name)
        return None

    def _picked_source(self, s: dict) -> dict:
        if s.get("source"):
            return cite(s["source"])
        base = self._list_source()
        return {**base, "url": s.get("detailUrl") or base["url"], "title": f"복지로 '{s['servNm']}'"}

    async def service_detail(self, ref: str | None) -> GroundedAnswer:
        s = self.pick(ref)
        if not s:
            return GroundedAnswer(speech="어떤 제도인지 알려 주세요. 예: '1번 자세히'.")
        if s.get("provider") == "private":
            details = f"{s['organization']}의 민간 사업 {s['servNm']}의 지원 대상은 {lines(s.get('target') or s['summary'], 1, 600)}"
            return GroundedAnswer(
                speech=f"{details}. {source_sentence(s['source'])}",
                sources=[cite(s["source"])], grounded=True, service=_service_ref(s),
                card=answer_card(s, details, ["target" if s.get("target") else "summary"]),
            )
        region = s.get("region") or {}
        where = f"{region.get('sgg') or region.get('ctpv')} 지역 제도예요. " if s.get("provider") == "local" else ""
        targets = f"대상은 {', '.join(s['targets'])}이에요. " if s["targets"] else ""
        return GroundedAnswer(
            speech=f"{s['servNm']}. {where}{first_sentence(s['summary'], 120)}. {targets}자격을 살펴보려면 '자격 확인해줘', 신청 준비는 '신청하려면 뭐가 필요해?'라고 해 주세요.",
            sources=[self._picked_source(s)],
            grounded=True,
        )

    async def precheck(self, ref: str | None, profile: dict) -> GroundedAnswer:
        """
        자격 미리 점검: 공식 선정기준과 사용자 답을 비교해 조건별로 "맞아요/확인 필요/안 맞을 수 있어요".
        최종 판정은 하지 않는다. LLM이 없으면 나이 기준만 규칙으로 비교한다.
        """
        s = self.pick(ref)
        name = (s["servNm"] if s else None) or ref or self.current_service_name
        detail = await self._detail_of(s, name)
        if not name or (not s and not detail):
            return GroundedAnswer(speech="어떤 제도의 자격을 살펴볼까요? 예: '1번 자격 확인해줘'.")
        if detail:
            self._last_service = detail
        # 한 시·군·구 사업이면 목록의 지역(sggNm)과 사는 곳을 규칙으로 비교해 늘 먼저 말한다(LLM이 빠뜨려도).
        area = program_district(s) if s else ""
        residence = {"condition": f"{area} 거주", "status": residence_status(s, profile), "note": ""} if area else None
        criteria = f"{detail['target']}\n{detail.get('criteria') or ''}".strip() if detail else ""
        if not criteria:
            # 선정기준 원문이 없으면 추측으로 비교하지 않는다.
            where = f"{residence['condition']}: {_WORD[residence['status']]}. " if residence else ""
            targets = f"목록상 대상은 {', '.join(s['targets'])}이에요. " if s and s["targets"] else ""
            return GroundedAnswer(
                speech=f"{name}의 자세한 선정기준을 공식 자료에서 가져오지 못했어요. {where}{targets}정확한 자격은 담당 기관에 확인해 주세요. 복지로 상세 페이지를 열어 드릴까요?",
                sources=[self._picked_source(s)] if s and s.get("detailUrl") else [self._list_source()],
                grounded=False,
            )
        who = describe_profile(profile) or "알려 주신 정보 없음"
        checks: list[dict] = []
        if self.llm:
            out = await self.llm.generate(
                system=(
                    "복지 제도의 공식 대상·선정기준에서 중요한 조건을 최대 3개 고르고 사용자 정보와 비교한다. "
                    "사용자가 밝힌 정보로 충족을 확인하면 status는 met, 기준과 어긋남을 확인하면 unmet, 정보가 없거나 판단하기 어려우면 unknown으로 둔다. "
                    "condition에는 기준 원문에서 조건을 나타내는 15자 이내의 한국어 명사구를 그대로 옮긴다. note는 한 문장으로 작성한다. 최종 수급 자격을 단정하지 않는다."
                ),
                user=jdumps({"제도": name, "기준": criteria[:2500], "사용자": {**profile, "설명": who}}),
                schemaName="precheck",
                schema=PRECHECK_SCHEMA,
            )
            raw_checks = (out or {}).get("checks") if isinstance(out, dict) else None
            normalized_criteria = normalize_for_match(criteria)
            checks = [{**c, "status": "unknown"} if _DURATION.search(c["condition"]) else c
                      for c in (raw_checks or []) if isinstance(c, dict) and isinstance(c.get("condition"), str)
                      and len(normalize_for_match(c["condition"])) >= 3
                      and normalize_for_match(c["condition"]) in normalized_criteria
                      and c.get("status") in _WORD][:3]
        if not checks:
            m = rx(r"(\d{1,3})\s*세\s*이상").search(criteria)
            if m and profile.get("age") is not None and profile["age"] >= 0:
                checks.append({"condition": f"{m.group(1)}세 이상", "status": "met" if profile["age"] >= int(m.group(1)) else "unmet", "note": ""})
            if rx(r"장애").search(criteria):
                checks.append({"condition": "장애 기준", "status": "met" if profile.get("disability") == "severe" else "unknown", "note": ""})
            if rx(r"소득|재산").search(criteria):
                checks.append({"condition": "소득·재산 기준", "status": "met" if profile.get("income") == "basic" else "unknown", "note": ""})
        if residence:
            # 같은 거주 조건을 되풀이한 점검만 뺀다. 거주 기간('1년 이상 거주', '전입 후 6개월')은 따로 확인할 조건이다.
            checks = [residence, *[c for c in checks if _DURATION.search(c["condition"])
                                   or not (area in c["condition"] or _RESIDENCE.search(c["condition"]))]][:3]
        body = ". ".join(f"{rx(r'[.。]$').sub('', c['condition'])}: {_WORD[c['status']]}" for c in checks)
        if profile.get("disability") in ("severe", "mild") and any(c["status"] == "met" and "장애" in c["condition"] for c in checks):
            body += ". 장애 정도는 말씀하신 내용이라 공식 판정과 다를 수 있어요"
        return GroundedAnswer(
            speech=f"{name} 자격을 미리 살펴봤어요. {body or '기준과 비교할 정보가 부족해요'}. 최종 자격은 기관이 판단해요. 신청 준비가 궁금하면 '신청하려면 뭐가 필요해?'라고 해 주세요.",
            sources=[cite(detail["source"])] if detail else [self._list_source()],
            grounded=bool(detail),
            service=_service_ref(detail) if detail else None,
            method="rag-llm" if self.llm else "topic-rule",
            card=answer_card(detail, f"{name} 사전 확인 결과는 {body or '추가 확인이 필요해요'}. {ELIGIBILITY_NOTE}",
                             ["target", "criteria"], next_action="담당 기관에서 최종 자격을 확인해 주세요.") if detail else None,
        )

    async def prepare(self, ref: str | None) -> GroundedAnswer:
        """신청 준비: 신청 경로·서식·문의처를 짧게. 자세한 건 Agent A가 공식 페이지를 열어 준다."""
        s = self.pick(ref)
        name = (s["servNm"] if s else None) or ref or self.current_service_name
        detail = await self._detail_of(s, name)
        if not detail:
            return GroundedAnswer(
                speech=(
                    f"{name}의 신청 서류는 공식 상세 페이지에서 확인해야 해요. '신청 페이지 열어줘'라고 하시면 열어 드릴게요."
                    if name
                    else "어떤 제도의 신청을 준비할까요?"
                ),
                sources=[self._picked_source(s)] if s and s.get("detailUrl") else [],
                grounded=False,
            )
        self._last_service = detail
        if detail.get("provider") == "private":
            how = lines(detail.get("applyMethod"), 2) or "자료에 신청 방법이 없어요"
            documents = lines(detail.get("documents"), 2) or "자료에 제출서류 안내가 없어요"
            return GroundedAnswer(
                speech=f"민간 사업 {name} 신청 방법은 {how}. 제출서류 안내는 {documents} {source_sentence(detail['source'])}.",
                sources=[cite(detail["source"])], grounded=True, service=_service_ref(detail),
                card=answer_card(detail, f"민간 사업 {name}의 제출서류 안내는 {documents}.", ["documents"] if detail.get("documents") else [],
                                 grounded=bool(detail.get("documents")),
                                 next_action=f"신청 방법은 {how}입니다." if detail.get("applyMethod") else None),
            )
        steps = detail.get("applySteps") or []
        how = steps[0]["detail"] if steps else detail["applyMethod"]
        forms = [
            rx(r"^[★\s]+").sub("", _FORM_EXT.sub("", f["name"]))
            for f in (detail.get("forms") or [])
        ]
        forms = [f for f in forms if not rx(r"사업안내").search(f)]
        contact = next((c for c in (detail.get("contacts") or []) if rx(r"^\d").search(c["value"])), None)
        # 복지로 '서식/자료'에는 신청서 말고 조례·안내문도 올라온다. 필요한 서식이라고 단정하지 않는다.
        forms_part = f" 서식·자료로 {', '.join(forms[:3])} 등이 올라와 있어요." if forms else ""
        contact_part = f" 문의는 {contact['name']} {contact['value']}." if contact else ""
        sources = [cite(detail["source"])]
        base_source = sources[0]
        api_id = "15108347" if "지자체" in base_source["title"] else "15090532"
        api_sites, api_forms = _detail_links(detail, api_id)
        csv_row = self._links.by_id(detail.get("servId") or "") if self._links else None
        csv_sites = (
            [{"name": site.name, "url": u, "sourceId": "15083323"} for site in csv_row.sites if (u := _verified_public_url(site.url))]
            if csv_row
            else []
        )
        seen_urls = {base_source["url"].casefold().rstrip("/")}
        for site in _merge_direct_links([*api_sites, *csv_sites])[:2]:
            key = site["url"].casefold().rstrip("/")
            if key not in seen_urls:
                seen_urls.add(key)
                sources.append(compact({
                    "title": site["name"] or f"{detail['servNm']} 관련 사이트",
                    "url": site["url"],
                    "lastCheckedAt": base_source["lastCheckedAt"],
                    "version": base_source.get("version"),
                    "note": "관련 사이트",
                }))
        for form in _merge_direct_links(api_forms)[:3]:
            key = form["url"].casefold().rstrip("/")
            if key not in seen_urls:
                seen_urls.add(key)
                sources.append(compact({
                    "title": rx(r"^[★\s]+").sub("", form["name"]) or f"{detail['servNm']} 서식",
                    "url": form["url"],
                    "lastCheckedAt": base_source["lastCheckedAt"],
                    "version": base_source.get("version"),
                    "note": "공식 서식 다운로드",
                }))
        return GroundedAnswer(
            speech=f"{detail['servNm']} 신청은 {first_sentence(how, 80)}에서 해요.{forms_part}{contact_part} 복지로 상세 페이지를 열어 드릴까요?",
            sources=sources,
            grounded=True,
            service=_service_ref(detail),
            card=answer_card(detail, f"{detail['servNm']} 신청은 {how}.{forms_part}{contact_part}",
                             [("applySteps" if steps else "applyMethod"), *(["forms"] if forms else []),
                              *(["contacts"] if contact else [])]),
        )

    @property
    def answer_mode(self) -> str:
        return "rag-llm" if self.llm else "topic-rule"

    @property
    def data_mode(self) -> str:
        return self.provider.mode

    async def explain_field(self, field_id: str, label: str) -> GroundedAnswer:
        entry = await self.provider.get_field_glossary(field_id)
        if not entry:
            return GroundedAnswer(
                speech=f"'{label}' 항목에 대한 검증된 설명 자료가 아직 없습니다. 추측해서 설명하지 않겠습니다. 담당 기관에 문의해 주세요.",
            )
        return GroundedAnswer(
            speech=f"'{entry['term']}' 항목 설명입니다. {entry['explanation']} {source_sentence(entry['source'])}",
            sources=[cite(entry["source"])],
            grounded=True,
        )

    async def select_service(self, text: str, *, ctpv: str | None = None, sgg: str | None = None) -> str | None:
        """말에 제도 이름이 있으면 공식 자료(API·지자체 목록·중앙 CSV)에서 찾아 대화의 기준 제도로 삼는다."""
        if SERVICE_NAME.search(rx(r"\s+").sub("", text)):
            s = await self._service(text)
            if s:
                self._last_service = s
                self._picked = None
                return s["servNm"]
        province, district = _resolve_region_hints(text, ctpv, sgg)
        cleaned = rx(r"(?:공식\s*(?:안내|페이지|화면|자료|누리집|사이트)?|상세\s*페이지|열어|보여|띄워|줘|주세요|좀)").sub(" ", text).strip()
        bundle = await self.direct_links(cleaned, ctpv=province, sgg=district)
        if not bundle and self._links:
            hit = self._links.match_in_text(cleaned)
            if hit:
                bundle = await self.direct_links(hit.name, ctpv=province, sgg=district)
        if not bundle or not bundle.get("detailUrl"):
            return None
        self._picked = {
            "servId": bundle["servId"],
            "servNm": bundle["servNm"],
            "detailUrl": bundle["detailUrl"],
            "provider": "local" if "15108347" in bundle["sourceIds"] else "central",
        }
        if (self._last_service or {}).get("servId") != bundle["servId"]:
            self._last_service = None
        return bundle["servNm"]

    async def _service(self, question: str) -> dict | None:
        """질문에서 제도 이름을 찾고, 없으면 직전 제도 → 기본(장애인연금) 순서."""
        m = SERVICE_NAME.search(rx(r"\s+").sub("", question))
        if m:
            named = m.group(1)
            exact = await self.provider.find_service(named)
            if exact:
                return exact
            listed = await self.provider.list_services(named)
            matches = [row for row in listed if rx(r"\s").sub("", row["servNm"]) == named]
            if len(matches) == 1:
                row = matches[0]
                detail = await self.provider.get_service(row["servId"])
                return detail if detail and detail["servId"] == row["servId"] else row
            return None
        # 제도 이름도, 이전 대화의 제도도 없으면 특정 제도를 가정하지 않는다(호출자가 되묻는다).
        return self._last_service

    def _deadline_answer(self, s: dict, today: str | None = None) -> GroundedAnswer:
        """신청 기간이 공식 자료에 있을 때만 예/아니오. 없으면 확인 못 함 + prepare와 같은 문의처."""
        status, period, fields = application_period(s, today)
        contact = _phone_contact(s)
        contact_part = f" 문의는 {contact['name']} {contact['value']}." if contact else ""
        if status == "open":
            answer = f"{s['servNm']}은 자료에 적힌 {period} 기준으로 지금 신청할 수 있어요."
        elif status == "closed":
            answer = f"{s['servNm']}은 자료에 적힌 {period} 기준으로 지금 신청할 수 없어요."
        else:
            answer = f"{s['servNm']}을 지금 신청할 수 있는지는 공식 자료에서 확인하지 못했어요."
        return GroundedAnswer(
            speech=f"{answer}{contact_part} {source_sentence(s['source'])}",
            sources=[cite(s["source"])],
            grounded=status != "unknown",
            card=answer_card(s, answer, fields, grounded=status != "unknown"),
            method="topic-rule",
            service=_service_ref(s),
        )

    async def answer_question(self, question: str, today: str | None = None) -> GroundedAnswer:
        """
        자유 질문(티키타카): 공식 데이터를 근거 조각으로 나눠 검색하고, LLM이 근거 안에서만 답한다.
        LLM이 없거나 실패하면 주제 규칙(answer_policy_question)으로 답한다.
        """
        named = bool(SERVICE_NAME.search(rx(r"\s+").sub("", question)))
        if not named and not self._last_service:
            return replace(_ASK_SERVICE)
        s = await self._service(question)
        if not s:
            return GroundedAnswer(speech="그 제도의 공식 자료를 찾지 못했어요. 보건복지상담센터 129에 문의해 보세요.", method="none")
        self._last_service = s
        # 신청 기간은 LLM이 지어내지 못하게 규칙만(공식 기간·마감이 있을 때만 예/아니오).
        if is_deadline_question(question):
            return self._deadline_answer(s, today)
        if not self.llm or _AMOUNT_Q.search(question):
            return self._topic_answer(s, question)

        top = retrieve(question, chunk_service(s), 3)
        raw = await self.llm.generate(
            system=RAG_SYSTEM,
            user=jdumps(
                {
                    "question": question,
                    "제도": s["servNm"],
                    "기준": s["source"]["version"],
                    "근거": [{"id": c["id"], "항목": c["section"], "내용": c["text"]} for c in top],
                }
            ),
            schemaName="grounded_answer",
            schema=RAG_JSON_SCHEMA,
        )
        try:
            parsed: _RagOutput | None = _RagOutput.model_validate(raw)
        except (ValidationError, TypeError):
            parsed = None
        ids = {c["id"] for c in top}
        used = list(dict.fromkeys(i for i in parsed.usedChunkIds if i in ids)) if parsed else []
        retrieval = {"chunkIds": [c["id"] for c in top], "sections": [c["section"] for c in top], "used": used}
        # 형식 오류이거나, 답했다면서 근거를 하나도 대지 못하면 믿지 않고 규칙 답변으로 대체한다.
        if parsed is None or (parsed.answerable and not used):
            return replace(self._topic_answer(s, question), retrieval=retrieval)
        if parsed.answerable:
            cited = [c for c in top if c["id"] in used]
            evidence = [c["text"] for c in cited]
            check = check_grounding(answer=parsed.answer, sources=evidence, min_quotes=0)
            # 숫자·단위·조건을 함께 보존하려고 실제 인용한 항목의 원문만 답으로 쓴다.
            passage = normalize_for_match(parsed.answer)
            if not check.ok or not passage or not any(passage in normalize_for_match(text) for text in evidence):
                reasons = check.reasons or ["답과 일치하는 문장이 인용 항목에 없음"]
                return replace(self._topic_answer(s, question), retrieval=retrieval, verification={"ok": False, "reasons": reasons})
        if not parsed.answerable:
            # 공식 자료에 없을 때: 일반적으로 알려진 내용이 확실하면 '공식 자료 아님'을 밝히고 짧게 알려 준다.
            general = await self.llm.generate(
                system="사용자의 복지 질문에 대한 답이 공식 자료에 없었다. 일반적으로 널리 알려진 사실이 확실할 때만 known=true로 1~2문장 쉬운 존댓말 답을 써라. 확실하지 않거나 개인마다 다르면 known=false. 수급 자격은 판정하지 말 것.",
                user=jdumps({"question": question, "제도": s["servNm"]}),
                schemaName="general_answer",
                schema={
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["known", "answer"],
                    "properties": {"known": {"type": "boolean"}, "answer": {"type": "string"}},
                },
            )
            g = general if isinstance(general, dict) else {}
            said = g["answer"].strip() if g.get("known") and isinstance(g.get("answer"), str) else ""
            # 근거 없는 답의 숫자는 확인할 길이 없다(질문에 있던 숫자를 되풀이해도 확인이 아니다). 숫자가 있으면 답하지 않는다.
            numbered = bool(rx(r"\d").search(said))
            if said and not numbered:
                return GroundedAnswer(
                    speech=f"{s['servNm']} 공식 자료에는 그 내용이 없어요. 일반적으로 알려진 바로는, {said} 정확한 내용은 주민센터나 보건복지상담센터 129에 꼭 확인해 주세요.",
                    sources=[cite(s["source"])],
                    grounded=False,
                    method="general-llm",
                    service=_service_ref(s),
                    retrieval=retrieval,
                    card=answer_card(s, f"{s['servNm']} 공식 자료에는 그 내용이 없어요.", [], grounded=False),
                )
            return GroundedAnswer(
                speech=f"{s['servNm']} 공식 자료에서 그 내용은 찾지 못했습니다. 추측해서 답하지 않겠습니다. 보건복지상담센터 129에 문의해 보세요. {source_sentence(s['source'])}",
                sources=[cite(s["source"])],
                grounded=False,
                method="rag-llm",
                service=_service_ref(s),
                retrieval=retrieval,
                verification={"ok": False, "reasons": ["공식 자료에 없는 답에 숫자"]} if numbered else None,
                card=answer_card(s, f"{s['servNm']}의 공식 자료에서 확인이 필요해요.", [], grounded=False),
            )
        exact = f"{parsed.answer.strip()}{eligibility_note(question)}"
        return GroundedAnswer(
            speech=f"{exact} {source_sentence(s['source'])}",
            sources=[cite(s["source"])],
            grounded=True,
            method="rag-llm",
            service=_service_ref(s),
            retrieval=retrieval,
            card=answer_card(s, exact, [c["field"] for c in cited]),
        )

    async def public_facts(self, subject: str, question: str, facts: tuple[str, ...], signal: AbortSignal) -> GroundedAnswer | None:
        """읽기 요청은 해당 제도의 해당 필드에서 근거를 찾는다. 자료가 없으면 공식 웹 탐색에 인계한다."""
        if not subject or signal.aborted:
            return None
        service = await self.provider.find_service(subject)
        # A fixture can link to the agency while containing only demonstration text.
        # Public lookups fall through to the browser so claims come from an observed official source.
        if not service or service.get("dataOrigin") != "official-api" or signal.aborted:
            return None
        fields = {"documents": ("documents", "forms"), "eligibility": ("target", "criteria"),
                  "amount": ("benefit",), "procedure": ("applySteps", "applyMethod"), "contact": ("contacts",),
                  "location": ("contacts",), "other": ("summary", "target", "benefit", "applyMethod")}
        chunks = chunk_service(service)
        candidates = {fact: {c["id"]: c["text"] for c in chunks if c["field"] in fields.get(fact, ())} for fact in facts}
        if "dates" in facts and service.get("dataOrigin") == "official-api":
            status, period, _ = application_period(service)
            if status != "unknown" and period:
                candidates["dates"] = {"applicationPeriod": period}
        if not all(candidates.values()):
            return None
        evidence = PublicEvidence(facts)
        complex_facts = {}
        for fact, entries in candidates.items():
            lines = [line.strip() for value in entries.values() for line in value.splitlines() if line.strip()]
            if fact != "other" and len(lines) == 1 and len(lines[0]) <= 240:
                # 한 필드·한 줄이면 별도 모델 호출 없이 출처 그대로 말한다.
                evidence.passages[fact] = [(next(iter(entries)), lines[0])]
            else:
                complex_facts[fact] = entries
        if complex_facts and self.llm and not signal.aborted:
            item = {"type": "object", "additionalProperties": False, "required": ["fact", "quote"],
                    "properties": {"fact": {"type": "string", "enum": list(PUBLIC_FACT_LABELS)}, "quote": {"type": "string"}}}
            raw = await self.llm.generate(
                system="질문에 답하는 각 공식 필드에서 필요한 문장을 그대로 인용하라. 금액·연령·기간은 적용 대상과 함께 고른다. "
                       "여러 대상이 적용될 수 있으면 각 조건을 모두 포함한다. 인용할 근거가 없으면 해당 항목을 비워 둔다.",
                user=jdumps({"question": question, "service": subject, "fields": complex_facts}),
                schemaName="public_welfare_facts", schema={"type": "object", "additionalProperties": False, "required": ["claims"],
                    "properties": {"claims": {"type": "array", "items": item}}}, signal=signal)
            claims = raw.get("claims") if isinstance(raw, dict) else None
            for fact, entries in complex_facts.items():
                evidence.collect([c for c in claims if isinstance(c, dict) and c.get("fact") == fact]
                                 if isinstance(claims, list) else [], entries)
        if evidence.missing or signal.aborted:
            return None
        self._last_service = service
        speech, _ = evidence.result({})
        ids = {key for passages in evidence.passages.values() for key, _ in passages}
        used = [c["field"] for c in chunks if c["id"] in ids]
        if "applicationPeriod" in ids:
            used.append("applicationPeriod")
        card = answer_card(service, speech, used)
        return GroundedAnswer(speech=speech, grounded=True, sources=[cite(service["source"])], method="public-fields",
                              service=_service_ref(service), card=card,
                              review_quotes=tuple(quote for passages in evidence.passages.values() for _, quote in passages))

    async def _load_catalog(self, ctpv: str | None = None) -> list[dict]:
        try:
            if ctpv:
                try:
                    return await self.provider.catalog(ctpv)
                except TypeError:
                    return await self.provider.catalog()
            return await self.provider.catalog()
        except (OSError, ValueError):
            return []

    def _match_catalog_row(self, catalog: list[dict], name: str, province: str | None, district: str | None) -> tuple[dict | None, bool]:
        """(유일하게 일치한 항목, 중복으로 모호한지). 중복이거나 다른 시·군·구 사업이면 추측하지 않는다."""
        key = _norm_key(name)
        if not key:
            return None, False
        rows = [row for row in catalog if _norm_key(row.get("servNm") or "") == key]
        if not rows:
            return None, False
        if district:
            same_district = [row for row in rows if (row.get("region") or {}).get("sgg") == district]
            if same_district:
                rows = same_district
            else:
                rows = [row for row in rows if not (row.get("region") or {}).get("sgg")]
        if len(rows) > 1 and province:
            narrowed = [row for row in rows if (row.get("region") or {}).get("ctpv") == province]
            if narrowed:
                rows = narrowed
        if not rows:
            return None, False
        if len(rows) == 1:
            return rows[0], False
        return None, True

    async def direct_links(
        self,
        name: str,
        *,
        ctpv: str | None = None,
        sgg: str | None = None,
        include_detail: bool = False,
    ) -> dict | None:
        """
        중앙 API(15090532)·지자체 API(15108347)·중앙 CSV(15083323)에서 검증된 공식 직접 링크를 모은다.
        복지로 상세 주소는 wlfareInfoId가 servId와 같을 때만 인정하고, 같은 이름이 여러 개면 추측하지 않는다.
        """
        province, district = _resolve_region_hints(name, ctpv, sgg)
        candidates = [name.strip()]
        stripped = _strip_region_prefix(name)
        if stripped and stripped not in candidates:
            candidates.append(stripped)

        catalog = await self._load_catalog(province)
        catalog_row: dict | None = None
        for cand in candidates:
            row, ambiguous = self._match_catalog_row(catalog, cand, province, district)
            if ambiguous:
                return None
            if row is not None:
                catalog_row = row
                break

        source_ids: list[str] = []
        serv_id = ""
        serv_nm = ""
        detail_url: str | None = None
        provider_kind = ""
        api_source_id = "15090532"

        if catalog_row is not None:
            serv_id = catalog_row.get("servId") or ""
            serv_nm = catalog_row.get("servNm") or ""
            provider_kind = catalog_row.get("provider") or "central"
            api_source_id = "15108347" if provider_kind == "local" else "15090532"
            raw_detail = catalog_row.get("detailUrl")
            detail_url = _verified_bokjiro_url(raw_detail, serv_id)
            if raw_detail and not detail_url:
                return None
            if detail_url:
                source_ids.append(api_source_id)

        csv_row = None
        if self._links:
            if serv_id:
                csv_row = self._links.by_id(serv_id)
            if csv_row is None and catalog_row is None:
                for cand in candidates:
                    csv_row = self._links.by_name(cand)
                    if csv_row is not None:
                        break
        csv_sites: list[dict] = []
        if csv_row is not None:
            if not serv_id:
                serv_id = csv_row.serv_id
                serv_nm = csv_row.name
                provider_kind = "csv"
            if not detail_url:
                detail_url = _verified_bokjiro_url(csv_row.detail_url, csv_row.serv_id)
            csv_sites = [
                {"name": site.name, "url": u, "sourceId": "15083323"}
                for site in csv_row.sites
                if (u := _verified_public_url(site.url))
            ]
            if (detail_url and "15083323" not in source_ids and catalog_row is None) or csv_sites:
                if "15083323" not in source_ids:
                    source_ids.append("15083323")

        api_sites: list[dict] = []
        api_forms: list[dict] = []
        detail: dict | None = None
        if serv_id and (self._last_service or {}).get("servId") == serv_id:
            detail = self._last_service
        elif serv_id and include_detail:
            try:
                if provider_kind == "local":
                    fn = getattr(self.provider, "get_local_service", None)
                    detail = await fn(serv_id, detail_url or "") if fn else None
                elif getattr(self.provider, "mode", None) == "official-api" or catalog_row is not None:
                    fn = getattr(self.provider, "get_service", None)
                    if fn:
                        try:
                            detail = await fn(serv_id, detail_url or "")
                        except TypeError:
                            detail = await fn(serv_id)
            except Exception:  # noqa: BLE001
                detail = None
        if detail and detail.get("servId") == serv_id:
            api_sites, api_forms = _detail_links(detail, api_source_id)
            if (api_sites or api_forms) and api_source_id not in source_ids:
                source_ids.append(api_source_id)

        related_sites = _merge_direct_links([*api_sites, *csv_sites])
        forms = _merge_direct_links(api_forms)
        if not detail_url and not related_sites and not forms:
            return None
        return {
            "servId": serv_id,
            "servNm": serv_nm,
            "detailUrl": detail_url,
            "relatedSites": related_sites,
            "forms": forms,
            "sourceIds": source_ids,
        }

    async def application_guide_url(self, name: str, *, ctpv: str | None = None, sgg: str | None = None) -> str | None:
        """공식 목록(중앙 15090532·지자체 15108347)과 중앙 CSV(15083323)에서 이름이 정확히 한 제도에 해당할 때만 복지로 상세 주소를 쓴다."""
        bundle = await self.direct_links(name, ctpv=ctpv, sgg=sgg)
        return bundle["detailUrl"] if bundle else None

    async def resolve_guide_target(
        self,
        question: str,
        *,
        subject: str | None = None,
        site_url: str | None = None,
        ctpv: str | None = None,
        sgg: str | None = None,
    ) -> dict | None:
        """목표 수행의 시작 주소: 복지로 상세(중앙·지자체·CSV)와 공식 관련 사이트·서식 링크를 찾는다."""
        dest = try_url(site_url) if site_url else None
        if dest is not None and not (dest.origin in ("https://www.bokjiro.go.kr", "https://bokjiro.go.kr") and dest.pathname == "/"):
            return None
        province, district = _resolve_region_hints(question, ctpv, sgg)
        q = rx(r"^(?:복지로|bokjiro)(?:에서|에|가서|들어가서|열어서)?\s*", I).sub("", question.strip()).strip()
        wants_site = bool(_SITE_REQUEST_CUE.search(q))
        wants_form = bool(_FORM_REQUEST_CUE.search(q))

        candidates: list[str] = []
        if subject and subject.strip():
            candidates.append(subject.strip())
        if m := _GUIDE_CUE.match(q):
            prefix = m.group(1).strip()
            if prefix and prefix not in candidates:
                candidates.append(prefix)
        if self._links:
            hit = self._links.match_in_text(q)
            if hit and hit.name not in candidates:
                candidates.append(hit.name)
        if not candidates or (province and not subject):
            catalog = await self._load_catalog(province)
            compact_q = _norm_key(q)
            matched: list[tuple[int, str, str]] = []
            for row in catalog:
                name = (row.get("servNm") or "").strip()
                k = _norm_key(name)
                if len(k) >= 4 and k in compact_q:
                    matched.append((len(k), k, name))
            if matched:
                matched.sort(key=lambda item: -item[0])
                top_names: list[str] = []
                top_keys: list[str] = []
                for _, k, name in matched:
                    if any(k in existing for existing in top_keys):
                        continue
                    top_keys.append(k)
                    top_names.append(name)
                if len(top_names) == 1 and top_names[0] not in candidates:
                    candidates.append(top_names[0])

        for cand in candidates:
            bundle = await self.direct_links(cand, ctpv=province, sgg=district, include_detail=wants_site or wants_form)
            if not bundle:
                continue
            if dest is not None:
                if bundle["detailUrl"]:
                    return {"url": bundle["detailUrl"], "kind": "bokjiro", "links": bundle}
                continue
            if wants_site and bundle["relatedSites"]:
                picked = _pick_related_site(bundle["relatedSites"], q)
                if picked:
                    return {"url": picked["url"], "kind": "related-site", "label": picked["name"] or bundle["servNm"], "links": bundle}
            if bundle["detailUrl"]:
                return {"url": bundle["detailUrl"], "kind": "bokjiro", "links": bundle}
        return None

    async def resolve_site_link(self, target: str, *, ctpv: str | None = None, sgg: str | None = None) -> dict | None:
        """알려진 사이트 목록에 없을 때 공식 CSV(15083323)·복지 API(15090532·15108347)의 직접 링크를 찾는다."""
        cleaned = rx(r"(을|를|에|로|으로|좀)?\s*(열어|접속|들어가|이동해|가|켜|띄워)\S*\s*(줘|주세요|봐)?").sub(" ", target).strip()
        cleaned = rx(r"\s+").sub(" ", cleaned).strip(" .,!?")
        if len(cleaned) < 2:
            return None
        wants_related = bool(_SITE_REQUEST_CUE.search(cleaned))
        wants_bokjiro = bool(rx(r"복지로|상세\s*페이지|공식\s*안내").search(cleaned))
        bare = rx(r"(?:복지로|관련|공식)?\s*(?:홈페이지|웹\s*사이트|사이트|누리집|상세\s*페이지|공식\s*안내|페이지|안내)").sub(" ", cleaned)
        bare = rx(r"\s+").sub(" ", bare).strip(" .,!?")
        if not wants_bokjiro and self._links:
            site = self._links.related_site(cleaned) or (self._links.related_site(bare) if bare else None)
            if site and (url := _verified_public_url(site.url)):
                return {"url": url, "label": site.name or bare or cleaned, "kind": "related-site", "sourceId": "15083323"}
        if len(bare) < 2:
            return None
        bundle = await self.direct_links(bare, ctpv=ctpv, sgg=sgg, include_detail=wants_related)
        if not bundle:
            return None
        if wants_related and not wants_bokjiro and bundle["relatedSites"]:
            picked = _pick_related_site(bundle["relatedSites"], cleaned)
            if picked:
                return {"url": picked["url"], "label": picked["name"] or bundle["servNm"], "kind": "related-site", "sourceId": picked["sourceId"]}
        if bundle["detailUrl"]:
            return {"url": bundle["detailUrl"], "label": f"복지로 {bundle['servNm']}", "kind": "bokjiro", "sourceId": bundle["sourceIds"][0]}
        return None

    async def readable_service(self, page_url: str) -> dict | None:
        """
        복지로 상세 페이지(주소의 wlfareInfoId)를 공식 API 자료로 "읽을 글"로 만든다.
        복지로 화면은 지원대상·서비스 내용·신청방법이 탭으로 나뉘어 한 번에 한 탭만 보이므로, 화면 대신 공식 자료를 중요한 순서로 읽는다.
        찾지 못하면 None(호출자가 화면 본문을 읽음).
        """
        u = try_url(page_url)
        if u is None or not rx(r"bokjiro\.go\.kr$").search(u.hostname):
            return None
        sid = u.param("wlfareInfoId")
        if not sid:
            return None
        s = self._last_service if (self._last_service or {}).get("servId") == sid else None
        if s is None:
            try:
                s = await self.provider.get_service(sid)
            except Exception:  # noqa: BLE001
                s = None
        if s is None:
            fn = getattr(self.provider, "get_local_service", None)
            if fn:
                try:
                    s = await fn(sid, page_url)
                except Exception:  # noqa: BLE001
                    s = None
        if not s:
            return None
        self._last_service = s

        def block(label: str, text: str | None) -> str:
            body = " ".join(line.strip() for line in (text or "").split("\n") if line.strip())
            return f"{label}: {body if body.endswith('.') else body + '.'}" if body else ""

        steps = ". ".join(f"{a['step']}은 {a['detail']}" for a in s["applySteps"]) if s.get("applySteps") else s.get("applyMethod")
        contact = ", ".join(f"{c['name']} {c['value']}" for c in s["contacts"]) if s.get("contacts") else ""
        text = " ".join(
            x
            for x in [
                f"{s['servNm']}. {s['summary']}",
                # 사용자에게 중요한 순서: 누가 받는지 → 무엇을 받는지 → 어떻게 신청하는지 → 문의 → (계산식이 많은) 자세한 선정 기준
                block("지원 대상", s.get("target")),
                block("서비스 내용", s.get("benefit")),
                block("신청 방법", steps),
                block("문의", contact),
                block("자세한 선정 기준", s.get("criteria")),
            ]
            if x
        )
        return {"servNm": s["servNm"], "text": text}

    async def briefing(self) -> str | None:
        """
        지금 제도의 요점 한두 문장: 누가 → 무엇을 → 어떻게 신청. 듣자마자 머리에 그려지게.
        LLM이 있으면 공식 자료로 압축하고(숫자는 자료에 있는 것만), 없거나 틀리면 자료 첫 문장들로.
        """
        s = self._last_service
        if not s:
            return None
        source = "\n".join([f"대상: {s['target']}", f"내용: {s.get('benefit') if s.get('benefit') is not None else s['summary']}", f"신청: {s['applyMethod']}"])[
            :2500
        ]
        if self.llm:
            out = await self.llm.generate(
                system="복지 제도 공식 자료에서 지원 대상, 혜택, 신청처를 골라 듣기 쉬운 존댓말 1~2문장, 합쳐 80자 안팎으로 요약한다. 자료에 없는 내용·숫자는 쓰지 않는다. 예외 조건·계산식은 빼고, 자격을 단정하지 않는다.",
                user=jdumps({"제도": s["servNm"], "자료": source}),
                schemaName="service_brief",
                schema={"type": "object", "additionalProperties": False, "required": ["text"], "properties": {"text": {"type": "string"}}},
            )
            text = (out.get("text") or "").strip() if isinstance(out, dict) and isinstance(out.get("text"), str) else ""
            if text and not unsupported_numbers(text, [source]):
                return text
        return f"대상은 {first_sentence(s['target'], 70)}. 신청은 {first_sentence(s['applyMethod'], 50)}."

    async def answer_policy_question(self, question: str, today: str | None = None) -> GroundedAnswer:
        """질문 주제(대상·기준·금액·절차·서류·문의)에 맞는 부분만 골라 답한다(LLM 없이)."""
        if not SERVICE_NAME.search(rx(r"\s+").sub("", question)) and not self._last_service:
            return replace(_ASK_SERVICE)
        s = await self._service(question)
        if not s:
            return GroundedAnswer(speech="그 제도의 공식 자료를 찾지 못했어요. 보건복지상담센터 129에 문의해 보세요.", method="none")
        self._last_service = s
        return self._topic_answer(s, question, today)

    def _topic_answer(self, s: dict, question: str, today: str | None = None) -> GroundedAnswer:
        if is_deadline_question(question):
            return self._deadline_answer(s, today)
        parts: list[str] = []
        fields: list[str] = []
        if rx(r"(대상|자격|누가|받을\s*수)").search(question) and s.get("target"):
            fields.append("target")
            parts.append(f"지원 대상: {lines(s.get('target'), 1)}")
            threshold = next((line for line in (s.get("criteria") or "").split("\n") if rx(r"선정기준액은").search(line)), None) if s.get("criteria") else None
            if threshold:
                parts.append(threshold.strip())
                fields.append("criteria")
        criteria_question = bool(rx(r"(선정\s*기준|소득인정액|기준액)").search(question))
        if criteria_question and s.get("criteria"):
            fields.append("criteria")
            parts.append(f"선정 기준: {lines(s.get('criteria'), 3, 600)}")
        if _AMOUNT_Q.search(question) and not criteria_question:
            benefit_lines = [line.strip() for line in (s.get("benefit") or "").splitlines() if line.strip()]
            amount_line = next((i for i, line in enumerate(benefit_lines) if _MONEY.search(line)), None)
            if amount_line is not None:
                evidence = " ".join(benefit_lines[max(0, amount_line - 1):amount_line + 1])
                parts.append(f"지원 내용: {evidence}")
                fields.append("benefit")
            if amount_line is None:
                parts.append("지원 금액은 이 자료에서 확인하지 못했어요.")
        if criteria_question and "criteria" not in fields:
            parts.append("선정 기준은 이 자료에서 확인하지 못했어요.")
        if rx(r"(방법|절차|어디|어떻게)").search(question) and (s.get("applySteps") or s.get("applyMethod")):
            fields.append("applySteps" if s.get("applySteps") else "applyMethod")
            parts.append(
                f"신청 절차: {'. '.join(a['step'] + '은 ' + a['detail'] for a in s['applySteps'])}"
                if s.get("applySteps")
                else f"신청 방법: {s['applyMethod']}"
            )
        if rx(r"(서류|서식|양식)").search(question):
            if s.get("documents"):
                fields.append("documents")
                parts.append(f"제출서류: {lines(s['documents'], 3)}")
            else:
                if s.get("forms"):
                    fields.append("forms")
                parts.append(
                    f"관련 서식: {', '.join(_FORM_EXT.sub('', f['name']) for f in s['forms'])}" if s.get("forms") else "서식 정보는 이 자료에 없습니다."
                )
        if rx(r"(문의|전화|연락)").search(question):
            if s.get("contacts"):
                fields.append("contacts")
            parts.append(
                f"문의처: {', '.join(c['name'] + ' ' + c['value'] for c in s['contacts'])}" if s.get("contacts") else "문의처 정보는 이 자료에 없습니다."
            )
        if not parts:
            for name, label in (("summary", ""), ("target", "지원 대상: ")):
                if s.get(name):
                    fields.append(name)
                    parts.append(label + lines(s[name], 1))
        if not parts:
            parts.append("이 자료에서 확인하지 못했어요.")

        def end(p: str) -> str:
            p = p.strip()
            return p if rx(r"[.!?…]$").search(p) else f"{p}."

        answer = f"{' '.join(end(p) for p in parts)}{eligibility_note(question)}"
        grounded = bool(fields) and not any("확인하지 못했어요" in p or "자료에 없습니다" in p for p in parts)
        return GroundedAnswer(
            speech=f"{answer} {source_sentence(s['source'])}",
            sources=[cite(s["source"])],
            grounded=grounded,
            method="topic-rule",
            service=_service_ref(s),
            card=answer_card(s, answer, fields, grounded=grounded),
        )

    async def application_context(self) -> GroundedAnswer:
        """신청서를 열 때 덧붙이는 짧은 실제 신청 경로 안내와 근거."""
        s = await self.provider.find_service(DEFAULT_SERVICE)
        if not s:
            return GroundedAnswer(speech="")
        # 신청을 시작했으면 이후 "소득 있어도 돼?" 같은 질문은 이 제도에 대한 것이다.
        self._last_service = s

        def first(text: str) -> str:
            return rx(r"\.$").sub("", text.split(". ")[0])

        steps = s.get("applySteps") or []
        speech = (
            f"참고로 실제 {s['servNm']} 신청은 {first(steps[0]['detail'])}에서 할 수 있습니다."
            if steps
            else f"참고로 실제 {s['servNm']}은 {first(s['applyMethod'])}."
        )
        return GroundedAnswer(speech=speech, sources=[cite(s["source"])], grounded=True, service=_service_ref(s))
