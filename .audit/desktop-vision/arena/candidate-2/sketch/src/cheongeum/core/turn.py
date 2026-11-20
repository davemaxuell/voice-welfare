"""
[바뀌는 것만] core/turn.py
"""
from __future__ import annotations

from typing import Optional, Union

from pydantic import BaseModel

from cheongeum.core.actions import Action, ActionResult
from cheongeum.core.desk import DeskAction

# 1. 세션 상태 하나: 앱 창·폴더에 있는 동안(BROWSING의 짝). 세 곳(SESSION_STATES :13, SessionState :38, STATE_LABELS_KO :66)에 더한다.
#    "DESKTOP": "컴퓨터 앱 사용 중"

# 2. 실행 기록의 액션은 웹 Action이거나 DeskAction(turn.py:159). 둘 다 extra="forbid"이고 type 값이 겹치지 않아 하나로만 읽힌다.
#    _finish의 이벤트 기록(session.py:612 a["action"]["type"])과 평가 코드는 두 모양 모두에 type이 있어 그대로 돈다.


class ExecutedAction(BaseModel):
    agent: str
    action: Union[Action, DeskAction]
    policy: "PolicyDecision"  # 그대로
    result: Optional[ActionResult] = None


# 3. semanticAction 다섯 개(SEMANTIC_ACTIONS :166, SemanticAction :208 두 곳에 더한다)
#    "look"        화면 사진을 보고 설명함
#    "open-app"    앱을 켬
#    "open-folder" 폴더를 열고 목록 첫머리를 읽음
#    "open-file"   파일을 기본 앱으로 엶
#    "app-act"     앱의 이름 붙은 동작(메모장 저장 등, 탐색기 다음 앱부터)
#    폴더·앱 창에서의 화면 설명·목록·읽기·뒤로·승인 질문은 기존 낱말을 그대로 쓴다
#    (describe-screen, list-links, read-main, back, confirm-click).

# 4. 응답이 사진에서 왔는지(turn.py:311). UI가 "사진으로 본 내용" 표시를 붙이고, 평가가 본다.


class Flags(BaseModel):
    secretDetected: bool
    masked: bool
    # 이 턴의 말에 화면 사진을 보고 만든 설명이 들어 있다(글 근거 검증을 거치지 않은 내용)
    fromImage: Optional[bool] = None


# 5. AGENT_IDS에 둘:
#    desktop = "desktop-navigation-and-execution"
#    vision = "picture-description"
