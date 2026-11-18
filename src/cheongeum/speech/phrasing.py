"""⑥ 접근 가능한 출력: 음성으로 읽기 좋은 문장 조각(조사, 라벨, 날짜, 끊어 읽기, 되읽기)."""

from __future__ import annotations

from typing import TYPE_CHECKING

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


def readback(field_: FieldProfile, value: str) -> str:
    return mask_value(value) if field_.mask_on_readback and value else value
