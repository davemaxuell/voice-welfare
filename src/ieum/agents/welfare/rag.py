"""
공식 복지 데이터(API 상세조회)를 근거 조각으로 나누고, 질문과 가까운 조각을 고른다.
외부 벡터DB 없이 한국어 글자 2-gram 겹침 + 항목 키워드 가중치로 검색한다(재현 가능·설명 가능).
"""
from __future__ import annotations

from ieum.core.jsutil import I, rx

# 질문에 이 말이 있으면 해당 항목 조각을 우선한다.
SECTION_HINTS = {
    "개요": rx(r"(뭐야|무엇|어떤\s*제도|소개|목적|개요)"),
    "지원대상": rx(r"(대상|자격|누가|받을\s*수|해당|몇\s*살|나이|중증)"),
    "선정기준": rx(r"(선정|기준|소득|재산|소득인정액|기준액|자동차|직역연금|공무원)"),
    "지원내용": rx(r"(얼마|금액|지급|급여|연금액|감액|부가급여|기초급여|매월|65세)"),
    "신청절차": rx(r"(신청|절차|어디|어떻게|방법|주민센터|온라인|심사|결정)"),
    "서식": rx(r"(서류|서식|양식|동의서|신고서|첨부)"),
    "문의처": rx(r"(문의|전화|연락|상담|129)"),
    "근거법령": rx(r"(법|법령|근거|조항)"),
}

LINES_PER_CHUNK = 3
_FORM_EXT = rx(r"\.(hwpx?|pdf)$", I)


def _split_lines(text: str | None) -> list[str]:
    return [line.strip() for line in (text or "").split("\n") if len(line.strip()) > 1]


def chunk_service(s: dict) -> list[dict]:
    chunks: list[dict] = []

    def push(section: str, text: str) -> None:
        if text.strip():
            chunks.append({"id": f"{s['servId']}#{len(chunks) + 1}", "section": section, "text": text.strip()})

    def grouped(section: str, text: str | None) -> None:
        lines = _split_lines(text)
        for i in range(0, len(lines), LINES_PER_CHUNK):
            push(section, "\n".join(lines[i : i + LINES_PER_CHUNK]))

    push("개요", f"{s['servNm']}: {s['summary']}")
    grouped("지원대상", s.get("target"))
    grouped("선정기준", s.get("criteria"))
    grouped("지원내용", s.get("benefit"))
    if s.get("applySteps"):
        push("신청절차", "\n".join(f"{a['step']}: {a['detail']}" for a in s["applySteps"]))
    else:
        push("신청절차", s.get("applyMethod") or "")
    if s.get("forms"):
        push("서식", f"관련 서식: {', '.join(_FORM_EXT.sub('', f['name']) for f in s['forms'])}")
    if s.get("contacts"):
        push("문의처", f"문의처: {', '.join(c['name'] + ' ' + c['value'] for c in s['contacts'])}")
    if s.get("laws"):
        push("근거법령", f"근거 법령: {', '.join(s['laws'])}")
    return chunks


def _bigrams(text: str) -> set[str]:
    t = rx(r"[^가-힣a-zA-Z0-9]").sub("", text)
    return {t[i : i + 2] for i in range(len(t) - 1)}


def retrieve(question: str, chunks: list[dict], k: int = 3) -> list[dict]:
    """질문과 조각의 2-gram 겹침(질문 기준 재현율) + 항목 힌트 가중치."""
    q = _bigrams(question)
    scored = []
    for c in chunks:
        cb = _bigrams(c["text"])
        overlap = sum(1 for g in q if g in cb)
        lexical = overlap / len(q) if q else 0
        hint = 0.5 if SECTION_HINTS[c["section"]].search(question) else 0
        scored.append({**c, "score": lexical + hint})
    return sorted(scored, key=lambda c: -c["score"])[:k]
