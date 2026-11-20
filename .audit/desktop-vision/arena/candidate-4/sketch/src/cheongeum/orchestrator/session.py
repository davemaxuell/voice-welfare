# 변경 부분만 보인다. 원본: src/cheongeum/orchestrator/session.py
# - NOT_DONE: line 73
# - _approve: line 1117, 재관찰은 kind에 따라 웹 또는 데스크톱 쪽으로 간다
# - ROUTES: line 1210 (DESKTOP_* 행과 DESCRIBE_SCREEN 분기 추가)

NOT_DONE = {
    "click": "누르지 않았어요.",
    "assist": "넣지 않았어요.",
    None: "모의접수하지 않았어요.",
    "desktop": "실행하지 않았어요.",  # 새 kind. 빠지면 KeyError(현재 구조)
}

APPROVAL_TTL_S = 120  # 웹과 같다. 데스크톱 승인도 같은 시계(OrchestratorDeps.clock)


class SessionOrchestrator:
    # 상태: Surface는 "마지막으로 연 쪽"이다. DESCRIBE_SCREEN이 어느 쪽을 볼지 정한다.
    # 소유자는 오케스트레이터 하나다(split ownership 금지). 다른 skill은 읽기만 한다.
    surface: Literal["web", "desktop"] | None

    async def _approve(self, turn: Turn) -> dict:
        """승인 문. 지문을 kind에 맞는 쪽에서 다시 확인한 뒤 ctx.granted 안에서 한 번 실행한다.

        kind "desktop":
          recheck = desktop_recheck(asked, desktop.observe_scope(...), action)
          실행   = self.desktop.run_approved(action, turn.ctx)
        그 밖은 현재 로직 그대로(web observe + recheck).
        """
        raise NotImplementedError
