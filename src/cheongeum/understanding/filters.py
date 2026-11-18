"""② 말 거르기: 질문 같은 말, 맞장구·부정만 한 짧은 대답, 앞의 군말, 대상이 빠진 두루뭉술한 말, 한 번에 한 여러 질문. 대화 상태는 읽지도 바꾸지도 않는다."""
from __future__ import annotations

from typing import Any, Literal

from cheongeum.core.jsutil import AbortSignal, jdumps, rx

_QUESTION_LIKE = rx(r"\?$|(뭐야|뭔가요|무엇|어떻게|왜|언제|얼마|며칠|몇|되나요|돼\?|되나|가능|해야\s*(돼|하나|해)|맞아|알려\s*줘|어때)")


def is_question_like(t: str) -> bool:
    return bool(_QUESTION_LIKE.search(t))


def short_reply_kind(text: str) -> Literal["ack", "no"] | None:
    """맞장구("알았어")만 한 말이면 "ack", 부정("아니")만 한 말이면 "no", 둘 다 아니면 None. 끝의 문장부호·공백은 무시한다."""
    t = rx(r"[.!~?,\s]+$").sub("", text).strip()
    ack = bool(
        rx(
            r"^(응\s*)?(알았어|알았어요|알겠어|알겠어요|알겠습니다|알았습니다|알았고|오케이|오키|그래|그래요|그렇구나|그렇군요|고마워|고마워요|감사합니다|네\s*알겠어요|응\s*그래)$"
        ).search(t)
    )
    no = bool(rx(r"^(아니|아니야|아니요|아뇨|아니에요|아냐|됐어|괜찮아|괜찮아요|아니\s*괜찮아)$").search(t))
    if not ack and not no:
        return None
    return "no" if no else "ack"


_ADDRESS = rx(r"^(청음(아|이야)|청음이?(?=\s*[,!.~?]))[\s,!.~?]*")


def strip_address(text: str) -> str:
    """맨 앞의 부름말을 뗀다("청음아, 화면 설명해줘" → "화면 설명해줘", 부름말만 했으면 ""). "청음이 뭐야?"처럼 이름을 말한 질문은 그대로."""
    return _ADDRESS.sub("", text, count=1).strip()


def strip_filler(text: str) -> str:
    """앞의 맞장구·군말을 뗀 말("알았고 다음으로 가줘" → "다음으로 가줘"). 떼고 남은 말이 두 글자보다 짧거나 뗄 게 없으면 그대로."""
    rest = rx(r"^((알았어|알았고|알겠어|알겠고|그래|그래서|좋아|오케이|음+|어+|아니\s*근데|아니|근데)[요,.\s]+)+").sub("", text, count=1).strip()
    return rest if len(rest) >= 2 and rest != text else text


def vague_question(text: str) -> str | None:
    """
    대상이 빠진 두루뭉술한 말은 실행하지 않고 구체적으로 되묻는다.
    (예: "열어줘" → 어느 사이트?, "검색해줘" → 무엇을?, "그거 해줘" → 무엇을?)
    """
    t = rx(r"\s+").sub(" ", rx(r"[.!?。~]+$").sub("", text)).strip()
    pron = r"(?:그거|이거|저거|그것|이것|저것|거기|여기)?\s*(?:좀\s*)?"

    def m(pattern: str) -> bool:
        return bool(rx(f"^{pron}{pattern}$").search(t))

    if m(r"(?:사이트\s*)?(?:열어|켜|띄워|들어가)\s*(?:줘|줄래|봐|주세요)?"):
        return "어느 사이트를 열까요? '네이버', '정부24'처럼 이름이나 주소를 말씀해 주세요."
    if m(r"(?:검색|찾아)\s*(?:해\s*)?(?:줘|봐|줄래|주세요)?"):
        return "무엇을 검색할까요? 찾을 내용을 말씀해 주세요."
    if m(r"(?:알려|가르쳐)\s*(?:줘|줄래|주세요)?"):
        return "무엇을 알려드릴까요? 궁금한 것을 말씀해 주세요."
    if m(r"(?:해|해\s*줘|해\s*봐|부탁해|처리해\s*줘|진행해\s*줘)"):
        return "무엇을 할까요? 예를 들어 '화면 설명해줘', '네이버 열어줘'처럼 말씀해 주세요."
    if m(r"(?:눌러|클릭해)\s*(?:줘|주세요)?"):
        return "어떤 걸 누를까요? '링크 목록 알려줘'라고 하시면 누를 수 있는 것을 읽어 드려요."
    return None


async def split_questions(llm: Any, text: str, recent: list[str], signal: AbortSignal | None) -> list[str]:
    """
    한 번에 여러 질문("기초연금은 몇 살부터고 얼마 받아? 그리고 오늘 날씨는?")을 LLM으로 나눈 것(최대 4개, 혼자 읽어도 뜻이 통하게).
    LLM이 없거나, 짧거나, 질문 낱말이 적으면 LLM을 부르지 않고 빈 목록. 명령이 섞였으면 LLM이 빈 목록을 낸다.
    """
    if not llm or len(text) < 12:
        return []
    q_words = rx(r"(뭐|무엇|무슨|어떻게|언제|얼마|며칠|몇|어느|어디|왜|누가|어때|있어|있나|되나|돼\?|인가|일까|알려)").findall(text)
    if len(q_words) < 2 and text.count("?") < 2:
        return []
    out = await llm.generate(
        system="사용자 말에 서로 다른 질문이 몇 개 있는지 보고, 각 질문을 혼자 읽어도 뜻이 통하는 한국어 질문으로 나눈다(앞 질문의 제도·사이트 이름을 뒤 질문에도 채워 넣는다). 질문이 하나뿐이거나 명령(열기·입력·누르기)이 섞였으면 questions를 빈 배열로. 최대 4개.",
        user=jdumps({"utterance": text, "recent": recent}),
        schemaName="split_questions",
        schema={
            "type": "object",
            "additionalProperties": False,
            "required": ["questions"],
            "properties": {"questions": {"type": "array", "items": {"type": "string"}}},
        },
        signal=signal,
    )
    raw = out.get("questions") if isinstance(out, dict) else None
    return [q.strip() for q in (raw or []) if isinstance(q, str) and q.strip()][:4]
