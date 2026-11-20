"""데스크톱 행동 계약. 웹 `Action`과 분리된 엄격한 모델이다.

model이 고를 수 있는 것은 `op`와 이름뿐이다. 경로·명령·좌표 필드는 `extra="forbid"`로 거부된다.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from cheongeum.core.desktop import DesktopOp


class DesktopAction(BaseModel):
    """`op`별 필수 필드는 model_validator에서 검사한다(PLAN U5)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    op: DesktopOp
    name: str | None = Field(default=None, max_length=120)  # 앱 이름, 폴더 이름, 항목 이름
    reason: str = Field(default="", max_length=200)  # 사용자 말로 만든 이유(확인 문장용)


def parse_desktop_action(candidate: object) -> dict | None:
    """경계에서 한 번만 검증하고 camelCase dict를 돌려준다(원본 parse_action과 같은 모양).

    실패하면 None. 가드는 DENIED_SCHEMA를 낸다. 모델 안의 빈 선택 항목은 빠진다(exclude_none).
    """
    raise NotImplementedError
