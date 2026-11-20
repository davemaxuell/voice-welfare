"""
AppAdapter: 앱 동작의 효과를 내는 곳(웹의 PlaywrightExecutionAdapter 자리). 가드를 지난 AppAction만 받는다.

보는 것은 파일 시스템(explorer.py), 창에 닿는 것은 DesktopPort뿐이다. 결과는 웹과 같은 ActionResult 모양의 dict다(actions.py:95).
'누르기 직전 다시 확인'(웹의 _resolve_ref, browser/__init__.py:516)에 해당하는 것: 효과 직전에 길을 다시 풀어
(1) 뿌리 안인지(within_roots), (2) 아직 있고 종류(folder/file)가 같은지 본다. 다르면 VERIFY_FAILED(말: '그사이 바뀌어 열지 않았어요').
"""
from __future__ import annotations

from cheongeum.agents.desktop.port import DesktopPort, WindowRef
from cheongeum.core.jsutil import AbortSignal


class AppAdapter:
    def __init__(self, port: DesktopPort, roots: dict[str, str]) -> None:
        """roots: 알려진 폴더 id → 실제 경로(DesktopPort.resolve_place로 시작할 때 한 번 푼 것). PolicyConfig.roots와 같은 값에서 만든다."""
        self.port = port
        self._roots = dict(roots)
        self._win: WindowRef | None = None  # 이 세션이 따라가는 탐색기 창
        self._cwd: str | None = None  # None이면 홈(알려진 폴더 고르기). 사실의 단 하나의 주인은 여기다.
        self._history: list[str | None] = []

    async def execute(self, action: dict, signal: AbortSignal | None = None) -> dict:
        """
        verb별 효과(모두 멱등):
          launch        find_window로 이미 있으면 focus만, 없으면 launch(start=홈 화면이면 None). 그 뒤 _cwd=None(홈).
          focus_window  find_window → focus. 최소화면 NOT_SUPPORTED(되살리기는 승인 동작으로 따로).
          open          folder/place: 길을 풀고 _history에 지금을 쌓고 _cwd=새 길, show_folder(최선). 같은 폴더를 또 열어도 같은 상태.
                        file: 가드가 허용 확장자·승인을 이미 봤다. 효과 직전에 길·종류를 다시 보고 port.open_default.
          up            parent_within(_cwd, 뿌리들). 뿌리 위로 나가면 홈. show_folder(최선).
          history_back  _history.pop().
          list          아무 일도 하지 않는다(observe로 다시 본다). 기록에 '다시 봄' 줄을 남기려고 동작으로 둔다.
        오류 코드는 웹과 같다: TARGET_NOT_FOUND(없음), AMBIGUOUS_TARGET(여럿), VERIFY_FAILED(그사이 바뀜), TIMEOUT, ABORTED(signal), NOT_SUPPORTED, NAVIGATION_FAILED(열 수 없는 폴더).
        """
        raise NotImplementedError

    async def observe(self) -> dict:
        """지금 모습: _cwd가 None이면 홈(explorer.home_places), 아니면 explorer.list_folder. WindowView 모양 dict(parse_window_view를 거친다)."""
        raise NotImplementedError
