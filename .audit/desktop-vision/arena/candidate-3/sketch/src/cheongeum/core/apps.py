"""
앱 표: 이름, 허용 정도, 동작, 실행 방법을 적은 단 하나의 표. understanding/sites.py의 KNOWN_SITES(sites.py:22)에 해당하되,
'부르는 말'과 '해도 되는 일'을 한 줄에 둔다. (사이트는 이름→주소 표와 허용 출처가 따로라 손으로 맞춰야 했다.)

 - 말 이해(understanding)는 names로 앱을 찾고, 가드(safety)는 같은 줄의 tier·verbs로 허용 정도를 정하고,
   실행기(agents/desktop)는 같은 줄의 launch로 창을 찾거나 연다. 앱 하나를 더하는 일은 이 표에 한 줄이다.
 - tier="none"인 줄은 '아는 앱인데 아직 안 함'이다. 사용자가 "메모장 열어줘"라고 하면 네이버에서 '메모장 홈페이지'를 찾는 대신
   (모르는 사이트 이름은 검색한다, browse.py:114) "메모장은 아직 열 수 없어요"라고 정직하게 답하려고 표에 둔다.
 - 실행 명령(argv)은 여기에 고정으로 적힌다. 사용자 말이나 모델 글은 어떤 명령에도 들어가지 않는다.
   '{start}' 자리 하나만 코드가 해석한 폴더 경로로 바뀐다.
이 파일은 core라서 OS를 부르지 않는다(실행은 agents/desktop/win32.py).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal, Sequence

from cheongeum.core.actions import AccessTier  # 신규: safety/guard.py:11의 AccessTier를 core로 옮기고 guard가 가져온다(한 곳에서 정의)
from cheongeum.core.jsutil import rx

Driver = Literal["folder", "uia"]  # folder = 파일 시스템이 사실, 창은 따라가게만(탐색기). uia = 접근성 트리를 읽고 이름으로 누른다(2차 앱부터).


@dataclass(frozen=True)
class Launch:
    argv: tuple[str, ...]  # 고정 명령(shell=False로만 실행). "{start}"만 코드가 바꾼다.
    window_class: str | None  # 이미 떠 있는 창을 찾는 단서(탐색기: CabinetWClass, 확인: probe-facts.md)
    process: str | None


@dataclass(frozen=True)
class AppSpec:
    id: str
    label: str  # 말할 이름
    names: tuple[str, ...]  # 부르는 말(받아쓰기 변형 포함)
    tier: AccessTier  # full = 이름 붙은 동작 가능, read-only = 읽기만, none = 아직 안 함
    verbs: frozenset[str]  # 허용된 AppVerb(core/desktop.py). 가드는 이 밖의 동작을 DENIED_ACTION_TYPE으로 막는다.
    launch: Launch | None
    driver: Driver
    # 이 앱 창을 사진으로 설명해도 되는가. 기본 False: 앱 창에는 대화·계정 같은 사적인 것이 있을 수 있어 앱마다 주인이 정한다.
    picture_ok: bool = False


@dataclass(frozen=True)
class Place:
    """알려진 폴더. 실제 경로는 OS가 안다(known folder). 한국어 이름이 아니라 id로 가리킨다."""

    id: str
    label: str
    names: tuple[str, ...]
    known_folder: str  # SHGetKnownFolderPath 이름(Downloads 등). 한글 폴더 이름·OneDrive 이동에 걸리지 않는다.
    sort: Literal["name", "recent"]  # 읽어 줄 차례: 다운로드·사진은 최근 것부터
    # 앱 안에 있다고 상태로 알지 못해도 이름만으로 폴더라고 읽어도 되는가. 대부분 False: '다운로드 읽어줘'는 READ_DOWNLOAD의 첫 예문이고
    # (intents.py:167), '문서 읽어줘'·'사진 뭐야'는 폴더가 아니다. 이 말들은 '폴더'를 붙여야 폴더다.
    bare_ok: bool = False


APPS: tuple[AppSpec, ...] = (
    AppSpec(
        id="explorer",
        label="파일 탐색기",
        names=("파일 탐색기", "파일탐색기", "탐색기", "엑스플로러"),
        tier="full",
        verbs=frozenset({"launch", "focus_window", "list", "open", "up", "history_back"}),
        launch=Launch(argv=("explorer.exe", "{start}"), window_class="CabinetWClass", process="explorer.exe"),
        driver="folder",
    ),
    # 2차 이후(APPS.md 순서). 지금은 tier="none"이라 이름만 알아듣고 '아직 못 해요'라고 답한다.
    AppSpec("notepad", "메모장", ("메모장", "노트패드"), "none", frozenset(), None, "uia"),
    AppSpec("calculator", "계산기", ("계산기",), "none", frozenset(), None, "uia"),
)

PLACES: tuple[Place, ...] = (
    # '받은 파일'은 일부러 뺐다: 브라우저가 받은 파일(READ_DOWNLOAD, rules.py:176)과 같은 말이라 두 뜻이 되기 때문이다.
    Place("downloads", "다운로드", ("다운로드 폴더", "다운로드"), "Downloads", "recent"),
    Place("documents", "문서", ("문서 폴더", "내 문서", "문서"), "Documents", "name"),
    Place("desktop", "바탕 화면", ("바탕 화면", "바탕화면"), "Desktop", "name", bare_ok=True),
    Place("pictures", "사진", ("사진 폴더", "사진"), "Pictures", "recent"),
    Place("music", "음악", ("음악 폴더", "음악"), "Music", "name"),
    Place("videos", "동영상", ("동영상 폴더", "동영상"), "Videos", "recent"),
)

APP_BY_ID = {a.id: a for a in APPS}
PLACE_BY_ID = {p.id: p for p in PLACES}

# 파일을 기본 프로그램으로 열어도 되는 종류(허용 목록). 목록에 없는 것(.exe .bat .cmd .ps1 .msi .lnk .url .js .vbs .jar 등)은
# 가드가 DENIED_EXECUTABLE로 막고 이유를 말한다. 이름이 아니라 확장자로만 판단한다.
OPENABLE_EXT: frozenset[str] = frozenset(
    {"pdf", "hwp", "hwpx", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "jpg", "jpeg", "png", "gif", "bmp", "mp3", "wav", "m4a", "mp4"}
)


# ---------------------------------------------------------------- 이름 찾기(말 → 표의 줄)


def resolve_app(text: str) -> AppSpec | None:
    """말 속에서 앱 이름을 찾는다. resolve_site(sites.py:152)와 같은 방식(공백 없앤 포함 비교, 긴 이름 먼저, 한 글자 차이 허용)."""
    raise NotImplementedError


def mentions_place(text: str, *, bare: bool = False) -> Place | None:
    """
    말 속의 알려진 폴더 이름. bare=False면 '~ 폴더'가 붙은 말, 또는 Place.bare_ok인 이름(바탕 화면)만 인정한다.
    '다운로드'·'문서'·'사진'·'음악'만 말한 것은 bare=True(앱 안에 있다고 상태로 알 때, APP_OPEN)에서만 인정한다
    ("다운로드 읽어줘"는 READ_DOWNLOAD, "문서 읽어줘"·"이 사진 뭐야"는 폴더가 아니다).
    """
    raise NotImplementedError


# ---------------------------------------------------------------- 길 검사(가드와 실행기가 같은 함수를 쓴다)


def within_roots(path: str, roots: Sequence[str]) -> bool:
    """
    realpath로 심볼릭 링크·정션을 풀고 나서 뿌리 안에 있는지. 다른 드라이브면 False. 뿌리 자신도 안으로 본다.
    가드가 행동 전에, 실행기가 효과 직전에 같은 함수로 한 번씩 본다(검사와 실행 사이에 바뀌는 길 방지).
    """
    real = os.path.normcase(os.path.realpath(path))
    for root in roots:
        base = os.path.normcase(os.path.realpath(root))
        try:
            if os.path.commonpath([real, base]) == base:
                return True
        except ValueError:  # 드라이브가 다름
            continue
    return False


def is_single_name(name: str) -> bool:
    """폴더 안 항목 이름 한 칸인가: 경로 구분자·드라이브·'..'·빈 이름이 없다. AppTarget.name의 검증."""
    return bool(name) and not rx(r"[\\/:]|^\.\.?$").search(name)
