"""
시험용 가짜 데스크톱: 진짜 창·진짜 OS 없이 앱 쪽 전부(가드·실행기·어댑터·기술·오케스트레이터)를 돌리는 이음새.
파일 시스템은 진짜(pytest tmp_path)이고 창만 가짜다. 그래서 '목록 읽기'가 진짜 코드(os.scandir)로 시험된다.

tests/conftest.py의 FakeLlm(conftest.py:98)처럼 부르는 쪽 기록을 남겨 '무엇을 했는가'를 본다(어느 창을 열었나, 몇 번 따라갔나).
"""
from __future__ import annotations

from dataclasses import dataclass, field

from cheongeum.agents.desktop.port import WindowRef
from cheongeum.core.apps import AppSpec


@dataclass
class FakeDesktopPort:
    """DesktopPort(agents/desktop/port.py)를 만족한다."""

    folders: dict[str, str]  # 알려진 폴더 이름("Downloads") → tmp_path 아래 실제 경로
    available: bool = True
    calls: list[tuple] = field(default_factory=list)  # ("launch", app, start), ("show_folder", handle, folder), ("open_default", path) ...
    windows: dict[str, WindowRef] = field(default_factory=dict)  # app id → 떠 있는 창
    minimized: bool = False  # True면 focus가 False를 돌려준다(최소화된 창)
    follow_fails: bool = False  # True면 show_folder가 None: '창은 못 따라가도 동작은 성공' 시험

    async def resolve_place(self, known_folder: str) -> str | None:
        raise NotImplementedError

    async def find_window(self, spec: AppSpec) -> WindowRef | None:
        raise NotImplementedError

    async def launch(self, spec: AppSpec, start: str | None) -> WindowRef | None:
        """창이 없을 때만 만든다. calls에 남는다. 같은 앱을 두 번 열면 calls에 launch가 한 번뿐이어야 한다(멱등)."""
        raise NotImplementedError

    async def show_folder(self, win: WindowRef | None, folder: str) -> WindowRef | None:
        raise NotImplementedError

    async def focus(self, win: WindowRef) -> bool:
        raise NotImplementedError

    async def open_default(self, path: str) -> None:
        """실제로 열지 않고 calls에만 적는다. 시험이 '실행 파일은 여기 오지도 못한다'를 본다."""
        raise NotImplementedError


# 시험이 쓰는 모양(예):
#
#   async def test_open_downloads_and_list(tmp_path, new_desktop_session):
#       (tmp_path / "Downloads").mkdir(); (tmp_path / "Downloads" / "이력서.pdf").write_bytes(b"")
#       s, port = await new_desktop_session({"Downloads": str(tmp_path / "Downloads")})
#       r = await s.handle_turn("파일 탐색기 열어줘");           assert r["state"] == "APP_OPEN" and port.calls[0][0] == "launch"
#       r = await s.handle_turn("다운로드 폴더 열어줘");         assert "이력서" in r["speech"] and r["page"] == "app:explorer"
#       r = await s.handle_turn("파일 탐색기 열어줘");           assert [c for c in port.calls if c[0] == "launch"] == [port.calls[0]]   # 창이 둘이 되지 않는다
#       assert "이력서" not in " ".join(h["text"] for h in s.export_history() if h["role"] == "assistant")  # 이름은 기록(LLM 입력)에 없다
