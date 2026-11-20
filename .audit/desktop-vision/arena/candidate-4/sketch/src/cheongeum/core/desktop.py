"""데스크톱 공용 타입. safety·agents·orchestrator가 모두 여기서 가져온다.

layer 규칙: core는 아무것도 가져오지 않는다. 앱 표의 값(APPS)은 agents/desktop/apps.py에 있다.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DesktopOp = Literal["open_app", "open_folder", "list", "open_item", "read_window", "go_up"]
Tier = Literal["read", "act"]  # read: 읽기·목록만. act: 실행 또는 항목 열기까지


@dataclass(frozen=True)
class AppEntry:
    id: str  # 안정 id. Scope.id와 승인 지문에 쓴다
    names: tuple[str, ...]  # 사용자가 부르는 이름(한국어·영어)
    process: str  # 창 찾기 기준 프로세스 이름
    window_class: str  # 예: 탐색기는 "CabinetWClass"
    launch_argv: tuple[str, ...] | None  # None이면 실행 불가(읽기 전용 대상)
    tier: Tier
    folder_scope: bool  # 폴더 경계(사용자 폴더 안)를 적용하는지
