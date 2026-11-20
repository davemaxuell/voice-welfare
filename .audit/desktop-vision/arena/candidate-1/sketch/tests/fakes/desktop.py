"""
[새 파일] FakeDesktop: DesktopPort의 시험용 구현. 실제 데스크톱·COM·인터넷 없이 돈다.
 - 알려진 폴더는 tmp_path 아래 진짜 폴더(다운로드·바탕화면 …). 파일 목록·경로 확인·문서 읽기는 진짜 코드가 돈다.
 - 창은 메모리 목록. 앞 창은 시험이 정한다(set_foreground). family는 시험이 정한 pid 집합.
 - execute는 받은 동작을 기록하고 결과를 흉내 낸다: launch_app → 탐색기 창 하나 더함, show_folder → 그 창 위치 바꿈,
   open_file → 기본값으로 '<파일 이름> - 앱' 창 하나 더함(no_window_on_open=True면 안 더함 → unconfirmed 시험).
 - capture_window → 작은 PNG와 MaskReport(시험이 정한 가림 수, complete=mask_ok).
 - from_internet은 파일 이름 집합으로 흉내 낸다(Zone.Identifier가 없는 운영체제에서도 시험이 돈다).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class FakeDesktop:
    root: Path
    windows_: list = field(default_factory=list)
    fg: int | None = None
    executed: list[dict] = field(default_factory=list)
    internet_files: set[str] = field(default_factory=set)
    no_window_on_open: bool = False
    mask_ok: bool = True

    def set_foreground(self, window) -> None:
        raise NotImplementedError

    def foreground_hwnd(self) -> int | None:
        raise NotImplementedError

    # ... DesktopPort의 나머지 메서드(port.py) ...


def make_known_folders(tmp_path: Path) -> FakeDesktop:
    """다운로드·바탕화면·문서·사진·음악·동영상 폴더를 만들고 FakeDesktop을 돌려준다."""
    raise NotImplementedError


def with_desktop(session, port: FakeDesktop) -> None:
    """세션에 가짜 데스크톱을 붙인다(with_llm과 같은 자리, conftest.py). session.desktop.agent를 DesktopAgent(port, …)로 바꾼다."""
    raise NotImplementedError
