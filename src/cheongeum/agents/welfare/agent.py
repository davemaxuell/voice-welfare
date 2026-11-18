"""
Agent B의 복지 정보 모듈: 정책 데이터(공식 API 또는 fixture)만 근거로 설명하고 항상 출처·확인일을 붙인다.
화면 텍스트나 사용자 입력을 정책 사실로 섞지 않으며, 수급 자격을 판정하지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from cheongeum.agents.welfare.discovery import Match, describe_profile, match_services
from cheongeum.agents.welfare.rag import chunk_service, retrieve
from cheongeum.core.jsutil import I, compact, jdumps, rx, today_iso, try_url
from cheongeum.core.turn import AGENT_IDS
from cheongeum.safety import check_grounding, unsupported_numbers


def _catalog_source() -> dict:
    return {
        "title": "한국사회보장정보원 복지서비스 목록(중앙부처·지자체)",
        "url": "https://www.data.go.kr/data/15090532/openapi.do",
        "lastCheckedAt": today_iso(),
        "version": "API 실시간",
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

RAG_SYSTEM = """너는 시각장애인을 돕는 한국 복지 제도 안내 도우미다.
반드시 사용자 메시지의 "근거" 조각에 적힌 내용만으로 답한다. 근거에 없는 내용은 추측하지 말고 answerable=false로 둔다.
수급 자격을 판정하지 않는다("받을 수 있다/없다"고 단정하지 말 것). 금액·나이·날짜는 근거 그대로 쓴다.
질문에 대한 답(결론·숫자·대상)부터 말하고, 최대 2문장 100자 안팎의 짧고 쉬운 존댓말로 답한다. 묻지 않은 내용(서식, 다른 단계, 예외 조건 등)은 덧붙이지 않는다. 괄호 남발을 피한다.
usedChunkIds에는 답에 실제로 쓴 근거 id만 넣는다."""

# 질문 속 복지 제도 이름(예: 기초연금, 주거급여)
SERVICE_NAME = rx(r"([가-힣]{2,12}(?:연금|수당|급여|바우처|지원금|장려금|지원사업|보험료\s*지원))")

# MVP 첫 적용 대상. 질문에 다른 서비스명이 없으면 이것을 찾는다.
DEFAULT_SERVICE = "장애인연금"
ELIGIBILITY_NOTE = "자격은 담당 기관이 최종 판단해요."
_FORM_EXT = rx(r"\.(hwpx?|pdf)$", I)


def cite(s: dict) -> dict:
    return compact({"title": s["title"], "url": s["url"], "lastCheckedAt": s["lastCheckedAt"], "version": s.get("version"), "note": s.get("note")})


def source_sentence(s: dict) -> str:
    """말로는 짧게(자세한 링크·확인일은 화면의 근거 자료 목록에 표시)"""
    who = "출처: 복지로" if s["title"].startswith("복지로") else f"출처: {s['title']}"
    return f"({who}, {s['version']})"


def first_sentences(text: str, n: int = 2) -> str:
    """음성으로는 핵심 두 문장까지만(LLM이 길게 써도 잘라 낸다)."""
    parts = rx(r"(?<=[.!?。]|다\.|요\.)\s+").split(text.strip())
    return " ".join(parts[:n])


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

_WORD = {"met": "맞아요", "unmet": "맞지 않을 수 있어요", "unknown": "확인이 필요해요"}


class WelfareInformationAgent:
    id = AGENT_IDS.welfare

    def __init__(self, provider: Any, llm: Any = None) -> None:
        self.provider = provider
        self.llm = llm
        # 직전에 이야기한 제도(“그럼 신청은 어디서 해?” 같은 이어지는 질문용)
        self._last_service: dict | None = None
        # 맞춤 복지 찾기
        self._matches: list[Match] = []
        self._shown = 0
        self._list_hinted = False
        # 사용자가 고른 찾기 결과(목록 요약)
        self._picked: dict | None = None

    @property
    def current_service_name(self) -> str | None:
        """지금 대화의 기준 제도(없으면 None)"""
        if self._last_service:
            return self._last_service["servNm"]
        return self._picked["servNm"] if self._picked else None

    @property
    def current_service_url(self) -> str | None:
        """지금 제도의 공식 상세 페이지(복지로) — Agent A가 열어 준다"""
        if self._picked and self._picked.get("detailUrl"):
            return self._picked["detailUrl"]
        if self._last_service and "bokjiro" in self._last_service["source"]["url"]:
            return self._last_service["source"]["url"]
        return None

    @property
    def has_matches(self) -> bool:
        return bool(self._matches)

    def _list_speech(self, frm: int) -> str:
        page = self._matches[frm : frm + 3]
        self._shown = frm + len(page)
        # 목록은 이름만 짧게(듣고 고르기 쉽게). 설명은 번호를 말하면 그때.
        items = ", ".join(f"{frm + i + 1}번 {m.service['servNm']}" for i, m in enumerate(page))
        more = " 더 들으려면 '더 알려줘'." if len(self._matches) > self._shown else ""
        hint = "" if self._list_hinted else " 번호를 말씀하시면 자세히 알려 드려요. 예: '1번 자세히', '1번 자격 확인해줘'."
        self._list_hinted = True
        return f"{items}이에요.{more}{hint}"

    async def discover(self, profile: dict) -> GroundedAnswer:
        """프로필로 받을 수 있을 법한 제도를 찾는다(자격 판정 아님)."""
        catalog = await self.provider.catalog(profile.get("ctpv") or None)
        self._matches = match_services(catalog, profile)
        self._shown = 0
        if not self._matches:
            return GroundedAnswer(
                speech="말씀하신 조건에 맞는 제도를 찾지 못했어요. 조건을 바꿔 말씀하시거나 보건복지상담센터 129에 문의해 보세요.",
                sources=[_catalog_source()],
                grounded=False,
                count=0,
                method="topic-rule",
            )
        n = len(self._matches)
        return GroundedAnswer(
            speech=f"받을 수 있을 법한 제도를 {'여러 개' if n > 10 else f'{n}개'} 찾았어요. 관련 높은 순서로 {self._list_speech(0)} 실제로 받을 수 있는지는 기관이 판단해요.",
            sources=[_catalog_source()],
            grounded=True,
            count=n,
            method="topic-rule",
        )

    def more_matches(self) -> GroundedAnswer:
        if not self._matches:
            return GroundedAnswer(speech="아직 찾은 제도가 없어요. '받을 수 있는 복지 찾아줘'라고 해 보세요.")
        if self._shown >= len(self._matches):
            return GroundedAnswer(speech="찾은 제도를 모두 알려드렸어요.", sources=[_catalog_source()], grounded=True)
        return GroundedAnswer(speech=self._list_speech(self._shown), sources=[_catalog_source()], grounded=True)

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
            if (self._last_service or {}).get("servNm") != hit["servNm"]:
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
        if s and s.get("provider") == "central":
            return (await self.provider.get_service(s["servId"])) or (await self.provider.find_service(s["servNm"]))
        if s and s.get("provider") == "local":
            fn = getattr(self.provider, "get_local_service", None)
            return await fn(s["servId"], s.get("detailUrl") or "") if fn else None
        if name:
            return await self.provider.find_service(name)
        return None

    def _picked_source(self, s: dict) -> dict:
        return {**_catalog_source(), "url": s.get("detailUrl") or _catalog_source()["url"], "title": f"복지로 '{s['servNm']}'"}

    async def service_detail(self, ref: str | None) -> GroundedAnswer:
        s = self.pick(ref)
        if not s:
            return GroundedAnswer(speech="어떤 제도인지 알려 주세요. 예: '1번 자세히'.")
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
        criteria = f"{detail['target']}\n{detail.get('criteria') or ''}".strip() if detail else ""
        if not criteria:
            # 선정기준 원문이 없으면 추측으로 비교하지 않는다.
            targets = f"목록상 대상은 {', '.join(s['targets'])}이에요. " if s and s["targets"] else ""
            return GroundedAnswer(
                speech=f"{name}의 자세한 선정기준을 공식 자료에서 가져오지 못했어요. {targets}정확한 자격은 담당 기관에 확인해 주세요. 복지로 상세 페이지를 열어 드릴까요?",
                sources=[self._picked_source(s)] if s and s.get("detailUrl") else [_catalog_source()],
                grounded=False,
            )
        who = describe_profile(profile) or "알려 주신 정보 없음"
        checks: list[dict] = []
        if self.llm:
            out = await self.llm.generate(
                system=(
                    "복지 제도의 공식 대상·선정기준과 사용자 정보를 비교해 조건별로 status를 정한다. met=사용자 정보로 충족이 확인됨, unmet=사용자 정보와 어긋남, unknown=사용자 정보가 없거나(예: 소득 금액, 거주 기간) 판단 불가. 사용자가 말하지 않은 것은 반드시 unknown. 기준 원문에 있는 조건만, 중요한 것 3개 이내. condition은 15자 이내 한국어 명사구(예: \"만 18세 이상\", \"중위소득 50% 이하\"), note는 한 문장. 최종 자격을 단정하지 말 것."
                ),
                user=jdumps({"제도": name, "기준": criteria[:2500], "사용자": {**profile, "설명": who}}),
                schemaName="precheck",
                schema=PRECHECK_SCHEMA,
            )
            raw_checks = (out or {}).get("checks") if isinstance(out, dict) else None
            checks = [c for c in (raw_checks or []) if isinstance(c, dict) and c.get("condition") and c.get("status") in _WORD][:3]
        if not checks:
            m = rx(r"(\d{1,3})\s*세\s*이상").search(criteria)
            if m and profile.get("age") is not None and profile["age"] >= 0:
                checks.append({"condition": f"{m.group(1)}세 이상", "status": "met" if profile["age"] >= int(m.group(1)) else "unmet", "note": ""})
            if rx(r"장애").search(criteria):
                checks.append({"condition": "장애 기준", "status": "met" if profile.get("disability") == "severe" else "unknown", "note": ""})
            if rx(r"소득|재산").search(criteria):
                checks.append({"condition": "소득·재산 기준", "status": "met" if profile.get("income") == "basic" else "unknown", "note": ""})
        body = ". ".join(f"{rx(r'[.。]$').sub('', c['condition'])}: {_WORD[c['status']]}" for c in checks)
        return GroundedAnswer(
            speech=f"{name} 자격을 미리 살펴봤어요. {body or '기준과 비교할 정보가 부족해요'}. 최종 자격은 기관이 판단해요. 신청 준비가 궁금하면 '신청하려면 뭐가 필요해?'라고 해 주세요.",
            sources=[cite(detail["source"])] if detail else [_catalog_source()],
            grounded=bool(detail),
            service=_service_ref(detail) if detail else None,
            method="rag-llm" if self.llm else "topic-rule",
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
        steps = detail.get("applySteps") or []
        how = steps[0]["detail"] if steps else detail["applyMethod"]
        forms = [
            rx(r"^[★\s]+").sub("", _FORM_EXT.sub("", f["name"]))
            for f in (detail.get("forms") or [])
        ]
        forms = [f for f in forms if not rx(r"사업안내").search(f)]
        contact = next((c for c in (detail.get("contacts") or []) if rx(r"^\d").search(c["value"])), None)
        forms_part = f" 필요한 서식은 {', '.join(forms[:3])} 등이 있어요." if forms else ""
        contact_part = f" 문의는 {contact['name']} {contact['value']}." if contact else ""
        return GroundedAnswer(
            speech=f"{detail['servNm']} 신청은 {first_sentence(how, 80)}에서 해요.{forms_part}{contact_part} 복지로 상세 페이지를 열어 드릴까요?",
            sources=[cite(detail["source"])],
            grounded=True,
            service=_service_ref(detail),
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

    async def select_service(self, text: str) -> str | None:
        """말에 제도 이름이 있으면 공식 자료에서 찾아 대화의 기준 제도로 삼는다(실제 사이트 신청 안내용)."""
        if not SERVICE_NAME.search(rx(r"\s+").sub("", text)):
            return None
        s = await self._service(text)
        if not s:
            return None
        self._last_service = s
        self._picked = None
        return s["servNm"]

    async def _service(self, question: str) -> dict | None:
        """질문에서 제도 이름을 찾고, 없으면 직전 제도 → 기본(장애인연금) 순서."""
        m = SERVICE_NAME.search(rx(r"\s+").sub("", question))
        if m:
            named = m.group(1)
            exact = await self.provider.find_service(named)
            if exact:
                return exact
            listed = await self.provider.list_services(named)
            if listed:
                return (await self.provider.get_service(listed[0]["servId"])) or listed[0]
            return None
        # 제도 이름도, 이전 대화의 제도도 없으면 특정 제도를 가정하지 않는다(호출자가 되묻는다).
        return self._last_service

    async def answer_question(self, question: str) -> GroundedAnswer:
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
        if not self.llm:
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
        used = [i for i in parsed.usedChunkIds if i in ids] if parsed else []
        retrieval = {"chunkIds": [c["id"] for c in top], "sections": [c["section"] for c in top], "used": used}
        # 형식 오류이거나, 답했다면서 근거를 하나도 대지 못하면 믿지 않고 규칙 답변으로 대체한다.
        if parsed is None or (parsed.answerable and not used):
            return replace(self._topic_answer(s, question), retrieval=retrieval)
        if parsed.answerable:
            # 검증 담당: 답에 나온 금액·나이·날짜가 LLM에 준 근거 조각(또는 질문)에 있어야 한다. 없으면 지어낸 숫자로 보고 규칙 답변으로 바꾼다.
            check = check_grounding(answer=parsed.answer, sources=[c["text"] for c in top], allowed=[question], min_quotes=0)
            if not check.ok:
                return replace(self._topic_answer(s, question), retrieval=retrieval, verification={"ok": False, "reasons": check.reasons})
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
            if g.get("known") and isinstance(g.get("answer"), str) and g["answer"].strip():
                return GroundedAnswer(
                    speech=f"{s['servNm']} 공식 자료에는 그 내용이 없어요. 일반적으로 알려진 바로는, {g['answer'].strip()} 정확한 내용은 주민센터나 보건복지상담센터 129에 꼭 확인해 주세요.",
                    sources=[cite(s["source"])],
                    grounded=False,
                    method="general-llm",
                    service=_service_ref(s),
                    retrieval=retrieval,
                )
            return GroundedAnswer(
                speech=f"{s['servNm']} 공식 자료에서 그 내용은 찾지 못했습니다. 추측해서 답하지 않겠습니다. 보건복지상담센터 129에 문의해 보세요. {source_sentence(s['source'])}",
                sources=[cite(s["source"])],
                grounded=False,
                method="rag-llm",
                service=_service_ref(s),
                retrieval=retrieval,
            )
        return GroundedAnswer(
            speech=f"{first_sentences(parsed.answer)}{eligibility_note(question)} {source_sentence(s['source'])}",
            sources=[cite(s["source"])],
            grounded=True,
            method="rag-llm",
            service=_service_ref(s),
            retrieval=retrieval,
        )

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
                system='복지 제도 공식 자료를 시각장애인이 듣자마자 이해하도록 요점만 말한다. "누가 무엇을 받고, 어디서 신청하는지"를 쉬운 존댓말 1~2문장, 합쳐 80자 안팎으로. 자료에 없는 내용·숫자는 쓰지 않는다. 예외 조건·계산식은 빼고, 자격을 단정하지 않는다.',
                user=jdumps({"제도": s["servNm"], "자료": source}),
                schemaName="service_brief",
                schema={"type": "object", "additionalProperties": False, "required": ["text"], "properties": {"text": {"type": "string"}}},
            )
            text = (out.get("text") or "").strip() if isinstance(out, dict) and isinstance(out.get("text"), str) else ""
            if text and not unsupported_numbers(text, [source]):
                return text
        return f"대상은 {first_sentence(s['target'], 70)}. 신청은 {first_sentence(s['applyMethod'], 50)}."

    async def answer_policy_question(self, question: str) -> GroundedAnswer:
        """질문 주제(대상·기준·금액·절차·서류·문의)에 맞는 부분만 골라 답한다(LLM 없이)."""
        if not SERVICE_NAME.search(rx(r"\s+").sub("", question)) and not self._last_service:
            return replace(_ASK_SERVICE)
        s = await self._service(question)
        if not s:
            return GroundedAnswer(speech="그 제도의 공식 자료를 찾지 못했어요. 보건복지상담센터 129에 문의해 보세요.", method="none")
        self._last_service = s
        return self._topic_answer(s, question)

    def _topic_answer(self, s: dict, question: str) -> GroundedAnswer:
        parts: list[str] = []
        if rx(r"(대상|자격|누가|받을\s*수)").search(question):
            parts.append(f"지원 대상: {lines(s.get('target'), 1)}")
            threshold = next((line for line in (s.get("criteria") or "").split("\n") if rx(r"선정기준액은").search(line)), None) if s.get("criteria") else None
            if threshold:
                parts.append(threshold.strip())
        if rx(r"(선정\s*기준|소득인정액)").search(question):
            parts.append(f"선정 기준: {lines(s.get('criteria'), 3)}")
        if rx(r"(얼마|금액|지급액|급여|연금액)").search(question):
            parts.append(f"지원 내용: {lines(s['benefit'], 2)}" if s.get("benefit") else "지원 금액 정보는 이 자료에 없습니다.")
        if rx(r"(방법|절차|어디|어떻게)").search(question):
            parts.append(
                f"신청 절차: {'. '.join(a['step'] + '은 ' + a['detail'] for a in s['applySteps'])}"
                if s.get("applySteps")
                else f"신청 방법: {s['applyMethod']}"
            )
        if rx(r"(서류|서식|양식)").search(question):
            parts.append(
                f"관련 서식: {', '.join(_FORM_EXT.sub('', f['name']) for f in s['forms'])}" if s.get("forms") else "서식 정보는 이 자료에 없습니다."
            )
        if rx(r"(문의|전화|연락)").search(question):
            parts.append(
                f"문의처: {', '.join(c['name'] + ' ' + c['value'] for c in s['contacts'])}" if s.get("contacts") else "문의처 정보는 이 자료에 없습니다."
            )
        if not parts:
            parts.extend([s["summary"], f"지원 대상: {lines(s.get('target'), 1)}"])

        def end(p: str) -> str:
            p = p.strip()
            return p if rx(r"[.!?…]$").search(p) else f"{p}."

        return GroundedAnswer(
            speech=f"{' '.join(end(p) for p in parts)}{eligibility_note(question)} {source_sentence(s['source'])}",
            sources=[cite(s["source"])],
            grounded=True,
            method="topic-rule",
            service=_service_ref(s),
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
