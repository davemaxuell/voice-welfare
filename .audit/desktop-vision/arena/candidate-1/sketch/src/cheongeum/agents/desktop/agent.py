"""
[새 파일] DesktopAgent: 데스크톱 실행. WebExecutionAgent(agents/web/agent.py:140)와 같은 규율:
모든 동작은 _run에서 DesktopGuard.check → 조작 기록 '전' → 경로 재확인(resolve_in_place) → port.execute → 조작 기록 '후' → 재관찰.
 - 기록 '전'을 못 쓰면 승인이 필요했던 동작은 실행하지 않는다(LOG_FAILED, agent.py:531과 같음).
 - TIMEOUT 재시도는 저위험이고 승인이 필요 없던 동작만 한 번. 파일 열기·앱 실행은 이미 됐을 수 있어 다시 하지 않고,
   새 창이 보이지 않으면 unconfirmed로 돌려준다(기술이 승인 대기를 둔 채 다시 묻는다).
 - 기록 줄: host = 앱 이름("파일 탐색기"), pageKind = "desktop:explorer", label = 코드가 만든 짧은 이름(파일 이름만, 경로 없음).
포트(DesktopPort)는 이 클래스만 부른다. 기술은 포트를 직접 만지지 않는다.
"""
from __future__ import annotations

from typing import Any

from cheongeum.core.context import ExecContext
from cheongeum.core.desktop import AppId, PlaceId
from cheongeum.core.shot import ShotSource
from cheongeum.safety.desktop_guard import DesktopGuard

from cheongeum.agents.desktop.model import DesktopOutcome, DesktopView, FolderEntry, Focus, WindowRef
from cheongeum.agents.desktop.port import DesktopPort

# 새 창이 뜨기를 기다리는 한도(초): 앱 실행·폴더 열기 5초, 파일 열기 8초(큰 프로그램)
LAUNCH_WAIT_S = 5.0
OPEN_FILE_WAIT_S = 8.0


class DesktopAgent:
    id = "desktop-apps-and-files"

    def __init__(self, port: DesktopPort, guard: DesktopGuard, action_log: Any = None) -> None:
        self.port = port
        self.guard = guard
        self.action_log = action_log
        self._last_view: DesktopView | None = None

    @property
    def current_view(self) -> DesktopView | None:
        return self._last_view

    def foreground_hwnd(self) -> int | None:
        """_finish가 턴을 마칠 때 부른다(FocusMemory.fg_hwnd)."""
        return self.port.foreground_hwnd()

    async def focus(self, enabled: bool, memory: "FocusMemory") -> Focus:  # noqa: F821
        """턴 시작에 한 번: port.foreground() + port.family() → focus.resolve_focus."""
        raise NotImplementedError

    # ---------------------------------------------------------------- 관찰(동작 아님, 가드를 거치지 않음. 폴더 밖은 resolve_in_place가 막음)

    async def observe_window(self, win: WindowRef, ctx: ExecContext) -> DesktopView:
        """
        앞에 있는 창 하나를 관찰. 탐색기면 explorer_location → read_folder(+ 선택 항목), 남의 창이면 window_texts,
        자격 증명 창이면 아무것도 읽지 않는다(tier none).
        """
        raise NotImplementedError

    async def observe_folder(self, place: PlaceId, rel: tuple[str, ...], ctx: ExecContext) -> DesktopView | None:
        """창 없이 폴더 읽기(known_folder → resolve_in_place → read_folder). 폴더가 없으면 None."""
        raise NotImplementedError

    async def stat(self, place: PlaceId, rel: tuple[str, ...]) -> FolderEntry | None:
        """승인 재확인용: 그 항목의 지금 모습(없으면 None)."""
        raise NotImplementedError

    # ---------------------------------------------------------------- 동작(모두 _run을 거친다)

    async def launch(self, app: AppId, ctx: ExecContext) -> DesktopOutcome:
        """launch_app → 그 앱의 새 창이 LAUNCH_WAIT_S 안에 뜨면 그 창을 관찰해 ok, 아니면 unconfirmed."""
        raise NotImplementedError

    async def show_folder(self, place: PlaceId, rel: tuple[str, ...], window: WindowRef | None, ctx: ExecContext) -> DesktopOutcome:
        """
        show_folder. window가 탐색기면 그 창을 옮기고, 아니면 새 탐색기 창. 끝나면 창 위치가 그 폴더인지 다시 본다
        (explorer_location == 실제 경로). 다르면 unconfirmed(낮은 위험이라 기술이 그냥 "확인하지 못했어요"라고 말한다).
        """
        raise NotImplementedError

    async def point_at(self, entry: FolderEntry, folder: DesktopView, ctx: ExecContext) -> DesktopOutcome:
        """
        파일 열기를 묻기 전: 그 폴더를 보여 주는 탐색기 창이 있으면 select_item으로 그 파일을 선택(초점)하고,
        승인되면 실행할 open_file 동작을 pending으로 돌려준다(열지는 않는다). 위험도는 관찰한 사실로 정한다:
        from_internet이면 requiresConfirmation=True. (가드는 확장자로 따로 올리거나 막는다.)
        가드가 바로 허용하는 파일(내 컴퓨터에서 만든 PDF 등)이면 status=ok, pending=None으로 돌려주고 부르는 쪽이 바로 연다.
        """
        raise NotImplementedError

    async def open_file(self, action: dict, ctx: ExecContext) -> DesktopOutcome:
        """open_file 실행(승인된 것이면 granted 블록 안에서). 새 창이 OPEN_FILE_WAIT_S 안에 보이지 않으면 unconfirmed."""
        raise NotImplementedError

    async def read_file(self, entry: FolderEntry, folder: DesktopView, ctx: ExecContext) -> DesktopOutcome:
        """read_file(가드: 읽을 수 있는 형식만) → core.documents.read_document 또는 글 파일 읽기. text에 잘린 글."""
        raise NotImplementedError

    async def bring_forward(self, window: WindowRef, ctx: ExecContext) -> DesktopOutcome:
        """focus_window. 내려 둔 창은 올린다(그림·관찰 전에 필요할 때 기술이 묻고 부른다)."""
        raise NotImplementedError

    def shot_source(self, view: DesktopView) -> ShotSource:
        """
        이 창을 찍을 대상. subject(): label=앱 이름 또는 "'<제목 앞 20자>' 창", text=UIA 이름(또는 폴더 목록 이름),
        credential=(kind == credential), shell=(kind == shell), minimized, secret_inputs=UIA 비밀번호 칸 있음.
        capture(): port.capture_window(hwnd).
        """
        raise NotImplementedError

    async def _run(self, action: dict, ctx: ExecContext, log: list[dict], path_check: bool = True) -> dict | None:
        """
        DesktopGuard.check(action, DesktopPolicyContext(stopped=ctx.is_stopped() or ctx.signal.aborted, approvals=ctx.approvals,
        actionsThisTurn=ctx.counter['actions'])) → log에 {agent, action, policy} → 허용 아니면 None
        → 조작 기록 '전'(실패 + 승인 필요 → LOG_FAILED) → place/rel이 있으면 resolve_in_place(없으면 TARGET_NOT_FOUND,
        폴더 밖이면 VERIFY_FAILED) → ctx.counter += 1 → port.execute(action, path, ctx.signal) → 기록 '후'.
        """
        raise NotImplementedError
