"""
[새 파일] 앱 표: 청음이 열고 다루는 데스크톱 앱마다 한 줄. core/intents.py(의도 표)와 같은 자리, 같은 쓰임이다.

이 표 하나에서 나오는 것
 - 허용 목록: 표에 없는 앱·표에 없는 동작은 PolicyGuard.check_desk가 거부한다(DENIED_APP, DENIED_ACTION_TYPE).
 - 접근 등급: AppSpec.tier(지금까지 URL 출처에서만 나오던 full/read-only의 앱 쪽 근원).
 - 위험도: ActSpec.risk(부르는 쪽은 높일 수만 있다).
 - 이름 찾기: understanding/apps.py의 resolve_app·resolve_place(sites.py의 짝).
 - 규칙 파서의 낱말, LLM이 고를 수 있는 동작 이름 목록, 도움말 예문.
 - OS 호출: Launch·Recipe는 코드가 적어 둔 값이다. 사용자 말·모델 출력·화면 글이 OS 호출 문자열이 되는 길은 없다.

앱 하나를 더하려면 여기 한 줄. 새 Recipe 종류가 필요할 때만 DesktopPort에 메서드가 는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

AccessTier = Literal["full", "read-only", "none"]  # safety.guard.AccessTier와 같은 낱말
Risk = Literal["low", "sensitive", "consequential"]  # core.actions.Risk
# 창 사진: free = 물어보면 찍음, ask = 찍기 전에 소리로 물음, never = 찍지 않음
PicturePolicy = Literal["free", "ask", "never"]

# ---------------------------------------------------------------- 실행 방법(코드가 정한 값)


@dataclass(frozen=True)
class Exe:
    """시스템 경로의 실행 파일 이름. 인자는 없다."""

    name: str  # "notepad.exe"


@dataclass(frozen=True)
class Uri:
    """등록된 주소 틀로 열기. 예: ms-settings:easeofaccess-display"""

    uri: str


Launch = Exe | Uri

# ---------------------------------------------------------------- 이름 붙은 동작의 실행법


@dataclass(frozen=True)
class Keys:
    """창에 보낼 단축키 하나. 예: "ctrl+s". 표에 적힌 것만 보낼 수 있다."""

    chord: str


@dataclass(frozen=True)
class Press:
    """이름으로 찾은 조작 요소 누르기(UI Automation Invoke). role은 ControlType 이름."""

    role: str
    name: str


@dataclass(frozen=True)
class TypeInto:
    """글 칸에 받아쓴 글 넣기. 넣을 글은 DeskAct.value(사용자 말)이고 비밀값 검사를 거친다."""

    role: str  # "Document" | "Edit"


@dataclass(frozen=True)
class ReadText:
    """글 칸의 글 읽기(조작 없음)."""

    role: str


# Uri도 동작이 될 수 있다(설정의 이름 붙은 쪽 열기)
Recipe = Keys | Press | TypeInto | ReadText | Uri


@dataclass(frozen=True)
class ActSpec:
    name: str  # "save" (LLM·규칙이 고르는 이름)
    say: tuple[str, ...]  # 규칙이 알아듣는 말의 정규식: (r"저장",)
    spoken: str  # 승인을 물을 때 읽는 말: "저장하기"
    risk: Risk
    # 차례로 하는 단계들(대부분 하나). 예: 저장 = (Keys("ctrl+s"), TypeInto("Edit"), Press("Button", "저장"))
    how: tuple[Recipe, ...]
    example: str  # 도움말 예문: "저장해줘"


@dataclass(frozen=True)
class AppSpec:
    id: str  # "explorer"
    names: tuple[str, ...]  # 부르는 이름: ("파일 탐색기", "탐색기", "explorer")
    label: str  # 말할 이름: "파일 탐색기"
    # 켜는 방법. 창이 없는 것(시스템 소리)은 None
    launch: Launch | None
    # 이 앱의 창을 알아보는 단서(창이 있으면 둘 중 하나 이상)
    window_class: str | None
    process: str | None
    tier: AccessTier
    picture: PicturePolicy
    # 이 앱에서 쓰는 DeskAction 종류(core/desk.py의 type)
    verbs: tuple[str, ...]
    acts: tuple[ActSpec, ...] = ()


APPS: tuple[AppSpec, ...] = (
    AppSpec(
        id="explorer",
        names=("파일 탐색기", "탐색기", "내 컴퓨터", "explorer"),
        label="파일 탐색기",
        launch=Exe("explorer.exe"),
        window_class="CabinetWClass",  # probe-facts.md
        process="explorer.exe",
        tier="full",
        picture="free",
        verbs=("launch", "show_folder", "open_file", "capture_window"),
    ),
    # 그다음 앱들은 APPS.md의 순서대로 여기에 한 줄씩(메모장, 설정 ...)
)


def app(app_id: str) -> AppSpec | None:
    raise NotImplementedError


# ---------------------------------------------------------------- 장소(폴더의 "출처")

PlaceId = Literal["desktop", "documents", "downloads", "pictures", "music", "videos"]


@dataclass(frozen=True)
class PlaceSpec:
    """
    청음이 들어갈 수 있는 폴더 뿌리. 웹의 출처(origin)와 같은 자리다: 등급은 장소에서 나온다.
    실제 경로는 여기 없다. 실행 때 OS의 '알려진 폴더'에서 읽어 DesktopAgent에 넘긴다(OneDrive로 옮긴 바탕 화면·문서도 맞게).
    """

    id: PlaceId
    names: tuple[str, ...]  # ("다운로드 폴더", "다운로드", "받은 파일 폴더")
    label: str  # "다운로드 폴더"
    known_folder: str  # Windows KNOWNFOLDERID 이름: "Downloads"


PLACES: tuple[PlaceSpec, ...] = (
    PlaceSpec("downloads", ("다운로드 폴더", "다운로드", "내려받은 파일 폴더"), "다운로드 폴더", "Downloads"),
    PlaceSpec("documents", ("문서 폴더", "내 문서"), "문서 폴더", "Documents"),
    PlaceSpec("desktop", ("바탕화면", "바탕 화면", "데스크톱"), "바탕 화면", "Desktop"),
    PlaceSpec("pictures", ("사진 폴더", "내 사진"), "사진 폴더", "Pictures"),
    PlaceSpec("music", ("음악 폴더", "내 음악"), "음악 폴더", "Music"),
    PlaceSpec("videos", ("동영상 폴더", "비디오 폴더"), "동영상 폴더", "Videos"),
)

# ---------------------------------------------------------------- 파일 종류(여는 일의 위험도)

FileKind = Literal["document", "image", "media", "archive", "program", "other"]

# program = 열면 코드가 실행되는 것(.exe .msi .bat .cmd .ps1 .vbs .js .scr .reg .lnk .url .hta ...): 청음은 열지 않는다.
# other·archive = 무엇으로 열릴지 모른다: 열기 전에 소리로 묻는다. document·image·media = 그냥 연다.


def file_kind(name: str) -> FileKind:
    """파일 이름의 마지막 확장자로만 정한다("진단서.pdf.exe"는 program). 확장자가 없으면 other."""
    raise NotImplementedError
