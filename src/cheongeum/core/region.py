"""시·도 별칭과 사용자가 말한 지역. '광주시'는 경기도의 시 이름으로 보존한다."""
from __future__ import annotations

import re
from dataclasses import dataclass


CTPV = {
    "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시", "인천": "인천광역시",
    "광주": "광주광역시", "대전": "대전광역시", "울산": "울산광역시", "세종": "세종특별자치시",
    "경기": "경기도", "강원": "강원특별자치도", "강원도": "강원특별자치도",
    "충북": "충청북도", "충청북": "충청북도", "충남": "충청남도", "충청남": "충청남도",
    "전북": "전북특별자치도", "전라북": "전북특별자치도", "전라북도": "전북특별자치도",
    "전남": "전라남도", "전라남": "전라남도", "경북": "경상북도", "경상북": "경상북도",
    "경남": "경상남도", "경상남": "경상남도", "제주": "제주특별자치도",
    "전남광주통합특별시": "전남광주통합특별시",
}
_PROVINCES = {**CTPV, **{v: v for v in CTPV.values()}}
_PROVINCES.update({s + "시": CTPV[s] for s in ("서울", "부산", "대구", "인천", "대전", "울산", "세종")})
_PROVINCES["제주도"] = CTPV["제주"]
_PARTICLE = re.compile(r"(?:입니다|이에요|예요|에요|이요|이야|이고|인데|에서요?|에는|으로|에|의|은|는|요)$")
_AREA = re.compile(r"[가-힣\d·.ㆍ,]+(?:시|군|구|읍|면|동|가)$")
_NUMBERS = dict(zip("일이삼사오육칠팔구", "123456789"))


@dataclass(frozen=True)
class RegionMention:
    province: str = ""
    districts: tuple[str, ...] = ()
    dong: str = ""

    def __bool__(self):
        return bool(self.province or self.districts or self.dong)


def province_name(name: str) -> str:
    return _PROVINCES.get(name, "")


def parse_region_mention(text: str, *, bare: bool = False) -> RegionMention:
    province = dong = ""
    districts = []
    for raw in text.split():
        token = _PARTICLE.sub("", raw.strip(".,!?…。:;"))
        canonical = province_name(token)
        if canonical:
            province = canonical
        elif _AREA.fullmatch(token) and token not in ("누구", "어디가", "동네", "있는가", "이동", "지금가", "혹시", "혹시나", "어느", "어디로") and not token.endswith(("하면", "려면")):
            if token.endswith(("시", "군", "구")):
                districts.append(token)
            else:
                dong = token
        elif bare:
            return RegionMention()
    return RegionMention(province, tuple(districts), dong)


def district_after_province(text: str) -> str:
    """'부산 사상구'처럼 시·도 바로 뒤에 말한 시·군·구. '1인 가구'의 '가구'처럼 홀로 나온 말은 사는 곳으로 보지 않는다."""
    tokens = [_PARTICLE.sub("", raw.strip(".,!?…。:;")) for raw in text.split()]
    for before, token in zip(tokens, tokens[1:]):
        if province_name(before) and _AREA.fullmatch(token) and token.endswith(("시", "군", "구")):
            return token
    return ""


def dong_forms(name: str) -> set[str]:
    """정식 표기 우선. '삼성일동'은 정식 이름이 없을 때만 삼성1동 후보로 쓴다."""
    forms = {name}
    digit = re.fullmatch(r"(.+?)제?(\d+)동", name)
    if digit:
        base, n = digit.groups()
        forms.update((f"{base}{n}동", f"{base}제{n}동"))
        if n in _NUMBERS.values():
            spoken = next(k for k, v in _NUMBERS.items() if v == n)
            forms.update((f"{base}{spoken}동", f"{base}제{spoken}동"))
    return forms
