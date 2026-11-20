"""데스크톱 포트. 실제 Windows 호출은 WindowsDesktopPort 안에만 있다.

테스트는 FakeDesktopPort(인메모리 트리·임시 폴더)로 돈다. uiautomation과 ctypes는
이 파일 밖으로 나오지 않는다. 반환은 dict(camelCase)다.
"""

from __future__ import annotations

from typing import Protocol


class DesktopPort(Protocol):
    async def list_folder(self, folder: str) -> list[dict]:
        """폴더 항목: {name, kind: "folder"|"file", ext}. 목록은 os.scandir로 만든다(UIA 아님)."""
        ...

    async def open_folder(self, folder: str) -> None: ...

    async def open_item(self, folder: str, name: str) -> None:
        """os.startfile. 실행 파일 확장자는 가드가 먼저 막는다."""
        ...

    async def launch(self, app_id: str) -> None:
        """APPS 표의 고정 인자로만 실행한다(subprocess argv 리스트). 모델 글은 들어오지 않는다."""
        ...

    async def read_window(self, handle: int) -> dict:
        """UIA로 창 트리를 읽는다. 최소화된 창은 제목 표시줄만 준다(probe-facts). 실패는 예외."""
        ...

    async def window_picture(self, handle: int, masks: list[tuple[int, int, int, int]]) -> bytes:
        """PrintWindow로 이 창만 찍고 masks 사각형을 검게 칠한 PNG를 돌려준다."""
        ...


class WindowsDesktopPort:
    """Windows 구현. 다른 플랫폼에서는 생성되지 않는다(기능 꺼짐). PLAN U5, U7에서 채운다."""

    def __init__(self) -> None:
        raise NotImplementedError
