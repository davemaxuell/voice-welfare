"""
[바뀌는 부분만] agents/web/agent.py

1. ExecContext·OutcomeStatus는 core/context.py로 옮겼다(U0). 여기서는 가져다 쓴다.
2. shot_source(view): 지금 페이지를 찍을 ShotSource. 관찰(view)과 어댑터만 쓴다.
   어댑터 메서드 probe_masks()/capture(plan)는 PlaywrightExecutionAdapter에 더하고 ExecutionAdapter Protocol(core/actions.py:217)에도 적는다.
"""
from __future__ import annotations

from cheongeum.core.context import ExecContext, OutcomeStatus  # noqa: F401  (U0)
from cheongeum.core.shot import CaptureRefusal, MaskedShot, ShotSource, ShotSubject


class WebExecutionAgent:
    # ... 지금 그대로 ...

    def shot_source(self, view: dict) -> ShotSource:
        """
        이 화면을 찍을 대상. subject()는:
          label="웹 페이지", title=view.title, text=제목·소제목·digest 본문(원문), names=outline.items 이름,
          secret_inputs=password_fields(view), auth=auth_page_kind(view)(U0에서 mainText 버그 고침),
          captcha = 어댑터 probe_masks()의 captcha 또는 safety.shot_policy.BLOCKED가 제목·본문 앞 600자에 있음.
        capture()는 probe_masks() → capture.plan_masks → adapter.capture(plan).
        """
        return _WebShot(self, view)


class _WebShot:
    """ShotSource 구현(모듈 안에서만 만든다)."""

    def __init__(self, agent: WebExecutionAgent, view: dict) -> None:
        self._agent = agent
        self._view = view
        self._plan = None  # subject()에서 한 번 만든 MaskPlan을 capture()가 그대로 쓴다(사이에 바뀌면 capture가 다시 만든다)

    async def subject(self) -> ShotSubject:
        raise NotImplementedError

    async def capture(self) -> MaskedShot | CaptureRefusal:
        raise NotImplementedError
