"""
[새 파일] tests/fakes.py — 실제 OpenAI도 실제 바탕 화면도 없이 도는 시험용 가짜 둘.
기존 FakeLlm(tests/conftest.py:98)은 그대로 둔다. 사진은 다른 메서드(see)라 FakeLlm으로는 받을 수 없다.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from cheongeum.core.apps import Launch
from cheongeum.core.desk import SafePath, UiItem, WindowInfo
from cheongeum.core.picture import MaskPlan, Picture, Shot


class FakeVision:
    """
    VisionLlm 가짜. 받은 사진과 글을 calls에 쌓고 정해 둔 답을 준다.
    시험이 보는 것: calls[i]["picture"].png(가려졌는가), calls[i]["user"](비식별화됐는가), 불렸는가(로그인 화면에서는 0번).
    """

    name = "fake-vision"

    def __init__(self, answer: dict | None = None, fn=None) -> None:
        self.calls: list[dict] = []
        raise NotImplementedError

    async def see(self, *, system, user, picture: Picture, schemaName, schema, signal=None) -> Any | None:  # noqa: N803
        raise NotImplementedError


class FakeDesktop:
    """
    DesktopPort 가짜: 메모리 안의 창 목록과 요소 나무. 파일 시스템은 가짜가 아니다(시험이 tmp_path에 진짜 폴더를 만든다).

      desk = FakeDesktop()
      desk.on_open_file = lambda path: desk.add_window("진단서.pdf - 뷰어", process="viewer.exe")   # 열면 창이 뜨는 앱
      desk.on_open_file = None                                                                        # 아무 창도 안 뜸 → unconfirmed

    기록: desk.calls = [("show_folder", path, select), ("open_file", path), ("capture", window, plan), ...]
    """

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.on_open_file = None
        raise NotImplementedError

    def add_window(self, title: str, *, process: str, window_class: str = "", items: list[UiItem] | None = None) -> str:
        """창 하나를 맨 앞에 더하고 ref를 돌려준다."""
        raise NotImplementedError

    def close_window(self, ref: str) -> None:
        raise NotImplementedError

    async def windows(self) -> list[WindowInfo]:
        raise NotImplementedError

    async def launch(self, how: Launch) -> None:
        raise NotImplementedError

    async def raise_window(self, window: str) -> None:
        raise NotImplementedError

    async def show_folder(self, path: SafePath, select: str | None = None) -> None:
        raise NotImplementedError

    async def open_file(self, path: SafePath) -> None:
        raise NotImplementedError

    async def outline(self, window: str) -> list[UiItem]:
        raise NotImplementedError

    async def invoke(self, window: str, target: dict) -> None:
        """실제 포트처럼 role·name이 다르면 AdapterError("VERIFY_FAILED")."""
        raise NotImplementedError

    async def send_keys(self, window: str, chord: str) -> None:
        raise NotImplementedError

    async def type_text(self, window: str, role: str, text: str) -> None:
        raise NotImplementedError

    async def read_text(self, window: str, role: str) -> str:
        raise NotImplementedError

    async def capture(self, window: str, plan: MaskPlan) -> Shot:
        """1x1 PNG를 Picture.masked로 봉해 준다. plan은 calls에 남는다(무엇을 가리라고 했는지 시험이 본다)."""
        raise NotImplementedError


def desktop_runtime(tmp_path: Path, desk: FakeDesktop, env: dict | None = None):
    """
    create_test_runtime(conftest.py:29)에 가짜 포트와 임시 장소를 꽂은 것:
      AgentRuntime(load_config({... "DESKTOP": "off"}), desktop_port=desk,
                   place_roots={"downloads": tmp_path / "Downloads", "documents": tmp_path / "Documents", "desktop": tmp_path / "Desktop"})
    """
    raise NotImplementedError
