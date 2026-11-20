"""
[새 파일] DesktopPort의 Windows 구현. 이 파일만 Windows 전용 패키지(uiautomation, Pillow의 ImageGrab)를 가져온다.
다른 OS에서는 이 모듈을 가져오지 않는다: create_desktop_port가 None을 돌려주고 데스크톱 기능이 꺼진다.

좌표가 생기는 곳은 이 파일의 capture 안뿐이다(요소 사각형 → 검은 칠). 밖으로 나가는 값에는 좌표가 없다.
"""
from __future__ import annotations

from pathlib import Path
from typing import Mapping

from cheongeum.core.apps import Launch
from cheongeum.core.desk import DesktopPort, SafePath, UiItem, WindowInfo
from cheongeum.core.picture import MaskPlan, Shot

# 창 하나에서 읽는 조작 요소의 한도(깊이, 개수). 큰 창에서 이벤트 루프와 음성 응답이 밀리지 않게.
OUTLINE_MAX_DEPTH = 8
OUTLINE_MAX_ITEMS = 300


class WindowsDesktop:
    """
    UI Automation 호출은 모두 COM 전용 스레드 하나(max_workers=1)에서 돈다(voice/stt_local.py의 단일 스레드 풀과 같은 방식).
    프로세스에 하나. 세션들이 함께 쓴다(브라우저처럼).
    """

    def __init__(self) -> None:
        raise NotImplementedError

    async def windows(self) -> list[WindowInfo]:
        raise NotImplementedError

    async def launch(self, how: Launch) -> None:
        """Exe → os.startfile(시스템 폴더의 그 이름). Uri → os.startfile(uri). 인자·셸 문자열을 만들지 않는다."""
        raise NotImplementedError

    async def raise_window(self, window: str) -> None:
        raise NotImplementedError

    async def show_folder(self, path: SafePath, select: str | None = None) -> None:
        """
        열린 탐색기 창이 있으면 그 창을 path로 옮기고(Shell 자동화 객체의 Navigate2), 없으면 os.startfile(path).
        select가 있으면 그 항목을 고른다(SelectItem). 목록을 UIA로 걷지 않는다.
        TODO(스파이크 D-S2): comtypes로 Shell.Application.Windows()가 되는지, 안 되면 새 창 열기로만 간다.
        """
        raise NotImplementedError

    async def open_file(self, path: SafePath) -> None:
        raise NotImplementedError

    async def outline(self, window: str) -> list[UiItem]:
        raise NotImplementedError

    async def invoke(self, window: str, target: dict) -> None:
        raise NotImplementedError

    async def send_keys(self, window: str, chord: str) -> None:
        raise NotImplementedError

    async def type_text(self, window: str, role: str, text: str) -> None:
        raise NotImplementedError

    async def read_text(self, window: str, role: str) -> str:
        raise NotImplementedError

    async def capture(self, window: str, plan: MaskPlan) -> Shot:
        """
        창 핸들로 그 창만 찍는다(ImageGrab.grab(window=...) 또는 PrintWindow). 화면 전체에서 잘라 내지 않으므로
        위에 겹친 다른 창·알림은 찍히지 않는다. 그다음 요소 나무를 한 번 걸어
          - 글 칸(Edit·Document·ComboBox) 전부, plan.anchors의 요소, 이름에 plan.private의 글이 든 요소
        의 사각형을 검게 칠하고, 긴 변 1600px로 줄여 PNG로 만든 뒤 Picture.masked로 봉한다.
        비밀번호 칸이 있으면 Refused("auth"). 사각형을 못 얻은 요소가 있으면 Refused("private").
        """
        raise NotImplementedError


def known_folders() -> Mapping[str, Path]:
    """core.apps.PLACES의 known_folder를 SHGetKnownFolderPath로 읽은 것(OneDrive로 옮긴 폴더도 맞게). 없는 장소는 뺀다."""
    raise NotImplementedError


def create_desktop_port(mode: str) -> DesktopPort | None:
    """mode: "auto"(Windows이고 패키지가 있으면 켠다) | "off". 그 밖의 OS·가져오기 실패는 None."""
    raise NotImplementedError
