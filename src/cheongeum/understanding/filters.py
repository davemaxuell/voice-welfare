"""② 말 거르기: 질문 같은 말, 부름말, 오프라인 명령의 군말, 대상이 빠진 요청. 대화 상태는 읽지도 바꾸지도 않는다."""
from __future__ import annotations

from cheongeum.core.jsutil import rx

_QUESTION_LIKE = rx(r"\?$|(뭐야|뭔가요|무엇|어떻게|왜|언제|얼마|며칠|몇|되나요|돼\?|되나|가능|해야\s*(돼|하나|해)|맞아|알려\s*줘|어때)")


def is_question_like(t: str) -> bool:
    return bool(_QUESTION_LIKE.search(t))


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
