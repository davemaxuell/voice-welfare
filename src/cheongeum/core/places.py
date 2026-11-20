"""공식 기관 위치·전화번호 요청의 공통 어휘."""
import re
from dataclasses import dataclass
from enum import StrEnum

from cheongeum.core.region import RegionMention


class PlaceKind(StrEnum):
    DONG_OFFICE = "15059715"
    PENSION = "15010814"
    MOBILITY = "15028207"


KINDS = {
    PlaceKind.DONG_OFFICE: ("행정복지센터", re.compile(r"주민\s*센터|행정\s*복지\s*센터|동사무소|[읍면]\s*사무소")),
    PlaceKind.PENSION: ("국민연금 지사", re.compile(r"국민\s*연금(?:\s*공단)?(?:\s*[가-힣]+)?\s*(?:지사|상담\s*센터|지역\s*본부)|국민\s*연금\s*공단")),
    PlaceKind.MOBILITY: ("교통약자 이동지원센터", re.compile(r"장애인\s*콜\s*택시|교통약자\s*이동\s*지원\s*센터|이동\s*지원\s*센터")),
}
_CUE = re.compile(r"어디|주소|위치|전화|문의|연락|예약|찾아|가까운|가는\s*길")
_SCREEN = re.compile(r"누르|눌러|클릭|버튼|링크|이\s*(?:화면|페이지)|(?:주소|이름|전화번호)\s*(?:는|은)\s*.+(?:넣|입력|저장)|^(?:내\s*)?주소는\s")


def place_kind(text: str) -> PlaceKind | None:
    return next((kind for kind, (_, pattern) in KINDS.items() if pattern.search(text)), None)


def is_place_request(text: str) -> bool:
    # "어디서 본 정보인지"는 출처를 묻는 말, "내 주소지 주민센터에 가야 해?"의 '주소지'는 위치 단서가 아니다
    cue_text = re.sub(r"어디서\s*(?:본|봤|확인|찾은|나온|읽은)|주소지", "", text)
    if not (_CUE.search(cue_text) and place_kind(text)) or _SCREEN.search(text):
        return False
    return not re.search(r"[가-힣]{2,}(?:연금|수당|급여|바우처|지원금|지원사업)", re.sub(r"국민\s*연금", "", text))


@dataclass(frozen=True)
class PlaceAsk:
    kind: PlaceKind
    region: RegionMention
    options: tuple[str, ...] = ()
    field: str = "region"
