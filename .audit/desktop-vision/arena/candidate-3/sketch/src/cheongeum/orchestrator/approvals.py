"""
승인의 종류 표: 승인 대기(dialogue.approval)의 kind마다 한 줄. _approve(session.py:1117)가 이 표를 읽는다.

지금은 _approve 안의 if 셋(click·assist·None, session.py:1142-1149)과 NOT_DONE(session.py:73, 키가 셋뿐이라 새 종류가 KeyError)과
'시간 지나 다시 물을 때의 의미 동작'(session.py:1136)이 같은 사실을 따로 적는다. 새 종류가 둘 더 온다(shot, app).
그래서 한 줄에 모은다: 어느 세계(웹·앱)를 다시 보고, 못 했을 때 무슨 말을 하고, 실행은 무엇인가.
kind=None은 기존 모의접수 제출(form.py:360 ask_approval에 kind가 없다)이라 키로 그대로 둔다. 이름을 붙이는 일은 따로 한다.

ask_approval을 부르는 곳(browse.py:231, form.py:101, form.py:360, guided.py:127)이 쓰는 kind가 모두 이 표에 있는지는
tests/unit/test_approvals_table.py가 AST로 센다(표에 없는 kind를 쓰면 그 순간 실패).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Awaitable, Callable, Literal

if TYPE_CHECKING:
    from cheongeum.orchestrator.session import SessionOrchestrator, Turn

Run = Callable[["SessionOrchestrator", dict, "Turn"], Awaitable[dict]]


@dataclass(frozen=True)
class ApprovalKind:
    world: Literal["web", "app"]  # 승인 뒤 어느 쪽 화면을 다시 보고 지문을 비교하나
    not_done: str  # 지문이 달라져 하지 않은 일("누르지 않았어요.")
    semantic: str  # 2분이 지나 다시 물을 때의 의미 동작("confirm-click")
    run: Run  # 승인됐고 지문도 같을 때 할 일. ctx.granted(ids) 안에서 불린다.
    reject: Callable[["SessionOrchestrator"], dict]  # '거절'을 들었을 때의 상태와 말(아래 설명)


# 줄 내용(구현 때 채운다). 기존 세 줄은 현재 _approve의 분기를 그대로 옮긴 것이다.
APPROVALS: dict[str | None, ApprovalKind] = {
    # "click":  ApprovalKind("web", "누르지 않았어요.", "confirm-click",   lambda s, a, t: s.browse.click_approved(a, t.ctx)),
    # "assist": ApprovalKind("web", "넣지 않았어요.",   "prepare-submit",  <assist 분기: session.py:1144-1148>),
    # None:     ApprovalKind("web", "모의접수하지 않았어요.", "prepare-submit", lambda s, a, t: s.form.submit_approved(a["action"], t.ctx)),
    # 신규
    # "shot":   ApprovalKind("web", "사진을 보내지 않았어요.", "confirm-shot",
    #                         <s._grants.add("shot") 뒤 s.browse.screen(a["then"]["text"], t.ctx)>),
    # "app":    ApprovalKind("app", "열지 않았어요.", "open-item", lambda s, a, t: s.apps.approved(a, t.ctx)),   # 2차
}

# _approve가 이 표로 바뀌는 모양(session.py:1117-1149):
#
#   approval = self.dialogue.approval ...                              (그대로)
#   kind = APPROVALS[approval.get("kind")]
#   view = await (self.web if kind.world == "web" else self.desktop).observe(turn.ctx)
#   now, changed = (recheck if kind.world == "web" else recheck_app)(approval["fingerprint"], view, actions)
#   if changed: ... f"{changed} 그래서 {kind.not_done} 바뀐 대로 하시려면 한 번 더 말씀해 주세요."      (browse_state(view)는 world별: 앱이면 APP_OPEN)
#   if self.dialogue.approval_age >= APPROVAL_TTL_S: ... kind.semantic ...                            (그대로)
#   with turn.ctx.granted([a["id"] for a in actions]): return await kind.run(self, approval, turn)
#
# REJECT(session.py:1230 s.form.reject())도 kind별이어야 한다. 지금 reject()는 kind가 assist·click이 아니면 모두
# "모의접수를 하지 않았어요"로 끝난다(form.py:411-421). 그대로 두면 사진 승인이나 앱 승인을 거절했을 때 모의접수를 거절했다고 말한다.
# 같은 표에 reject 칸(Reject = Callable[[Session], dict])을 더해 kind마다 상태와 말을 한 곳에 둔다:
#   shot → 상태 그대로, "사진은 보내지 않았어요. 글로만 설명해 드릴게요." / app → "APP_OPEN", "열지 않았어요. 폴더는 그대로예요."
# form.reject()는 표를 읽는 얇은 진입점이 되고 자기 분기를 표로 옮긴다(옮기고 옛 분기를 같은 변경에서 지운다).
