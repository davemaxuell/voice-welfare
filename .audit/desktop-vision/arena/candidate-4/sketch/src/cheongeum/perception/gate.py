"""그림을 보낼지 정하는 순수 함수. 입출력만 있고 브라우저·네트워크가 없다.

규칙은 실패 닫힘이다. 하나라도 걸리면 그림은 보내지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cheongeum.perception.screen import ExplainRequest, ScreenRead

Reason = Literal["ok", "auth", "blocked", "sensitive", "iframe", "login-title", "not-requested"]


@dataclass(frozen=True)
class PictureDecision:
    allowed: bool
    reason: Reason


def decide_picture(read: ScreenRead, request: ExplainRequest, *, scope_kind: str) -> PictureDecision:
    """그림을 보내도 되는지 정한다.

    - 사용자가 그림을 청하지 않았고 글이 충분하면 그림을 보내지 않는다(source="auto").
    - auth_kind가 other가 아니면 로그인·본인인증 화면이다. 보내지 않는다.
    - blocked면 CAPTCHA·차단 화면이다. 보내지 않는다. 우회하지 않는다.
    - has_sensitive면 가릴 수 없는 값이 있을 수 있다. 보내지 않는다.
    - 웹에서 iframe이 있으면 보이지 않는 입력(보안문자 등)이 있을 수 있다. 보내지 않는다.
    """
    raise NotImplementedError
