"""
맞춤 복지 찾기: "받을 수 있는데 몰라서 못 받는 복지"를 찾는다.
사용자 답(나이·장애·소득·지역)은 이번 대화에서만 쓰고 저장하지 않는다.
목록 필터·순위는 규칙 기반(빠르고 재현 가능). 자격 판정은 하지 않는다.

UserProfile은 dict: age(int, -1=말하지 않음) · disability('severe'|'mild'|'yes'|'no'|'unknown') ·
income('basic'|'near-poor'|'low'|'normal'|'unknown') · ctpv(str 또는 None=건너뜀) · singleParent · manyChildren ·
veteran · multicultural · living('alone'|'family'). 키가 없으면 아직 모름.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import cmp_to_key

from ieum.core.jsutil import rx

PROFILE_ORDER = ["age", "disability", "income", "ctpv"]

PROFILE_QUESTIONS = {
    "age": "나이가 어떻게 되세요?",
    "disability": "장애가 있으신가요? 있다면 심한 장애인지도 말씀해 주세요.",
    "income": "기초생활수급자나 차상위계층이신가요? 잘 모르시면 '모름'이라고 하셔도 돼요.",
    "ctpv": "사시는 시·도를 알려 주시면 지역 복지도 함께 찾아볼게요. 건너뛰려면 '건너뛰기'라고 해 주세요.",
}

CTPV = {
    "서울": "서울특별시",
    "부산": "부산광역시",
    "대구": "대구광역시",
    "인천": "인천광역시",
    "광주": "광주광역시",
    "대전": "대전광역시",
    "울산": "울산광역시",
    "세종": "세종특별자치시",
    "경기": "경기도",
    "강원": "강원특별자치도",
    "충북": "충청북도",
    "충청북": "충청북도",
    "충남": "충청남도",
    "충청남": "충청남도",
    "전북": "전북특별자치도",
    "전라북": "전북특별자치도",
    "전남": "전라남도",
    "전라남": "전라남도",
    "경북": "경상북도",
    "경상북": "경상북도",
    "경남": "경상남도",
    "경상남": "경상남도",
    "제주": "제주특별자치도",
}

TENS = {"열": 10, "스물": 20, "스무": 20, "서른": 30, "마흔": 40, "쉰": 50, "예순": 60, "일흔": 70, "여든": 80, "아흔": 90}
ONES = {"한": 1, "하나": 1, "두": 2, "둘": 2, "세": 3, "셋": 3, "네": 4, "넷": 4, "다섯": 5, "여섯": 6, "일곱": 7, "여덟": 8, "아홉": 9}

_B = r"(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))"


def _parse_age(t: str) -> int | None:
    d = rx(r"(?:만\s*)?(\d{1,3})\s*(?:살|세)").search(t) or rx(r"(?:나이는?|만)\s*(\d{1,3})" + _B).search(t)
    if d:
        return int(d.group(1))
    k = rx(r"(열|스물|스무|서른|마흔|쉰|예순|일흔|여든|아흔)\s*(한|하나|두|둘|세|셋|네|넷|다섯|여섯|일곱|여덟|아홉)?\s*살").search(t)
    if k:
        return TENS[k.group(1)] + (ONES[k.group(2)] if k.group(2) else 0)
    return None


SKIP = rx(r"^(모름|몰라|모르겠|잘\s*모르|건너\s*뛰|건너\s*뛸|패스|넘어가|넘길|다음|없어요?$|말\s*안\s*할래|말하기\s*싫)")


def parse_profile_answer(text: str, asking: str | None = None) -> dict:
    """
    답에서 알아들을 수 있는 정보를 모두 뽑는다(한 번에 여러 개 말해도 됨).
    asking: 지금 물어본 항목 — "네/없어/모름" 같은 짧은 답을 그 항목에 적용한다.
    """
    # 말 앞의 군말("음", "어", "그러니까")은 빼고 본다: "음 맞아" → "맞아"
    t = rx(r"\s+").sub(" ", text).strip()
    t = rx(r"^((음+|어+|아+|에+|그+|저기|그러니까|그니까|글쎄)[,.\s]+)+").sub("", t, count=1).strip()
    out: dict = {}
    age = _parse_age(t)
    if age is not None and 0 <= age <= 120:
        out["age"] = age

    if rx(r"장애").search(t):
        if rx(r"(없|아니)").search(t):
            out["disability"] = "no"
        elif rx(r"(심한|중증|1급|2급|3급|심해)").search(t) and not rx(r"심하지\s*않").search(t):
            out["disability"] = "severe"
        elif rx(r"(심하지\s*않|경증|가벼|4급|5급|6급)").search(t):
            out["disability"] = "mild"
        else:
            out["disability"] = "yes"
    if rx(r"(기초\s*생활|수급자|생계\s*급여|의료\s*급여)").search(t):
        out["income"] = "basic"
    elif rx(r"차상위").search(t):
        out["income"] = "near-poor"
    elif rx(r"(소득이?\s*(적|낮|없|거의)|형편이?\s*어려|저소득)").search(t):
        out["income"] = "low"
    elif rx(r"(해당\s*안|아니에?요?|보통|일반|평범|직장\s*다녀)").search(t) and asking == "income":
        out["income"] = "normal"

    region = rx(r"(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청북|충북|충청남|충남|전라북|전북|전라남|전남|경상북|경북|경상남|경남|제주)").search(t)
    if region:
        out["ctpv"] = CTPV[region.group(1)]

    if rx(r"(한부모|조손)").search(t):
        out["singleParent"] = True
    if rx(r"(자녀|아이|애)\s*(가\s*)?(셋|넷|다섯|3명|4명|여러)").search(t) or rx(r"다자녀").search(t):
        out["manyChildren"] = True
    if rx(r"(보훈|국가\s*유공)").search(t):
        out["veteran"] = True
    if rx(r"(다문화|탈북|북한이탈)").search(t):
        out["multicultural"] = True
    if rx(r"(혼자|1인|독거)").search(t):
        out["living"] = "alone"

    # 지금 물어본 항목에 대한 짧은 답
    skip = bool(SKIP.search(t))
    if asking == "disability" and "disability" not in out:
        if rx(r"^(네|예|응|맞아|그래|있어|있습니다|있어요)").search(t):
            out["disability"] = "yes"
        elif rx(r"^(아니|없)").search(t):
            out["disability"] = "no"
        elif skip:
            out["disability"] = "unknown"
    if asking == "income" and "income" not in out:
        if rx(r"^(네|예|응|맞아|맞습니다|맞아요|그래|그렇|해당돼)").search(t):
            out["income"] = "low"
        elif rx(r"^(아니)").search(t):
            out["income"] = "normal"
        elif skip:
            out["income"] = "unknown"
    if asking == "ctpv" and "ctpv" not in out and skip:
        out["ctpv"] = None
    if asking == "age" and "age" not in out and skip:
        out["age"] = -1  # 말하지 않음
    return out


def next_profile_slot(p: dict) -> str | None:
    return next((s for s in PROFILE_ORDER if s not in p), None)


def life_stage_of(age: int | None) -> str | None:
    if age is None or age < 0:
        return None
    if age < 6:
        return "영유아"
    if age < 13:
        return "아동"
    if age < 19:
        return "청소년"
    if age < 35:
        return "청년"
    if age < 65:
        return "중장년"
    return "노년"


def targets_of(p: dict) -> list[str]:
    t: list[str] = []
    if p.get("disability") and p["disability"] not in ("no", "unknown"):
        t.append("장애인")
    if p.get("income") in ("basic", "near-poor", "low"):
        t.append("저소득")
    if p.get("singleParent"):
        t.append("한부모·조손")
    if p.get("manyChildren"):
        t.append("다자녀")
    if p.get("veteran"):
        t.append("보훈대상자")
    if p.get("multicultural"):
        t.append("다문화·탈북민")
    return t


@dataclass
class Match:
    service: dict
    score: float
    # 왜 골랐는지(사용자에게 말해 줄 이유)
    reasons: list[str] = field(default_factory=list)


def _locale_compare(a: str, b: str) -> int:
    return (a > b) - (a < b)


def match_services(catalog: list[dict], p: dict) -> list[Match]:
    """
    규칙 기반 맞춤 순위:
     - 나이를 알면 생애주기가 안 맞는 서비스는 뺀다(생애주기 정보가 없는 서비스는 남김)
     - 대상이 정해진 서비스(장애인·저소득 등)는 사용자와 겹칠 때만 남긴다
     - 겹치는 대상 수 > 생애주기 일치 > 지역 서비스 > 온라인 신청 가능 순으로 점수
    """
    stage = life_stage_of(p.get("age"))
    mine = targets_of(p)
    seen: set[str] = set()
    out: list[Match] = []
    for s in catalog:
        if s["servNm"] in seen:
            continue
        if stage and s["lifeStages"] and stage not in s["lifeStages"]:
            continue
        overlap = [t for t in s["targets"] if t in mine]
        if s["targets"] and not overlap:
            continue
        if not s["targets"] and not mine and not stage:
            continue  # 정보가 없으면 너무 넓다
        reasons = list(overlap)
        score = len(overlap) * 2.0
        text = f"{s['servNm']} {s['summary']}"
        # 그 집단을 위한 제도(이름에 집단이 드러남)를 앞으로: 장애인연금·중증장애인 교통비 등
        if "장애인" in mine and rx(r"장애").search(s["servNm"]):
            score += 3
        if "저소득" in mine and rx(r"(저소득|기초|생계|차상위|수급)").search(s["servNm"]):
            score += 1.5
        # 장애 정도가 어긋나는 제도는 뒤로(심한 장애인데 경증 대상, 또는 그 반대)
        if p.get("disability") == "severe" and rx(r"경증").search(text) and not rx(r"중증").search(s["servNm"]):
            score -= 3
        if p.get("disability") == "mild" and rx(r"중증").search(s["servNm"]):
            score -= 3
        # 정기적인 현금 지원을 앞으로
        if s.get("provision") == "현금지급":
            score += 1
        if s.get("cycle") == "월":
            score += 0.5
        if "생활지원" in s["themes"]:
            score += 0.5
        if stage and stage in s["lifeStages"]:
            score += 0.5
            reasons.append(stage)
        if s["provider"] == "local":
            score += 0.5
            region = s.get("region") or {}
            reasons.append(f"{region.get('sgg') or region.get('ctpv')} 지역")
        if s.get("onlineApply"):
            score += 0.5
        if not s["targets"]:
            score -= 1  # 누구나 대상인 일반 서비스는 뒤로
        seen.add(s["servNm"])
        out.append(Match(service=s, score=score, reasons=reasons))

    def cmp(a: Match, b: Match) -> int:
        if b.score != a.score:
            return 1 if b.score > a.score else -1
        return _locale_compare(a.service["servNm"], b.service["servNm"])

    return sorted(out, key=cmp_to_key(cmp))


def describe_profile(p: dict) -> str:
    parts: list[str] = []
    if p.get("age") is not None and p["age"] >= 0:
        parts.append(f"{p['age']}세")
    d = p.get("disability")
    if d == "severe":
        parts.append("심한 장애")
    elif d == "mild":
        parts.append("심하지 않은 장애")
    elif d == "yes":
        parts.append("장애 있음")
    inc = p.get("income")
    if inc == "basic":
        parts.append("기초생활수급")
    elif inc == "near-poor":
        parts.append("차상위")
    elif inc == "low":
        parts.append("소득 낮음")
    if p.get("ctpv"):
        parts.append(p["ctpv"])
    return ", ".join(parts)
