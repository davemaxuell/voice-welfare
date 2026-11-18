"""
의도 표: 음성 명령 종류마다 한 줄. 의도 모델(core/turn.py), LLM 계획의 종류 목록·설명·스키마(understanding/llm_planner.py),
동의 전 허용 목록(safety/gates.py), 도움말 예문('뭐라고 말하면 돼?')이 모두 이 표에서 나온다.
명령을 하나 더하려면 여기 한 줄, rules.py 규칙, orchestrator/session.py의 ROUTES 한 줄(새 매개변수면 llm_planner.flat_to_intent도).
빠뜨린 곳은 tests/unit/test_registry.py가 알려 준다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field

from cheongeum.core.jsutil import uniq


class Fill(BaseModel):
    """FILL 의도의 입력 하나"""

    model_config = ConfigDict(extra="ignore", strict=True)
    fieldMention: str = Field(min_length=1)
    value: str = Field(min_length=1, max_length=200)


# 도움말에서 예문을 묶어 읽는 이름(읽는 순서는 help_pages)
HelpGroup = Literal["시작", "복지 정보", "웹 읽기", "신청서", "언제든"]
HELP_GROUPS: tuple[HelpGroup, ...] = ("시작", "복지 정보", "웹 읽기", "신청서", "언제든")


@dataclass(frozen=True)
class Example:
    """예문과 그 말을 하는 세션 상태. 규칙 파서가 이 상태에서 이 줄의 종류로 이해해야 한다."""

    text: str
    state: str = "IDLE"


@dataclass(frozen=True)
class IntentSpec:
    type: str
    # LLM 계획 프롬프트의 한 줄 설명
    describe: str
    # 도움말 묶음. None이면 도움말에서 읽지 않는다. 도움말은 줄마다 첫 번째 예문을 읽는다.
    help: HelpGroup | None
    examples: tuple[Example, ...]
    # 매개변수 이름 → (타입, 기본값). 기본값이 ...이면 꼭 있어야 한다.
    params: dict[str, tuple[Any, Any]]
    # LLM 계획이 만들 수 있는가
    llm: bool
    # 동의 전에도 실행하는가(화면을 읽거나 브라우저를 쓰지 않는 것만)
    before_consent: bool


def _row(
    type_: str,
    describe: str,
    help: HelpGroup | None,
    examples: Sequence[str | tuple[str, str]],
    *,
    llm: bool = True,
    before_consent: bool = False,
    **params: tuple[Any, Any],
) -> IntentSpec:
    """예문은 "말"(IDLE에서) 또는 ("말", 세션 상태)."""
    said = tuple(Example(*e) if isinstance(e, tuple) else Example(e) for e in examples)
    return IntentSpec(type_, describe, help, said, params, llm, before_consent)


_REQ = ...
_TEXT = Annotated[str, Field(min_length=1)]
_FORM = "APPLICATION_OPEN"
_WEB = "BROWSING"
_CONFIRM = "WAITING_FOR_USER_CONFIRMATION"

# 묶음 안에서는 위에 있는 줄을 도움말에서 먼저 읽는다.
INTENTS: tuple[IntentSpec, ...] = (
    # ---- 시작
    _row(
        "OPEN_SITE",
        '특정 사이트 열기: topic에 사이트 이름이나 주소, 예 "Naver 열어줘"→네이버',
        "시작",
        ["복지로 열어줘", "정부24 들어가줘"],
        target=(_TEXT, _REQ),
    ),
    _row("START_APPLICATION", "장애인연금 신청 시작", "시작", ["장애인연금 신청 도와줘", "신청 페이지를 열어줘"]),
    _row(
        "GOAL",
        "웹에서 여러 단계를 거쳐야 하는 목표: topic에 목표 문장",
        "시작",
        ["네이버에서 오늘 뉴스 알려줘", "복지로 가서 기초연금 신청 방법 찾아줘"],
        goal=(Annotated[str, Field(min_length=2, max_length=200)], _REQ),
    ),
    _row("OPEN_BROWSER", "사이트 이름 없이 크롬·브라우저만 켜기", "시작", ["크롬 켜줘", "브라우저 열어줘"]),
    # ---- 복지 정보: 화면·브라우저를 쓰지 않아 동의 전에도
    _row(
        "POLICY_QUESTION",
        "제도 대상·절차 질문",
        "복지 정보",
        ["기초연금은 몇 살부터 받아?", "장애인연금 지원대상과 신청 절차 알려줘"],
        before_consent=True,
        topic=(str, _REQ),
    ),
    _row("DISCOVER", "나에게 맞는 복지 찾기", "복지 정보", ["나한테 맞는 복지 찾아줘", "받을 수 있는 복지 찾아줘"], before_consent=True),
    _row(
        "PRECHECK",
        "특정 제도 자격 미리 점검: topic에 제도명",
        "복지 정보",
        ["기초연금 받을 수 있는지 확인해줘", "1번 자격 확인해줘"],
        before_consent=True,
        service=(Optional[str], None),
    ),
    _row(
        "PREPARE_APPLY",
        "신청 준비·서류: topic에 제도명",
        "복지 정보",
        ["신청하려면 뭐가 필요해?", "기초연금 신청 서류 알려줘"],
        before_consent=True,
        service=(Optional[str], None),
    ),
    _row(
        "SERVICE_DETAIL",
        "찾아 드린 제도 목록 중 하나 자세히: topic에 번호(예 2번)나 제도명",
        "복지 정보",
        ["2번 자세히 알려줘", "1번 설명해줘"],
        before_consent=True,
        service=(Optional[str], None),
    ),
    _row("HELP_HUMAN", "사람 도움 요청", "복지 정보", ["상담원 연결해줘", "사람한테 도움 받고 싶어"], before_consent=True),
    # ---- 웹 읽기
    _row(
        "READ_MAIN",
        "웹 페이지 본문 읽기: 이어서 더 읽어 달라면 more=true",
        "웹 읽기",
        [("본문 읽어줘", _WEB), ("계속 읽어줘", _WEB)],
        more=(bool, _REQ),
    ),
    _row(
        "LIST_LINKS",
        "누를 수 있는 링크·메뉴 목록: 이어서 더 알려 달라면 more=true",
        "웹 읽기",
        [("링크 목록 알려줘", _WEB), ("링크 더 알려줘", _WEB)],
        more=(bool, _REQ),
    ),
    _row(
        "FOLLOW_LINK",
        "화면의 링크·메뉴·버튼 누르기: topic에 그 이름",
        "웹 읽기",
        [("공지사항 눌러줘", _WEB), ("장애인연금 안내 링크 눌러줘", _WEB)],
        name=(_TEXT, _REQ),
    ),
    _row(
        "SEARCH",
        "검색: topic에 검색어, 어느 사이트에서 찾을지 말했으면 site에 그 이름",
        "웹 읽기",
        [("기초연금 검색해줘", _WEB), ("복지로에서 기초연금 검색해줘", _WEB)],
        query=(Annotated[str, Field(min_length=1, max_length=100)], _REQ),
        site=(Optional[str], None),
    ),
    _row("PREV", "이전 단계", "웹 읽기", [("뒤로 가줘", _WEB), ("이전으로", _FORM)]),
    _row("ABOUT_SITE", "지금 연 사이트가 어떤 곳인지", "웹 읽기", [("여기 무슨 사이트야?", _WEB), ("이 사이트 뭐 하는 곳이야?", _WEB)]),
    _row("LOGIN", "로그인/본인인증", "웹 읽기", [("로그인하고 싶어", _WEB), ("로그인 페이지 열어줘", _WEB), ("다 입력했어", "AUTH_HANDOFF")]),
    _row("CLEAR_LOGIN", "로그아웃·로그인 기록 삭제", "웹 읽기", ["로그아웃해줘", "로그인 기록 지워줘"]),
    _row(
        "READ_DOWNLOAD",
        "받은 파일 읽기",
        "웹 읽기",
        ["받은 파일 읽어줘", "다운로드 읽어줘", "받은 파일 목록"],
        list=(Optional[bool], False),
    ),
    # ---- 신청서(항목 이름은 연습 사이트 어휘)
    _row(
        "FILL",
        "입력란에 값 입력",
        "신청서",
        [("이름은 김하늘", _FORM), ("주소는 부산광역시 예시구 예시로 10", _FORM)],
        fills=(Annotated[list[Fill], Field(min_length=1, max_length=5)], _REQ),
    ),
    _row("NEXT", "다음 단계", "신청서", [("다음으로", _FORM), ("다음 단계로 넘어가줘", _FORM)]),
    _row("READ_FIELD", "항목 값 다시 읽기", "신청서", [("주소 다시 읽어줘", _FORM), ("이름 뭐였지?", _FORM)], fieldMention=(_TEXT, _REQ)),
    _row("REVIEW", "입력 내용 전체 읽기", "신청서", [("지금까지 쓴 내용 읽어줘", _FORM), ("입력한 내용 전체 읽어줘", _FORM)]),
    _row(
        "EXPLAIN",
        "항목 뜻 설명",
        "신청서",
        [("이 항목은 무슨 뜻이야?", _FORM), ("가구원 수가 무슨 뜻이야?", _FORM)],
        fieldMention=(Optional[str], None),
    ),
    _row("EDIT_FIELD", "항목 수정 의사, 값 없음", "신청서", [("주소 수정할게", _FORM), ("이름 고칠래", _FORM)], fieldMention=(_TEXT, _REQ)),
    _row("CURRENT_STEP", "현재 단계 안내", "신청서", [("지금 어느 단계야?", _FORM), ("현재 단계 알려줘", _FORM)]),
    _row("PREPARE_SUBMIT", "제출/접수 준비", "신청서", [("최종 확인할게", _FORM), ("모의 접수 내용을 확인했어", _FORM)]),
    # ---- 언제든
    _row("STOP", "즉시 멈춤", "언제든", ["멈춰", "그만"], llm=False, before_consent=True),
    # 멈춤처럼 턴 대기열 앞에서 규칙으로 바로 답한다(일하는 중에도). 그래서 LLM 계획에는 넣지 않는다.
    _row("PROGRESS", "하고 있는 일이 어디까지 왔는지 묻기", "언제든", ["지금 어디까지 했어?", "얼마나 남았어?"], llm=False, before_consent=True),
    _row("DESCRIBE_SCREEN", "화면 전체 설명", "언제든", ["화면 설명해줘", "지금 화면에 뭐가 있어?"]),
    _row("REPHRASE", "방금 들은 안내를 쉬운 말로 다시", "언제든", ["쉽게 말해줘", "무슨 말이야?"]),
    _row("RESUME", "다시 시작", "언제든", [("다시 시작", "STOPPED"), "계속 진행해"]),
    # ---- 도움말에서 읽지 않는 것: 필요한 순간에 그 자리에서 알려 주는 대답(승인·거절·인증 마침), 도움말 자신, 못 알아들음
    _row("APPROVE", "실행 직전 승인", None, [("모의접수 승인", _CONFIRM), ("응", _CONFIRM)], llm=False),
    _row("REJECT", "접수 거절", None, [("승인 안 해", _CONFIRM), ("아니", _CONFIRM)]),
    _row("AUTH_DONE", "인증 마침", None, [("인증 끝났어", "AUTH_HANDOFF"), ("다 했어", "AUTH_HANDOFF"), ("로그인 완료했어", "AUTH_HANDOFF")]),
    _row(
        "WHAT_CAN_I_SAY",
        "할 수 있는 말(도움말) 안내: 다른 말도 더 알려 달라면 more=true",
        None,
        ["뭐라고 말하면 돼?", "뭘 할 수 있어?", "도움말", "사용법 알려줘", "명령어 알려줘", "다른 말도 알려줘", "도움말 더"],
        before_consent=True,
        more=(bool, False),
    ),
    _row("UNKNOWN", "그 외/불확실", None, ["오늘 날씨 어때", "블라블라"], text=(str, _REQ)),
)


def help_pages(lead: Sequence[HelpGroup], consented: bool) -> list[list[tuple[HelpGroup, list[str]]]]:
    """
    도움말 전체를 한 번에 들려줄 분량(쪽)으로 나눈 것. 쪽마다 묶음 최대 세 개, 묶음마다 줄의 첫 예문 두 개.
    화면에 맞는 묶음(lead)이 예문이 남은 동안 매 쪽 앞에 서고, 남은 자리는 다른 묶음이 돌아가며('언제든' 먼저) 채운다.
    동의 전이면 동의 전에 할 수 있는 것만.
    """
    left: dict[HelpGroup, list[list[str]]] = {}
    for group in HELP_GROUPS:
        texts = [i.examples[0].text for i in INTENTS if i.help == group and (consented or i.before_consent)]
        left[group] = [texts[k : k + 2] for k in range(0, len(texts), 2)]
    others: list[HelpGroup] = [g for g in uniq(["언제든", *HELP_GROUPS]) if g not in lead]
    pages: list[list[tuple[HelpGroup, list[str]]]] = []
    while any(left.values()):
        groups = [g for g in [*lead, *others] if left[g]][:3]
        pages.append([(g, left[g].pop(0)) for g in groups])
        # 이번 쪽에 읽은 묶음은 뒤로: 다음 쪽은 못 읽은 묶음부터
        others = [g for g in others if g not in groups] + [g for g in others if g in groups]
    return pages
