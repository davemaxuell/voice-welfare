"""이름과 행정구역으로만 찾고, 두 곳 이상이면 지역이나 기관 이름을 다시 묻는다."""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from functools import cache

from cheongeum.core.places import KINDS, PlaceAsk, PlaceKind, place_kind
from cheongeum.core.region import RegionMention, dong_forms, parse_region_mention
from cheongeum.speech.phrasing import josa

from .datasets import BUNDLED, DATASETS, Place, load_one

_DIGITS = str.maketrans("0123456789-", "공일이삼사오육칠팔구,")


@cache
def official_districts() -> dict[str, tuple[tuple[str, str], ...]]:
    """함께 넣은 행정안전부 읍면동 자료의 시·군·구 이름 → (시·도, 속한 시·군·구). 일반구는 그 시에 속한다(분당구 → 성남시)."""
    _, places = load_one(BUNDLED, DATASETS[PlaceKind.DONG_OFFICE])
    homes: dict[str, set[tuple[str, str]]] = {}
    for place in places:
        for name in place.districts:
            homes.setdefault(name, set()).add((place.province, place.districts[0]))
    return {name: tuple(sorted(found)) for name, found in homes.items()}


@dataclass(frozen=True)
class PlaceReply:
    speech: str
    semantic: str = "find-place"
    sources: tuple[dict, ...] = ()
    ask: PlaceAsk | None = None
    review_quotes: tuple[str, ...] = ()


def _spoken(s: str) -> str:
    return " ".join(re.sub(r"[.!?。]+", " ", s).split())


class PlaceFinder:
    def __init__(self, rows: dict[PlaceKind, tuple[Place, ...]], dates: dict[PlaceKind, date]):
        self.rows = rows
        self.dates = dates

    def answer(self, text: str, hint: str | None = None, *, lang: str = "ko") -> PlaceReply:
        kind = place_kind(text)
        if not kind:
            return PlaceReply("주민센터, 국민연금 지사, 교통약자 이동지원센터 중 어느 곳인가요?", "clarify")
        if kind not in self.rows:
            return PlaceReply(f"{KINDS[kind][0]} 자료를 아직 내려받지 못해서 확인하지 못했어요.")
        # '콜택시' ends in 시. Preserve the 읍/면 of names such as '삼산면사무소'.
        region_text = KINDS[kind][1].sub(" ", text) if kind == PlaceKind.MOBILITY else text.replace("사무소", " ")
        region = parse_region_mention(region_text)
        if not region and hint and re.search(r"우리\s*동네|가까운|근처", text):
            region = RegionMention(province=hint)
        named = ""
        if kind != PlaceKind.DONG_OFFICE:
            compact = "".join(text.split())
            names = {row.name for row in self.rows[kind] if "".join(row.name.split()) in compact}
            if len(names) == 1:
                named = names.pop()
        return self._reply(kind, region, lang, named)

    def follow_up(self, ask: PlaceAsk, text: str, *, lang: str = "ko") -> PlaceReply | None:
        bare = text.strip().strip(".?!").strip()
        if re.fullmatch(r"모름|몰라(?:요)?|모르겠(?:어|어요)|잘\s*모르겠어요|건너뛰기", bare):
            return PlaceReply("지역을 확인하기 어려워 어느 곳인지 정하지 못했어요.")
        choice = re.fullmatch(r"(\d+)\s*번(?:이요|요)?", bare)
        if choice:
            number = int(choice[1])
            if not 1 <= number <= len(ask.options):
                return None
            bare = ask.options[number - 1]
        if ask.field == "office" and bare in ask.options:
            return self._reply(ask.kind, ask.region, lang, bare)
        new = parse_region_mention(bare, bare=True)
        if not new:
            return None
        region = RegionMention(new.province or ask.region.province,
                               tuple(dict.fromkeys((*ask.region.districts, *new.districts))),
                               new.dong or ask.region.dong)
        return self._reply(ask.kind, region, lang)

    def _reply(self, kind: PlaceKind, region: RegionMention, lang: str, named: str = "") -> PlaceReply:
        if not region and not named:
            return PlaceReply("어느 시·군·구의 어느 동인지 말씀해 주세요.", "clarify", ask=PlaceAsk(kind, region))
        places = [p for p in self.rows[kind] if (not named or named == p.name)
                  and (not region.province or region.province == p.province)
                  and all(part in p.districts for part in region.districts)]
        if region.dong:
            exact = [p for p in places if region.dong in (p.dong, p.legal_dong)]
            places = exact or [p for p in places if region.dong in dong_forms(p.dong)]
        if not places:
            return PlaceReply(f"말씀하신 지역과 일치하는 {KINDS[kind][0]}를 이 자료에서 찾지 못했어요.")
        if len(places) == 1:
            return self._found(kind, places[0], lang)

        levels = [("province", sorted({p.province for p in places})),
                  ("district", sorted({d for p in places for d in p.districts if d not in region.districts})),
                  ("dong", sorted({p.dong for p in places if p.dong})),
                  ("office", sorted({p.name for p in places}))]
        for field, options in levels:
            if len(options) > 1:
                break
        else:
            return PlaceReply("같은 이름과 지역으로 등록된 기관이 여러 곳이라 한 곳을 정하지 못했어요.")
        question = {"province": "어느 시·도인가요?", "district": "어느 시·군·구인가요?",
                    "dong": "어느 읍·면·동인가요?", "office": "어느 기관인가요?"}[field]
        # 너무 많은 후보는 번호를 붙이지 않는다. 듣지 못한 후보 번호가 선택되지 않게 한다.
        choices = tuple(options) if len(options) <= 5 else ()
        where = " ".join([v for v in (region.province, *region.districts, region.dong) if v])
        scope = f"{where}에서 " if where else ""
        if choices:
            listed = ", ".join(f"{i}번 {_spoken(item)}" for i, item in enumerate(choices, 1))
            speech = f"{scope}{listed} 중 {question}"
        else:
            speech = f"{scope}{len(places)}곳을 찾았어요. {question}"
        return PlaceReply(speech, "clarify", ask=PlaceAsk(kind, region, choices, field))

    def _found(self, kind: PlaceKind, place: Place, lang: str) -> PlaceReply:
        ref = place.reference_date or self.dates[kind]
        spec = DATASETS[kind]
        name = "국민연금공단 " + place.name if kind == PlaceKind.PENSION else place.name
        head = f"{josa(_spoken(name), '은', '는')} {_spoken(place.address)}에 있어요."
        if place.phone:
            spoken = place.phone.translate(_DIGITS).replace(",", ", ") if lang == "ko" else place.phone
            phone = f"{'예약 전화번호' if kind == PlaceKind.MOBILITY else '전화번호'}는 {spoken}예요"
        else:
            phone = "이 자료에는 전화번호가 없어요"
        source = spec.citation(ref, place.phone)
        return PlaceReply(f"{head} {phone} (출처: {spec.title}, {ref.year}년 {ref.month}월 {ref.day}일 기준).",
                          sources=(source,), review_quotes=tuple(x for x in (name, place.address, place.phone) if x))
