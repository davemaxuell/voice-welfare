"""
[새 파일] ④ 데스크톱 실행 에이전트. WebExecutionAgent의 짝이다.
모든 조작은 _run()에서 PolicyGuard.check_desk → 조작 기록 → DesktopPort → 다시 보기(검증)를 거친다.
기술(skills/desk.py)은 이 클래스만 부르고 포트를 직접 만지지 않는다.

이 클래스가 숨기는 것: 창 찾기·앞으로 가져오기, 경로 만들기와 뿌리 확인, 파일 종류 판정, 열렸는지 확인하기,
탐색기 창을 청음의 위치에 맞추기, 조작 기록, 시간 초과 처리.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Sequence

from cheongeum.agents.desktop.folders import PlaceRoots
from cheongeum.core.desk import DesktopPort
from cheongeum.core.exec import ExecContext, OutcomeStatus
from cheongeum.core.picture import Shot

# 파일·앱을 연 뒤 새 창을 기다리는 한도(초)
OPEN_WAIT_S = 4.0


@dataclass
class DeskOutcome:
    """WebOutcome과 같은 낱말(status)을 쓴다. 기술이 common.outcome_failure와 같은 방식으로 말로 바꾼다."""

    status: OutcomeStatus
    actions: list[dict]
    view: dict | None = None
    message: str | None = None
    # 이름이 여러 개 맞거나 못 찾았을 때 후보
    candidates: list[str] | None = None
    # needs-approval: 승인받으면 그대로 실행할 액션
    pending: dict | None = None
    # 연 것의 말할 이름("진단서.pdf", "메모장")
    opened: str | None = None
    readText: str | None = None
    shot: Shot | None = None


class DesktopAgent:
    id = "desktop-navigation-and-execution"

    def __init__(
        self,
        port: DesktopPort,
        guard: Any,
        roots: PlaceRoots,
        action_log: Any = None,
        known_private: Callable[[], Sequence[str]] = lambda: (),
    ) -> None:
        """
        guard = 웹과 같은 PolicyGuard 객체(check_desk를 쓴다). roots = 이 컴퓨터에서 켜진 장소의 실제 폴더.
        known_private = 사진에서 가릴 금고 값(런타임이 꽂는다. personal을 가져오지 않는다).
        """
        raise NotImplementedError

    @property
    def current_view(self) -> dict | None:
        """마지막으로 본 데스크톱 화면(DeskView). 폴더면 at·entries, 앱 창이면 items."""
        raise NotImplementedError

    def access_mode(self, view: dict | None) -> str:
        """guard.app_tier(view["app"])"""
        raise NotImplementedError

    async def observe(self, ctx: ExecContext | None = None) -> dict:
        """
        지금 자리를 다시 본다. 폴더에 있으면 read_folder(파일 시스템), 앱 창에 있으면 port.outline.
        창이 닫혔으면 errors에 "창이 닫혔어요"를 담은 view. 승인 문(_approve)의 다시 보기도 이것을 쓴다.
        """
        raise NotImplementedError

    async def open_folder(self, at: dict, ctx: ExecContext) -> DeskOutcome:
        """
        폴더로 간다: safe_path → show_folder 액션(_run) → read_folder. 성공의 기준은 폴더를 읽은 것이다.
        탐색기 창을 못 옮겼으면(창 없음·시간 초과) 폴더는 읽었으므로 ok이고 message에 "탐색기 창은 따라오지 못했어요".
        Escaped → policy-denied("그 폴더는 제가 들어갈 수 없는 곳이에요").
        """
        raise NotImplementedError

    async def up(self, ctx: ExecContext) -> DeskOutcome:
        """위 폴더로. 장소의 뿌리에서는 needs-clarification("여기가 다운로드 폴더의 맨 위예요")."""
        raise NotImplementedError

    async def open_entry(self, said: str, ctx: ExecContext) -> DeskOutcome:
        """
        지금 폴더에서 말한 이름의 항목을 연다.
          못 찾음·여러 개 → needs-clarification(candidates)
          폴더 → open_folder(한 단계 아래)
          파일 → open_file 액션.
                 DENIED_FILE_KIND → policy-denied("프로그램 파일은 제가 열지 않아요")
                 NEEDS_CONFIRMATION → point_at()한 뒤 needs-approval(pending=액션)
                 허용 → 실행하고 _opened()로 확인
        """
        raise NotImplementedError

    async def point_at(self, name: str, ctx: ExecContext) -> bool:
        """탐색기 창에서 그 항목을 고른다(show_folder + select). 누르기 전 '대상으로 초점 옮기기'. 못 옮겨도 묻는 것은 계속한다."""
        raise NotImplementedError

    async def run_approved(self, action: dict, ctx: ExecContext) -> DeskOutcome:
        """
        승인받은 액션 하나를 실행한다(ctx.granted 안에서 불린다). 열렸는지 _opened()로 확인하고,
        확인하지 못하면 unconfirmed: 다시 하지 않는다(같은 파일이 두 번 열릴 수 있다). 기술이 승인 대기를 둔 채 묻는다.
        """
        raise NotImplementedError

    async def launch(self, app_id: str, ctx: ExecContext) -> DeskOutcome:
        """앱을 켜거나 이미 뜬 창을 앞으로. AppSpec의 창 단서에 맞는 창이 OPEN_WAIT_S 안에 보이면 ok."""
        raise NotImplementedError

    async def press(self, said: str, ctx: ExecContext) -> DeskOutcome:
        """앱 창에서 이름으로 조작 요소 누르기(invoke). 찾기·되묻기·승인은 웹 follow_link와 같은 약속."""
        raise NotImplementedError

    async def act(self, act_name: str, ctx: ExecContext, value: str | None = None) -> DeskOutcome:
        """앱 표의 이름 붙은 동작. Recipe를 포트 호출로 바꾸는 곳은 여기 하나(match Keys/Press/TypeInto/ReadText)."""
        raise NotImplementedError

    async def read_file(self, said: str | None, ctx: ExecContext) -> DeskOutcome:
        """방금 연(또는 말한) 문서 파일의 경로를 safe_path로 만들어 돌려준다(readText는 기술이 주입된 문서 읽기로 채운다)."""
        raise NotImplementedError

    async def capture(self, ctx: ExecContext) -> DeskOutcome:
        """
        지금 앱의 창 하나를 가리고 찍는다(capture_window 액션). 웹 capture와 같은 순서:
        observe → picture_refusal(비밀번호 칸이 있는 창, 청음 자신의 창) → mask_plan(글 칸 전부 + 개인정보 이름) → _run → port.capture.
        """
        raise NotImplementedError

    async def _run(self, action: dict, ctx: ExecContext, log: list[dict], perform) -> dict | None:
        """
        safety.run.guarded_run에 데스크톱 것을 묶는다:
          decide = lambda a: self.guard.check_desk(a, DeskContext(stopped=..., approvals=ctx.approvals, actionsThisTurn=ctx.counter["actions"]))
          where  = Where(host=f"app:{action['app']}", kind=장소 id 또는 "")
          label  = redact_text(대상 이름)
        """
        raise NotImplementedError

    async def _opened(self, before: list[dict], hint: str) -> bool:
        """연 뒤의 확인: OPEN_WAIT_S 동안 창 목록을 다시 보아, 전에 없던 창이 생겼거나 제목에 hint(파일 이름 줄기)가 든 창이 앞에 왔는가."""
        raise NotImplementedError
