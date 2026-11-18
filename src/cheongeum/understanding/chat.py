"""② 화면 밖 자유 대화: LLM이 처리 방식(route)을 고르고 답·검색어·언어를 낸다. 고른 뒤의 처리는 오케스트레이터가 한다."""
from __future__ import annotations

from typing import Any

from cheongeum.core.jsutil import jdumps


async def chat_route(llm: Any, text: str, *, page: str | None, last_assistant: str | None, recent: list[str], asked_just_now: bool) -> dict:
    """LLM이 고른 처리 방식과 답 {'route', 'reply', 'searchQuery', 'language'}. 답하지 못하면 빈 dict."""
    # 같은 되묻기를 연달아 하지 않는다: 직전에 되물었으면 이번에는 가장 그럴듯한 뜻으로 처리한다.
    routes = ["welfare", "web_search", "web_task", "general", "language", *([] if asked_just_now else ["clarify"])]
    out = await llm.generate(
        system="""너는 시각장애인을 돕는 음성 도우미 '청음'이다. 사용자 말에 맞는 처리 방식을 고르고 답한다.
먼저 대화 맥락을 본다: lastAssistant가 질문(선택지·번호 포함)이었고 사용자 말이 그 대답(예: "1번", "네", "맞아", 선택지 이름)이면, 그 선택이 뜻하는 일을 처리한다. 같은 질문을 다시 하지 않는다.
사용자 말은 음성 받아쓰기라 오타·발음 비슷한 낱말이 섞일 수 있다(예: "프리즈 코리안" = "Please Korean"). 소리가 비슷한 뜻으로 너그럽게 해석한다.
- language: 대화 언어를 바꿔 달라는 말(예: "Please English", "영어로", "일본어로 해줘", "한국말로"). language에 ko/en/zh/ja. 화면·사이트 언어를 묻지 말고 대화 언어로 본다.
- welfare: 특정 복지 제도·급여·신청·자격·지급에 대한 질문(제도 이름이 없고 이전 대화로도 알 수 없으면 clarify)
- web_search: 날씨·영업시간처럼 검색 한 번이면 되는 실시간 정보 질문. searchQuery에 검색어
- web_task: 특정 사이트에서 여러 단계로 찾아봐야 하는 목표(예: "OO 사이트에서 공지 찾아줘", "뉴스 주요 기사 알려줘")
- general: 일반 상식·인사·잡담. reply에 핵심만 1~2문장 쉬운 존댓말(모르면 모른다고, 지어내지 말 것, 묻지 않은 정보·특정 사이트 홍보 금지)
- clarify: 대상이 빠졌거나 두 가지 이상으로 해석될 수 있음. 추측하지 말고 reply에 구체적인 되묻기(가능하면 선택지 2~3개)
비밀번호·주민등록번호 등은 요구하지 않는다. 수급 자격을 판정하지 않는다.""",
        user=jdumps({"utterance": text, "page": page, "lastAssistant": last_assistant, "recent": recent}),
        schemaName="chat_route",
        schema={
            "type": "object",
            "additionalProperties": False,
            "required": ["route", "reply", "searchQuery", "language"],
            "properties": {
                "route": {"type": "string", "enum": routes},
                "reply": {"type": "string"},
                "searchQuery": {"type": ["string", "null"]},
                "language": {"type": ["string", "null"], "enum": ["ko", "en", "zh", "ja", None]},
            },
        },
    )
    return out if isinstance(out, dict) else {}
