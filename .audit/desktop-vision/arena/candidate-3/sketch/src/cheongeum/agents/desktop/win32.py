"""
Win32Port: DesktopPort의 윈도 구현. 이 프로젝트에서 OS를 부르는 유일한 파일이다.

 - comtypes·uiautomation·ctypes·subprocess·os.startfile은 이 파일 안에서만, 그것도 함수 안에서 늦게 가져온다
   (윈도가 아닌 곳이나 의존성이 없는 곳에서 가져오기만으로 실패하지 않게: sys.platform != "win32"면 runtime이 이 파일을 가져오지 않는다).
 - 모든 호출은 전용 스레드 하나(COM 아파트먼트)에서 돌고, 호출마다 3초 한도다. 한도를 넘으면 TIMEOUT으로 끝내고 그 스레드를 새로 만든다(멈춘 앱이 청음을 멈추지 않게).
 - 의존성은 pyproject에 윈도에서만: "comtypes>=1.4; sys_platform == 'win32'" (1차). uiautomation·Pillow는 3차 앱부터.
 - MaskedShot(...)을 만드는 두 곳 중 하나다(다른 하나는 웹 어댑터). 3차에 capture_window가 들어올 때만.

모르는 것(스파이크 S3로 먼저 잰다; 이 PC에서는 재지 않았다, probe-facts.md '측정하지 않은 것'):
  Shell.Application().Windows()의 응답 시간, 최소화된 창에 Navigate2가 먹는지, 창 목록이 큰 폴더에서 얼마나 느린지.
  안 먹으면 show_folder는 None을 돌려주고 동작은 파일 시스템만으로 성공한다(창 따라가기는 최선이다).
"""
from __future__ import annotations

from cheongeum.agents.desktop.port import WindowRef
from cheongeum.core.apps import AppSpec


class Win32Port:
    available = True

    async def resolve_place(self, known_folder: str) -> str | None:
        """SHGetKnownFolderPath(FOLDERID_*)를 ctypes로. 이름→GUID 표는 여기 한 곳."""
        raise NotImplementedError

    async def find_window(self, spec: AppSpec) -> WindowRef | None:
        """탐색기: Shell.Application().Windows() 중 Document.Folder가 있는 창. 그 밖의 앱(2차): EnumWindows + 프로세스 이름."""
        raise NotImplementedError

    async def launch(self, spec: AppSpec, start: str | None) -> WindowRef | None:
        """subprocess.Popen(argv, shell=False). argv는 spec.launch.argv의 '{start}'만 바꾼 것. 창이 나타날 때까지 최대 3초 기다려 WindowRef."""
        raise NotImplementedError

    async def show_folder(self, win: WindowRef | None, folder: str) -> WindowRef | None:
        """handle이 같은 창에 Navigate2(folder). 창이 없으면 launch. 실패하면 None."""
        raise NotImplementedError

    async def focus(self, win: WindowRef) -> bool:
        """최소화면 False. 아니면 SetForegroundWindow(윈도가 거절하면 False: 사용자의 앞 창을 빼앗지 않는다)."""
        raise NotImplementedError

    async def open_default(self, path: str) -> None:
        """os.startfile(path) 하나. 경로는 가드가 허용 확장자·뿌리를 이미 본 것."""
        raise NotImplementedError
