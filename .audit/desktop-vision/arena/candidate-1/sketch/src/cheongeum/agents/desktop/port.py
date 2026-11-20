"""
[새 파일] DesktopPort: OS 경계. OS 호출은 이 뒤에서만 만든다. 구현은 둘:
 - WindowsDesktop(agents/desktop/windows.py): Win32(ctypes) + 셸 자동화(Shell.Application, comtypes) + UIA(uiautomation).
   COM은 전용 스레드 하나(STA)에서만 부르고, 이벤트 루프는 막지 않는다(stt_local의 단일 스레드 풀과 같은 방식).
 - FakeDesktop(tests/fakes/desktop.py): 창은 메모리, 폴더는 tmp_path의 진짜 파일. 실제 데스크톱·인터넷 없이 시험한다.
파일 목록 읽기는 포트가 아니라 places.py(os.scandir)가 한다: 파일 시스템 논리는 시험에서도 진짜로 돈다.
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from cheongeum.core.desktop import PlaceId
from cheongeum.core.jsutil import AbortSignal
from cheongeum.core.shot import CaptureRefusal, MaskedShot

from cheongeum.agents.desktop.model import WindowRef


class ProcessFamily(Protocol):
    """창 주인 판정용: 이 서버 프로세스의 조상(Electron 셸)과 자손(Playwright가 띄운 브라우저)."""

    own: frozenset[int]
    descendants: frozenset[int]


class DesktopPort(Protocol):
    def foreground_hwnd(self) -> int | None:
        """지금 앞에 있는 창 핸들(GetForegroundWindow). 동기·즉시(턴을 마칠 때 _finish가 부른다)."""
        ...

    async def foreground(self) -> WindowRef | None: ...

    async def windows(self) -> list[WindowRef]:
        """보이는 최상위 창(작업 표시줄에 뜨는 것)."""
        ...

    async def family(self) -> ProcessFamily: ...

    async def known_folder(self, place: PlaceId) -> Path | None:
        """SHGetKnownFolderPath(OneDrive로 옮겨진 바탕화면·문서도 실제 위치). 없으면 None."""
        ...

    async def explorer_location(self, hwnd: int) -> Path | None:
        """
        탐색기 창이 보고 있는 폴더(Shell.Application.Windows의 그 HWND 항목). 홈·내 PC처럼 폴더가 아니면 None.
        Windows 11 탭: 같은 HWND에 항목이 여럿이면 활성 탭을 고른다(S3에서 방법을 정함).
        """
        ...

    async def explorer_selection(self, hwnd: int) -> list[str]: ...

    async def window_texts(self, hwnd: int, *, max_nodes: int = 300, budget_ms: int = 1500) -> tuple[str, ...]:
        """남의 창의 UIA 이름(제목 줄·버튼·메뉴·글). 입력 칸 값과 비밀번호 칸은 읽지 않는다."""
        ...

    async def capture_window(self, hwnd: int) -> MaskedShot | CaptureRefusal:
        """
        창 하나만 PrintWindow(PW_RENDERFULLCONTENT)로 찍고, 같은 스레드의 UIA로 가릴 자리를 찾아 칠한 뒤 PNG로.
        가릴지 판정은 agents/desktop/mask.should_mask(순수). 좌표는 이 메서드 안에서만 쓴다.
        UIA를 끝까지 읽지 못하면 CaptureRefusal("mask-failed").
        """
        ...

    async def execute(self, action: dict, path: Path | None, signal: AbortSignal | None = None) -> dict:
        """
        DesktopGuard를 통과한 동작만(부르는 곳은 DesktopAgent._run 하나). path는 places.resolve_in_place가 방금 확인한 실제 경로.
        동작별 OS 호출(모두 코드가 고정 인자로 만든다):
          launch_app   → registry.LaunchSpec(시스템 폴더 기준 절대 경로, 고정 인자) ShellExecute
          show_folder  → 대상 창(hwnd)이 탐색기면 Navigate2(path), 아니면 explorer.exe에 path 하나만 넘겨 새 창
          select_item  → 그 탐색기 창 Document.SelectItem(항목, 선택+초점+보이게)
          open_file    → ShellExecuteW(verb="open", path) (기본 앱)
          read_file    → 하지 않음(에이전트가 프로세스 안에서 읽는다)
          focus_window → 창 복원 후 SetForegroundWindow(앞으로 못 오면 ok=False, verified=False)
        target.hwnd가 있으면 실행 직전 그 창의 실행 파일·창 종류를 다시 읽어 target.app의 WindowMatch와 맞는지 본다
        (다르면 VERIFY_FAILED: 웹 _resolve_ref가 role·name을 다시 보는 것과 같은 자리. 가드는 순수해서 창을 볼 수 없다).
        → ActionResult 모양 dict. errorCode는 core.actions.EXECUTION_ERROR_CODES 안에서.
        """
        ...
