"""
core/turn.py: 바뀌는 곳만. 나머지는 그대로.

  1) SESSION_STATES·SessionState·STATE_LABELS_KO에 APP_OPEN 하나. 세 곳이 손으로 맞춰지던 것을 한 곳(튜플)에서 파생한다.
  2) SEMANTIC_ACTIONS와 SemanticAction이 같은 목록을 두 번 적던 것(turn.py:166, :208)을 하나로. 새 의미 동작 다섯 개.
  3) ExecutedAction.action이 웹 Action만 받던 것(turn.py:159-163)을 앱 동작도 받게. 안 하면 앱 턴이 _finish에서 RECOVERING으로 끝난다.
  4) TurnResult에 seen 한 칸: 이 답을 글로 했는지 사진으로 했는지(UI·평가가 읽는다). 선택 칸이라 기존 클라이언트는 영향 없음.
  5) AGENT_IDS에 앱 에이전트 이름.
"""
from __future__ import annotations

from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict

from cheongeum.core.actions import Action, ActionResult
from cheongeum.core.desktop import AppAction


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)


# --- 1) 상태: 튜플이 원본, Literal은 파생(타입 검사기에는 보이지 않으므로 test_registry가 같은지 본다)
SESSION_STATES = (
    "AWAITING_CONSENT",
    "IDLE",
    # ... 기존 그대로 ...
    "BROWSING",
    "APP_OPEN",  # 신규: 앱(파일 탐색기 등)을 조작·설명하는 중. 화면 초점의 단 하나의 근거다(아래 '왜 별도 초점 칸이 없는가').
    # ... 기존 그대로 ...
)
SessionState = Literal[SESSION_STATES]  # type: ignore[valid-type]
STATE_LABELS_KO_ADD = {"APP_OPEN": "앱 조작 중"}

# 왜 별도 초점 칸(DialogueState.app 같은)이 없는가:
#  화면 초점은 이미 세션 상태가 말한다. 웹 턴은 browse_state(common.py:27)로 BROWSING 등을, 앱 턴은 APP_OPEN을 돌려주고
#  _finish가 commit한다(session.py:593). 웹으로 돌아가는 모든 길이 자동으로 APP_OPEN을 벗어나므로 '초점을 되돌리는 곳'을 찾아 고칠 필요가 없다.
#  어느 앱인지는 DesktopAgent.current_view["app"]이 안다(웹이 web.current_view를 아는 것과 같다). 한 사실을 두 곳에 두지 않는다.

# --- 2) 의미 동작: 튜플이 원본
SEMANTIC_ACTIONS = (
    # ... 기존 40개 그대로(turn.py:166-207) ...
    "open-app",
    "open-item",
    "list-items",
    "go-up",
    "confirm-shot",  # 사진을 보내도 되는지 묻는 중
)
SemanticAction = Literal[SEMANTIC_ACTIONS]  # type: ignore[valid-type]  # 두 번째 손 목록을 지운다


# --- 3) 실행된 동작: 웹 또는 앱. 두 모델의 type 값이 겹치지 않아(AppVerb ↔ ActionType) 어느 쪽인지 모호하지 않다.
class PolicyDecision(_M):
    allowed: bool
    code: str
    reason: str


class ExecutedAction(_M):
    agent: str
    action: Union[Action, AppAction]
    policy: PolicyDecision
    result: Optional[ActionResult] = None


# --- 4) 글로 했는지 사진으로 했는지
class SeenInfo(_M):
    via: Literal["text", "screenshot", "both"]
    # 사진에서 가린 칸·글·액자 수(숫자만. 무엇을 가렸는지는 남기지 않는다)
    masked: int = 0


class TurnResult(_M):
    # ... 기존 칸 그대로 ...
    seen: Optional[SeenInfo] = None


# --- 5)
class AGENT_IDS:
    # ... 기존 그대로 ...
    desktop = "desktop-navigation-and-execution"
    # 사진 길(Sight)은 화면 이해 담당(screen)의 일이라 새 이름을 만들지 않는다.
