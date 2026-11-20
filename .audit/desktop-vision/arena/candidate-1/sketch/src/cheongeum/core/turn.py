"""
[바뀌는 부분만] core/turn.py

1. SemanticAction을 SEMANTIC_ACTIONS에서 만든다(지금은 같은 목록을 두 번 손으로 적음, turn.py:166-249).
   새 값: open-app, list-items, open-item, read-item, confirm-open.
2. ExecutedAction.action = 웹 Action | DesktopAction (type으로 가른다. 두 동작 이름은 겹치지 않는다).
3. Flags.picture: 이번 답에 그림으로 본 내용이 들어 있다(UI·평가가 구별할 수 있게).
4. AGENT_IDS에 desktop·picture.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional, Union

from pydantic import Field

from cheongeum.core.actions import Action, ActionResult
from cheongeum.core.desktop import DesktopAction


class AGENT_IDS:
    orchestrator = "orchestrator"
    welfare = "welfare-information-and-dialogue"
    web = "web-navigation-and-execution"
    screen = "screen-understanding"
    verifier = "answer-verifier"
    # 새: 데스크톱 앱·파일(이름 붙은 동작만)
    desktop = "desktop-apps-and-files"
    # 새: 화면 그림 설명(OpenAI)
    picture = "screen-picture"


SEMANTIC_ACTIONS = (
    # ... 지금 목록 그대로(turn.py:167-206) ...
    "describe-screen",
    "none",
    # 새
    "open-app",
    "list-items",
    "open-item",
    "read-item",
    "confirm-open",
)
# 목록 하나에서 만든다(손으로 두 번 적지 않는다)
SemanticAction = Literal[SEMANTIC_ACTIONS]  # type: ignore[valid-type]

AnyAction = Annotated[Union[Action, DesktopAction], Field(discriminator="type")]


class ExecutedAction:  # (_M) 실제로는 지금 클래스의 action 타입만 바꾼다
    agent: str
    action: AnyAction
    policy: "PolicyDecision"  # noqa: F821
    result: Optional[ActionResult] = None


class Flags:  # (_M)
    secretDetected: bool
    masked: bool
    # 새: 답에 그림(스크린숏)에서 읽은 내용이 있다. 말로도 "그림을 보고"라고 밝힌다.
    picture: bool = False
