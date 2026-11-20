"""
orchestrator/session.py: 바뀌는 곳만. 오케스트레이터는 '순서·문·라우팅'만 하는 원칙을 지킨다. 새 일은 모두 협력 객체(Sight, AppSkill)가 한다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class _OrchestratorDepsChanges:
    """OrchestratorDeps(session.py:43)에 칸 둘. 기본값이 None이라 기존 생성처(테스트 포함)는 그대로 돈다."""

    # 사진 보는 모델(OpenAI). None이면 사진 설명 꺼짐. runtime이 LLM_VISION_*에서 만든다.
    vision: Any = None
    # 앱 에이전트. None이면 데스크톱 기능 꺼짐(윈도가 아님, 또는 DESKTOP_APPS 꺼짐).
    desktop: Any = None


class _SessionOrchestratorChanges:
    def __init__(self_) -> None:  # noqa: N805  (SessionOrchestrator.__init__, session.py:100 에 더해지는 줄)
        #   self._grants: set[str] = set()                        # 이번 대화 동안의 허락. 주인은 여기 하나(approvals와 같은 방식, session.py:114)
        #   self.sight = Sight(deps.vision)
        #   self.apps = AppSkill(deps.desktop, self.dialogue)
        #   self.browse = BrowseSkill(..., sight=self.sight)       # session.py:107 한 인자 더
        pass

    # _begin_turn(session.py:328-338): ExecContext(..., grants=self._grants)  한 인자 더. 같은 set을 참조한다.

    # _stop(session.py:275-286): self._approvals.clear() 옆에 self._grants.clear()  → 멈춘 뒤 첫 사진은 다시 묻는다.
    #   (멈춤이 지우는 대기 여섯 가지 + 허락. dialogue.stop()은 대기 자리만 알고 허락은 오케스트레이터의 것이라 여기서 지운다.)

    # _finish(session.py:587-651): 세 군데가 바뀐다.
    #   a) 화면·접근 등급은 초안이 정한다(웹 초안은 지금처럼, 앱 초안은 surface="app"):
    #        app = draft.get("surface") == "app"
    #        view = None if app else (draft.get("view") or self.web.current_view)                       # session.py:597
    #        "page": draft["page"] if app else (view.get("pageId") if view else None)                    # :632
    #        "accessMode": draft["access"] if app else (self.web.access_mode(view) if view else None)    # :633
    #        "observation": None if app else self._summarize(view)                                       # :638
    #   b) 대화 기록(LLM에 가는 것)에는 이름이 든 말을 넣지 않는다:
    #        self._history_speech(draft.get("historySpeech") or speech)                                  # :601
    #   c) 글로 했는지 사진으로 했는지: "seen": draft.get("seen")                                         # TurnResult.seen

    # _approve(session.py:1117-1149): orchestrator/approvals.py의 표를 읽는 모양으로(그 파일 아래 설명). NOT_DONE(:73)은 지운다.

    # _open_browser(session.py:871-880): 마지막 줄이 draft(self.dialogue.state, ...)라 앱 상태에서 '크롬 켜줘'를 해도 APP_OPEN에 남는다.
    #   draft(browse_state(view) if view else "IDLE", "open-browser", ...) 로 고쳐 웹으로 돌아오는 길을 하나 더 확실히 한다.

    # _what_can_i_say(session.py:904-930): 앱 상태면 lead = ("내 컴퓨터",).


# ROUTES(session.py:1210-1248)에 줄이 더해지고 둘이 상태로 갈린다.
ROUTES_ADDED = {
    # "OPEN_APP":      lambda s, i, t: s.apps.open_app(i["target"], t.ctx),
    # "APP_OPEN_ITEM": lambda s, i, t: s.apps.open_item(i["name"], t.ctx),
    # "APP_LIST":      lambda s, i, t: s.apps.read_list(bool(i["more"]), t.ctx),
    # "APP_UP":        lambda s, i, t: s.apps.up(t.ctx),
    # "APP_READ_ITEM": 2차
}
ROUTES_BY_STATE = {
    # session.py:1233 "DESCRIBE_SCREEN": lambda s, i, t: s.apps.describe(t.text, t.ctx) if s.state == "APP_OPEN" else s.browse.screen(t.text, t.ctx),
    # session.py:1220 "PREV": 이미 is_form_open로 가르는 줄에 한 갈래 더: elif s.state == "APP_OPEN": s.apps.back(t.ctx)
}
# 이 둘만 ROUTES에서 상태로 갈린다(DESCRIBE_SCREEN·PREV는 웹과 앱이 같은 말을 쓰는 보편 말이다).
# 나머지는 '말을 어느 의도로 읽느냐'를 규칙 파서가 상태로 정한다: APP_OPEN에서 '눌러·열어·가줘·읽어줘·목록'은 앱 의도로 먼저 읽혀서(rules.py 앱 블록)
# 웹 의도(FOLLOW_LINK, READ_MAIN, LIST_LINKS)가 앱 말을 가로채 보이지 않는 웹 화면을 누르는 일이 없다.
# LLM 계획이 앱 상태에서 FOLLOW_LINK를 내는 경우를 막는 안전망: 오케스트레이터가 _route 앞에서 state == "APP_OPEN"이고
# 의도가 {FOLLOW_LINK, READ_MAIN, LIST_LINKS}면 실행하지 않고 "지금은 {앱 이름}을 보고 있어요. 웹으로 가려면 '브라우저 열어줘'라고 하세요."라고 답한다(한 곳, 이 세 개만).
