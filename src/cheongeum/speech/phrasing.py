"""⑥ 접근 가능한 출력: 음성으로 읽기 좋은 문장 조각(조사, 라벨, 날짜, 끊어 읽기, 되읽기)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cheongeum.core.jsutil import I, rx
from cheongeum.safety.privacy import mask_value

if TYPE_CHECKING:
    from cheongeum.agents.web.profile import FieldProfile

READ_CHUNK = 350

_TAIL = rx(r"""[\s)）'"’”]+$""")


def josa(word: str, with_batchim: str, without: str) -> str:
    """받침 유무로 조사 선택: 성명을/주소를, 성명은/주소는 (음성으로 읽을 때 "을(를)"이 어색하므로)"""
    last = _TAIL.sub("", word, count=1)[-1:]
    if not last:
        return f"{word}{without}"
    # 숫자는 읽는 소리 기준: 영·일·삼·육·칠·팔은 받침 있음, 이·사·오·구는 없음
    if rx(r"[0-9]").search(last):
        return f"{word}{with_batchim if last in '013678' else without}"
    code = ord(last) - 0xAC00
    if code < 0 or code > 11171:
        return f"{word}{with_batchim if rx(r'[LMNR]$', I).search(last) else without}"
    return f"{word}{with_batchim if code % 28 else without}"


def speak_call_name(name: str) -> str:
    """부르는 이름 + 님('길동님'처럼 이미 붙었으면 그대로)."""
    return name if name.endswith("님") else f"{name}님"


def speak_label(label: str) -> str:
    return rx(r"\s*\(선택\)$").sub("", label)


def speak_date(date_str: str) -> str:
    _, m, d = (int(x) for x in date_str.split("-"))
    return f"{m}월 {d}일"


def chunk_text(text: str, offset: int, size: int = READ_CHUNK) -> str:
    """본문을 문장 경계에서 끊어 일부만."""
    if offset >= len(text):
        return ""
    end = min(len(text), offset + size)
    if end < len(text):
        m = rx(r"[.!?。]\s[^.!?。]*$|다\.\s[^.]*$").search(text[offset:end])
        cut = m.start() if m else -1
        if cut > size * 0.5:
            end = offset + cut + 2
    return text[offset:end].strip()


# 전화번호: 지역번호 붙은 번호, 1588-1234 같은 대표번호(언제나), 1355·129 같은 국번 없는 번호(아래 조건일 때만)
_FULL_PHONE = rx(r"(?<![\d.:,\-])(?:0\d{1,2}[-.)\s]?\d{3,4}[-.\s]?\d{4}|1\d{3}[-\s]\d{4})(?!\d|,\d|\.\d|\s*[년월일생])")
# 국번 없는 번호는 뒤에 조사·문장부호·끝이 올 때만(100분의, 120시간, 100 만원, 100 이하, 120가구, 제102조, 1955-03-02는 아님)
_BARE_PHONE = rx(
    r"(?<![\d.:,\-])1\d{2,3}(?=[\s,.!?)(~]|$|[이가은는을를로으에와과도요번예입])"
    r"(?!\s*(?:[\d만천억원명세년월일개분시초%조항호층]|이하|이상|초과|미만|가구|곳))(?!\d|,\d|\.\d)"
)
# 그리고 바로 앞에 전화번호라는 단서가 있을 때만: "고객센터는 1355", "상담 번호는 국번없이 129", "문의는 129로".
# '센터 이용 정원은 100'처럼 단서가 떨어져 있으면 금액·인원·기준값일 수 있다.
_CUE_BEFORE = rx(r"(번호|전화|국번\s*없이|센터|문의|연락처|☎)\s*(?:는|은|:|번호는|번호)?\s*(?:국번\s*없이\s*)?$")


def _spell(m: Any) -> str:
    return ", ".join(" ".join(g) for g in rx(r"\d+").findall(m.group(0)))


def _bare_phones(text: str) -> list[Any]:
    return [m for m in _BARE_PHONE.finditer(text) if _CUE_BEFORE.search(text[: m.start()])]


def has_phone_number(sentence: str) -> bool:
    return bool(_FULL_PHONE.search(sentence) or _bare_phones(sentence))


def spell_phone_numbers(text: str) -> str:
    """전화번호를 한 자리씩 끊어 읽게: '1355' → '1 3 5 5', '051-709-4657' → '0 5 1, 7 0 9, 4 6 5 7'. 금액·기준값은 그대로."""
    spelled = _FULL_PHONE.sub(_spell, text)
    for m in reversed(_bare_phones(spelled)):
        spelled = f"{spelled[: m.start()]}{_spell(m)}{spelled[m.end():]}"
    return spelled


def readback(field_: FieldProfile, value: str) -> str:
    return mask_value(value) if field_.mask_on_readback and value else value
