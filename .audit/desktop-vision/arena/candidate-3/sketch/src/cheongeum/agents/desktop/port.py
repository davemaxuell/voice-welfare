"""
DesktopPort: 운영체제에 닿는 모든 호출이 지나는 단 하나의 경계.

이 Protocol 밖에서는 Win32·COM·UIA·subprocess·os.startfile을 부르지 않는다(tests/unit/test_desktop_boundary.py가 가져오기를 센다).
그래서 (가) 윈도가 아닌 곳에서는 NullPort로 기능이 통째로 꺼지고, (나) 시험은 진짜 바탕 화면 없이 FakeDesktopPort로 돈다(tests/fakes/desktop_port.py),
(다) 실제 구현(win32.py)은 얇아서 사람이 한 번 눈으로 확인하면 된다.

모든 메서드는 비동기다. 실제 구현은 COM·UIA가 한 스레드에 묶이므로 전용 스레드 하나에서 돌리고(stt_local.py의 단일 스레드 풀과 같은 방식),
막힌 호출은 시간 한도(기본 3초)에서 TIMEOUT으로 끝낸다. 이벤트 루프를 막지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from cheongeum.core.apps import AppSpec


@dataclass(frozen=True)
class WindowRef:
    """찾아 둔 창. 핸들은 OS 안에서만 뜻이 있고, 말·기록·승인 지문에는 나오지 않는다."""

    handle: int
    app: str
    minimized: bool = False


class DesktopPort(Protocol):
    available: bool  # False면 데스크톱 기능 전체가 꺼진다(NullPort)

    async def resolve_place(self, known_folder: str) -> str | None:
        """알려진 폴더의 실제 경로(SHGetKnownFolderPath). 한글 폴더 이름·OneDrive로 옮긴 경우를 OS가 푼다. 없으면 None."""
        ...

    async def find_window(self, spec: AppSpec) -> WindowRef | None:
        """이미 떠 있는 이 앱의 창(spec.launch.window_class·process로). 읽기만 한다. 창이 여럿이면 가장 최근에 쓴 것."""
        ...

    async def launch(self, spec: AppSpec, start: str | None) -> WindowRef | None:
        """
        spec.launch.argv의 '{start}'만 start로 바꿔 shell=False로 실행한다. 사용자 말은 어떤 인자에도 들어가지 않는다.
        이미 떠 있는지는 부르는 쪽(DesktopAgent.launch)이 find_window로 먼저 본다: 두 번 열리지 않게.
        """
        ...

    async def show_folder(self, win: WindowRef | None, folder: str) -> WindowRef | None:
        """
        탐색기 창을 그 폴더로 따라가게 한다(Shell.Application의 창 목록에서 handle이 같은 창에 Navigate2). win이 None이거나 사라졌으면 새로 연다.
        최선을 다할 뿐 실패해도 동작은 실패가 아니다: 사실은 파일 시스템이 안다(아래 explorer.py). 못 따라가면 None.
        """
        ...

    async def focus(self, win: WindowRef) -> bool:
        """창을 앞으로. 최소화돼 있으면 되살리지 않고 False(되살리기는 restore_window로 승인받고 한다)."""
        ...

    async def open_default(self, path: str) -> None:
        """파일을 기본 프로그램으로(os.startfile 하나). 경로는 가드가 허용 확장자·뿌리를 이미 본 것만 온다. 실행기가 효과 직전에 한 번 더 본다."""
        ...


class NullPort:
    """윈도가 아니거나 데스크톱 기능이 꺼졌을 때. runtime은 이때 DesktopAgent를 아예 만들지 않으므로 이것은 방어용이다."""

    available = False

    async def resolve_place(self, known_folder: str) -> str | None:
        return None

    async def find_window(self, spec: AppSpec) -> WindowRef | None:
        return None

    async def launch(self, spec: AppSpec, start: str | None) -> WindowRef | None:
        return None

    async def show_folder(self, win: WindowRef | None, folder: str) -> WindowRef | None:
        return None

    async def focus(self, win: WindowRef) -> bool:
        return False

    async def open_default(self, path: str) -> None:
        raise NotImplementedError("이 컴퓨터에서는 앱을 열 수 없습니다.")
