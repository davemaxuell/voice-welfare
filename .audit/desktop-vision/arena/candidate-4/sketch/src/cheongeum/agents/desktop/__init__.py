"""데스크톱 에이전트: 이름으로 지정한 앱·폴더·항목을 연다.

공개 표면은 `DesktopAgent.run` 하나다. 가드 확인, 목록 해석(이름→항목),
포트 호출, 재확인, 기록은 안에서 끝난다. 웹 `WebExecutionAgent`와 형제이고 상속하지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Status = Literal["ok", "needs-approval", "not-found", "ambiguous", "policy-denied", "unconfirmed", "failed"]


@dataclass(frozen=True)
class DesktopOutcome:
    status: Status
    speech: str  # 코드가 만든 한국어 문장. 모델 글 없음
    pending: dict | None = None  # needs-approval일 때 승인 대기 행동
    items: tuple[str, ...] = ()  # list·open_folder의 항목 이름(화면 글 아님, 목록 이름)


class DesktopAgent:
    def __init__(self, port, guard, apps, action_log=None) -> None:
        """port: agents/desktop/port.py의 DesktopPort. guard: safety/desktop_guard.DesktopGuard."""
        self._port = port
        self._guard = guard
        self._apps = apps
        self._log = action_log

    async def run(self, action: dict, ctx) -> DesktopOutcome:
        """한 행동을 실행한다.

        순서: 가드(스키마·멈춤·앱 등급·폴더 경계) → 이름 해석(현재 목록) → 승인 필요 시
        pending 반환 → 포트 호출 → 재관찰로 결과 확인 → 기록.
        같은 이름이 둘 이상이면 ambiguous로 되묻는다. 경로를 추측하지 않는다.
        """
        raise NotImplementedError
