"""
[새 파일] 승인 문의 표면별 주인. SessionOrchestrator._approve는 하나로 남고(시간 2분·'바뀌었어요'·granted), 화면을 다시 보고 지문을
비교하는 일과 승인된 일을 실행하는 일만 주인에게 맡긴다.
 - 웹: WebApprovals(아래). 지금 _approve(session.py:1127-1149)의 관찰·recheck·kind 갈래(click/assist/None)를 그대로 옮긴다.
 - 데스크톱: DesktopSkill(recheck·run_approved·not_done).
승인 대기 dict의 'surface'가 없으면 웹(지금 대기 중인 승인과 시험이 그대로 돈다). NOT_DONE[kind]의 KeyError 함정은 사라진다:
'하지 않았어요' 문장을 주인이 말한다.
"""
from __future__ import annotations

from typing import Protocol

from cheongeum.core.context import ExecContext, Rechecked


class ApprovalOwner(Protocol):
    async def recheck(self, approval: dict, ctx: ExecContext) -> Rechecked: ...

    async def run_approved(self, approval: dict, ctx: ExecContext) -> dict: ...

    def not_done(self, approval: dict) -> str: ...


class WebApprovals:
    """웹 승인 주인. 생성자는 (web, browse, form, guided)."""

    # 지금 session.py:73의 NOT_DONE 그대로(웹 kind만)
    NOT_DONE = {"click": "누르지 않았어요.", "assist": "넣지 않았어요.", None: "모의접수하지 않았어요."}

    async def recheck(self, approval: dict, ctx: ExecContext) -> Rechecked:
        """view = web.observe(ctx); now, changed = agents.web.approval.recheck(approval['fingerprint'], view, actions)
        → Rechecked(now, changed, browse_state(view), {'view': view})"""
        raise NotImplementedError

    async def run_approved(self, approval: dict, ctx: ExecContext) -> dict:
        """kind == click → browse.click_approved, assist → form.assist_approved(+ guided.after_assist), None → form.submit_approved."""
        raise NotImplementedError

    def not_done(self, approval: dict) -> str:
        return self.NOT_DONE[approval.get("kind")]


# SessionOrchestrator._approve(바뀐 모양):
#
#     approval = self.dialogue.approval
#     if not approval: ...지금과 같음
#     owner = self.desktop if approval.get("surface") == "desktop" else self._web_approvals
#     checked = await owner.recheck(approval, turn.ctx)
#     if checked.changed:
#         self.dialogue.clear_approval()
#         return draft(checked.state, "none", f"{checked.changed} 그래서 {owner.not_done(approval)} 바뀐 대로 하시려면 한 번 더 말씀해 주세요.", **checked.extra)
#     if self.dialogue.approval_age >= APPROVAL_TTL_S:
#         self.dialogue.ask_approval({**approval, "fingerprint": checked.fingerprint})
#         return draft("WAITING_FOR_USER_CONFIRMATION", <semantic by surface/kind>, f"여쭤본 지 2분이 지나서 다시 여쭤볼게요. {checked.fingerprint['speech']}", **checked.extra)
#     with turn.ctx.granted([a["id"] for a in approval.get("actions") or [approval["action"]]]):
#         return await owner.run_approved(approval, turn.ctx)
