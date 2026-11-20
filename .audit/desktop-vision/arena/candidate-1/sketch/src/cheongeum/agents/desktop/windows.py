"""
[새 파일] WindowsDesktop: DesktopPort의 윈도 구현. 이 파일만 OS를 만진다.
 - Win32(ctypes, 의존성 없음): 앞 창, 창 목록·프로세스, 프로세스 조상·자손(CreateToolhelp32Snapshot), 알려진 폴더(SHGetKnownFolderPath),
   ShellExecuteW, 창 복원·앞으로, PrintWindow(PW_RENDERFULLCONTENT) + GDI로 PNG, DPI 인식(SetThreadDpiAwarenessContext).
 - 셸 자동화(comtypes, uiautomation이 함께 깔림): Shell.Application.Windows()로 탐색기 창 ↔ HWND ↔ 폴더, Navigate2, SelectItem, SelectedItems.
 - UIA(uiautomation): 남의 창 이름 읽기, 그림에서 가릴 요소 찾기.
COM은 전용 스레드 하나(STA, CoInitialize)에서만. async 메서드는 그 스레드에 일을 넘기고 기다린다(race_abort로 멈춤 반영;
이미 시작한 COM 호출은 끝까지 가지만 결과를 버린다).
의존성: pyproject에 'uiautomation; sys_platform == "win32"'(comtypes 포함). 윈도가 아니면 이 모듈을 가져오지 않는다.
"""
from __future__ import annotations

import sys
from pathlib import Path

from cheongeum.core.desktop import PlaceId
from cheongeum.core.shot import CaptureRefusal, MaskedShot

from cheongeum.agents.desktop.model import WindowRef
from cheongeum.agents.desktop.port import ProcessFamily
from cheongeum.agents.desktop.registry import REGISTRY

# KNOWNFOLDERID(GUID): 다운로드·바탕화면·문서·사진·음악·동영상
KNOWN_FOLDER_IDS: dict[PlaceId, str] = {
    "downloads": "{374DE290-123F-4565-9164-39C4925E467B}",
    "desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
    "documents": "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}",
    "pictures": "{33E28130-4E1E-4676-835A-98395C3BC3BB}",
    "music": "{4BD8D571-6D19-48D3-BE97-422220080E43}",
    "videos": "{18989B1D-99B5-455B-841C-AB7C74E4DDFC}",
}


class WindowsDesktop:
    """프로세스에 하나(AgentRuntime이 만든다). 세션들이 같이 쓴다(COM 스레드 하나)."""

    def __init__(self) -> None:
        assert sys.platform == "win32"
        raise NotImplementedError

    def foreground_hwnd(self) -> int | None:
        raise NotImplementedError

    async def foreground(self) -> WindowRef | None:
        raise NotImplementedError

    async def windows(self) -> list[WindowRef]:
        raise NotImplementedError

    async def family(self) -> ProcessFamily:
        """own = os.getpid()와 그 조상(Electron 셸 등), descendants = os.getpid()의 자손(Playwright 드라이버 → 브라우저)."""
        raise NotImplementedError

    async def known_folder(self, place: PlaceId) -> Path | None:
        raise NotImplementedError

    async def explorer_location(self, hwnd: int) -> Path | None:
        raise NotImplementedError

    async def explorer_selection(self, hwnd: int) -> list[str]:
        raise NotImplementedError

    async def window_texts(self, hwnd: int, *, max_nodes: int = 300, budget_ms: int = 1500) -> tuple[str, ...]:
        raise NotImplementedError

    async def capture_window(self, hwnd: int) -> MaskedShot | CaptureRefusal:
        raise NotImplementedError

    async def execute(self, action: dict, path: Path | None, signal=None) -> dict:
        """동작별 OS 호출은 port.DesktopPort.execute 설명대로. 앱 실행 파일은 REGISTRY[app].launch에서만 만든다."""
        raise NotImplementedError


def create_desktop_port(enabled: bool) -> "WindowsDesktop | None":
    """윈도이고 enabled면 WindowsDesktop, 아니면 None(데스크톱 기능 꺼짐: 경로가 그 안내를 말한다)."""
    raise NotImplementedError
