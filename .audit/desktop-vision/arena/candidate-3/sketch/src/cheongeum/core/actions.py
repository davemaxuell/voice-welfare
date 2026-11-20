"""
core/actions.py: 바뀌는 곳만. 나머지는 그대로.

세 가지가 바뀐다. 모두 더하기뿐이고 기존 값은 바뀌지 않는다.
  1) AccessTier를 safety/guard.py:11에서 이곳으로 옮긴다(core/apps.py의 AppSpec.tier가 같은 낱말을 쓰는데 core는 safety를 가져올 수 없다).
     guard.py는 여기서 가져오고, safety/__init__.py의 다시 내보내기는 그대로 둔다.
  2) 웹 동작에 "capture"(이 쪽 화면의 사진 찍기)를 더한다. 가드·기록·속도 제한을 모두 지나게 하려는 것이다(아래 설명).
  3) ScreenOutline에 media를 더한다(observe.js:219 outline 끝에 센 값). 글이 적은 화면을 알아보는 데만 쓴다.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import Field

# --- 1) (신규) 접근 등급. safety/guard.py:11 에서 이동
AccessTier = Literal["full", "read-only", "none"]

# --- 2) actions.py:16-17 ACTION_TYPES / ActionType
ACTION_TYPES = ("navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus", "capture")
ActionType = Literal["navigate", "back", "click", "fill", "press", "select", "check", "scroll", "read", "focus", "capture"]

# capture가 Action인 이유: 화면 사진을 OpenAI로 보내는 것은 '나가는 데이터'라서 조작처럼 (가) 가드의 허락, (나) 조작 기록(ActionLog, 봉인됨)
# 전·후 줄, (다) 한 턴의 횟수 제한을 모두 거쳐야 한다. 사진 바이트는 Action·ActionResult에 실리지 않는다:
# 어댑터가 MaskedShot을 만들어 호출자(WebExecutionAgent.capture)에게 직접 돌려주고, ActionResult에는 ok·latencyMs만 남는다.
# 기존 ActionTarget·Action 모양은 바뀌지 않는다(target 없이 reason·risk만 쓴다). 좌표는 여전히 없다(test_policy.py:50).


# --- 3) actions.py:168 ScreenOutline에 칸 하나
class MediaHint:  # 실제로는 _Loose 모델. 값은 observe.js가 센다.
    bigImages: int = Field(ge=0)  # 화면 넓이의 5% 넘는 <img>·background-image 요소
    bigImagesWithoutAlt: int = Field(ge=0)
    canvases: int = Field(ge=0)
    frames: int = Field(ge=0)
    videos: int = Field(ge=0)


class ScreenOutline:  # 기존 모델에 이 한 줄만 더한다
    media: Optional[MediaHint] = None
