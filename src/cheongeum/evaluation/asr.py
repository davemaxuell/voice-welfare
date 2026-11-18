"""받아쓰기 평가 지표: 글자 오류율(CER)과 숫자 덩어리(전화번호·생년월일 등) 뽑기. scripts/eval_stt.py가 쓴다."""
from __future__ import annotations

from cheongeum.core.jsutil import rx
from cheongeum.safety.privacy import spoken_digit_spans
from cheongeum.safety.verify import normalize_for_match


def _edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(ref: str, hyp: str) -> float:
    """글자 오류율. 띄어쓰기·문장부호·대소문자는 무시한다(받아쓰기 모델마다 다르게 적으므로)."""
    r, h = normalize_for_match(ref), normalize_for_match(hyp)
    if not r:
        return 0.0 if not h else 1.0
    return _edit_distance(r, h) / len(r)


def digit_runs(text: str) -> list[str]:
    """숫자 덩어리(구분자 무시). 한글로 읽은 숫자("공일공 일이삼사")도 숫자로 바꿔 본다."""
    out = text
    for s, e, digits in sorted(spoken_digit_spans(text), reverse=True):
        out = f"{out[:s]}{digits}{out[e:]}"
    return [rx(r"[\s\-]").sub("", m.group()) for m in rx(r"\d(?:[\d\s\-]*\d)?").finditer(out)]


def has_spelled_numbers(text: str) -> bool:
    """숫자를 한글 낱말로 적었는지(“공일공 일이삼사”). 입력 칸에는 숫자로 적힌 쪽이 맞다."""
    return bool(spoken_digit_spans(text))
