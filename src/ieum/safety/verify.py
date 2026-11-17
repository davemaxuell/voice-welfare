"""
검증 담당(Verifier, Agent A·B 공통): 사용자에게 말하기 전에 답이 근거(화면 글·공식 자료)에 실제로 있는지 확인한다.
LLM을 한 번 더 부르지 않는 규칙 검사라 지연이 거의 없다.
 1) 인용 확인: 답과 함께 받은 근거 문장(evidence)이 원문에 실제로 있는지(띄어쓰기·문장부호·사소한 차이는 허용)
 2) 숫자 확인: 답에 나온 금액·나이·날짜·전화번호 등이 근거나 질문에 있는지(30만 원 = 300,000원처럼 단위 환산)
실패하면 호출자가 다시 시키거나 "확인하지 못했다"고 정직하게 말한다.
"""
from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from ieum.core.jsutil import I, js_round, rx, uniq


@dataclass
class GroundingCheck:
    ok: bool
    # 실패 이유(짧은 한국어, trace·재시도 안내용)
    reasons: list[str] = field(default_factory=list)
    # 원문에서 확인된 인용
    matchedQuotes: list[str] = field(default_factory=list)
    # 근거에 없는 숫자
    unsupportedNumbers: list[str] = field(default_factory=list)


_NORM = rx(r"""[\s"'“”‘’`.,!?;:·…()\[\]{}<>「」『』〈〉《》\-–—~/\\|]+""")


def normalize_for_match(s: str) -> str:
    """비교용 정규화: 공백·문장부호·따옴표를 없애고 소문자로."""
    return _NORM.sub("", unicodedata.normalize("NFC", s).lower())


def _bigrams(s: str) -> list[str]:
    return [s[i : i + 2] for i in range(len(s) - 1)]


def quote_in_source(quote: str, source: str) -> bool:
    """인용이 원문에 있는지. 정확히 들어 있거나, 같은 길이 구간과 2-gram이 85% 이상 겹치면 인정한다(조사·어미 차이 허용)."""
    q = normalize_for_match(quote)
    src = normalize_for_match(source)
    if len(q) < 4:
        return False  # 너무 짧은 인용은 아무 데나 맞아서 근거가 못 된다
    if q in src:
        return True
    qb = _bigrams(q)
    if not qb or len(src) < len(q) * 0.7:
        return False
    # 인용의 앞 2-gram이 나오는 위치 주변 구간들과 비교(전 구간 슬라이딩보다 싸다)
    anchors: dict[int, None] = {}
    for g in qb[:6]:
        frm = 0
        for _ in range(20):
            at = src.find(g, frm)
            if at < 0:
                break
            anchors[max(0, at - 4)] = None
            frm = at + 1
    for start in anchors:
        win = src[start : start + math.ceil(len(q) * 1.2)]
        wb: dict[str, int] = {}
        for g in _bigrams(win):
            wb[g] = wb.get(g, 0) + 1
        hit = 0
        for g in qb:
            n = wb.get(g, 0)
            if n > 0:
                hit += 1
                wb[g] = n - 1
        if hit / len(qb) >= 0.85:
            return True
    return False


UNIT: dict[str, float] = {
    "천": 1e3,
    "만": 1e4,
    "억": 1e8,
    "조": 1e12,
    # 중국어·일본어(번역 검증용)
    "千": 1e3,
    "万": 1e4,
    "萬": 1e4,
    "亿": 1e8,
    "億": 1e8,
    "兆": 1e12,
    # 영어
    "thousand": 1e3,
    "million": 1e6,
    "billion": 1e9,
}

_CODE_RE = rx(r"\d+(?:[-.]\d+){1,}")
_THOUSANDS = rx(r"^\d{1,3}(?:,\d{3})+$")
_DECIMAL = rx(r"^\d+\.\d+$")
_NUM_RE = rx(r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(조|억|천만|백만|만|천|千万|千萬|万|萬|亿|億|兆|千|thousand|million|billion)?", I)


@dataclass
class Numbers:
    values: set[float]
    codes: dict[str, None]  # 순서 있는 집합
    raw: list[str]


def _num(s: str) -> float:
    return float(s)


def extract_numbers(text: str) -> Numbers:
    """
    글 속 숫자를 값으로 모은다. "30만 원" → 300000, "300,000원" → 300000, "1억 2천만" → 120000000,
    "1588-1234"·"2025.1.1" 같은 묶음은 자리 숫자 그대로(문자열) 비교한다.
    """
    values: set[float] = set()
    codes: dict[str, None] = {}
    raw: list[str] = []
    # 전화번호·날짜 같은 묶음(숫자-숫자, 숫자.숫자.숫자)
    for m in _CODE_RE.finditer(text):
        s = m.group(0)
        if _THOUSANDS.search(s) or _DECIMAL.search(s):
            continue
        codes[rx(r"\D").sub("", s)] = None
        raw.append(s)
        for part in rx(r"[-.]").split(s):
            values.add(_num(part) if part else 0.0)  # "2025.1.1" ↔ "2025년 1월 1일"

    def keep(m) -> str:
        s = m.group(0)
        return s if (_THOUSANDS.search(s) or _DECIMAL.search(s)) else " "

    rest = _CODE_RE.sub(keep, text)
    # 숫자 + (천|만|억|조) 조합: "1억 2천만", "30만", "3.5만"
    state = {"total": 0.0, "chain": ""}

    def flush() -> None:
        if state["chain"]:
            values.add(float(js_round(state["total"])))
            raw.append(state["chain"].strip())
        state["total"] = 0.0
        state["chain"] = ""

    last_end = -1
    for m in _NUM_RE.finditer(rest):
        n = _num(m.group(1).replace(",", ""))
        unit = m.group(2)
        gap = rest[last_end : m.start()] if last_end >= 0 else ""
        # "1억 2천만"처럼 큰 단위 뒤에 바로 이어지면 한 값으로 합친다
        if not (state["chain"] and rx(r"^\s*$").search(gap) and unit):
            flush()
        if unit:
            u = unit.lower()
            mult = 1e7 if u in ("천만", "千万", "千萬") else 1e6 if u == "백만" else UNIT[u]
            state["total"] += n * mult
            values.add(n)  # "30만"이라고 쓴 근거와 "30만"이라고 답한 경우도 맞도록 숫자 자체도 둔다
        else:
            state["total"] += n
        state["chain"] += m.group(0)
        last_end = m.end()
        if not unit:
            flush()
    flush()
    return Numbers(values=values, codes=codes, raw=raw)


def unsupported_numbers(answer: str, sources: Sequence[str]) -> list[str]:
    """답의 숫자 중 근거(또는 허용 글)에 없는 것. 1~2 같은 작은 서수·개수는 말 흐름에 흔해 검사하지 않는다."""
    src = extract_numbers("\n".join(sources))
    ans = extract_numbers(answer)
    missing: list[str] = []
    for code in ans.codes:
        if code not in src.codes:
            missing.append(code)
    for r in ans.raw:
        if "-" in r or rx(r"\d+\.\d+\.\d+").search(r):
            continue  # 묶음은 위에서 확인
        one = extract_numbers(r).values
        supported = any(v in src.values for v in one)
        small = all(v <= 10 for v in one)
        if not supported and not small:
            missing.append(r)
    return uniq(missing)


def check_grounding(
    answer: str,
    sources: Sequence[str],
    quotes: Iterable[str] | None = None,
    allowed: Sequence[str] | None = None,
    min_quotes: int = 1,
) -> GroundingCheck:
    reasons: list[str] = []
    qs = [q.strip() for q in (quotes or []) if isinstance(q, str) and q.strip()]
    matched = [q for q in qs if any(quote_in_source(q, s) for s in sources)]
    if min_quotes > 0 and len(matched) < min_quotes:
        reasons.append("근거로 든 문장이 원문에 없음" if qs else "근거 문장이 없음")
    unsupported = unsupported_numbers(answer, [*sources, *(allowed or [])])
    if unsupported:
        reasons.append(f"근거에 없는 숫자: {', '.join(unsupported)}")
    return GroundingCheck(ok=not reasons, reasons=reasons, matchedQuotes=matched, unsupportedNumbers=unsupported)
