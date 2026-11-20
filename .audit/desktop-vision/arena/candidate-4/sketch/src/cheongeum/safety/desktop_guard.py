"""데스크톱 가드. `PolicyGuard`와 같은 결과 모양 {allowed, code, reason}을 낸다.

PolicyGuard는 바꾸지 않는다. 등급은 URL이 아니라 `Scope`(앱 항목)에서 온다.
규칙은 올릴 수만 있다(허용 → 확인 → 거부). 확인은 승인 한 번에 한 행동이다.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

# safety는 core만 가져온다(test_layers.ALLOWED). 앱 항목 타입은 core/desktop.py에 있다.
from cheongeum.core.desktop import AppEntry

# 실행 파일은 항상 거부한다. 확인으로도 열지 않는다.
DENIED_EXTENSIONS = frozenset({".exe", ".bat", ".cmd", ".ps1", ".msi", ".scr", ".lnk", ".com", ".vbs", ".js", ".reg", ".dll"})


@dataclass(frozen=True)
class DesktopContext:
    stopped: bool
    approvals: frozenset[str]
    actions_this_turn: int
    user_folders: tuple[Path, ...]  # 바탕화면·문서·다운로드·사진. 시작 때 한 번 정한다.


class DesktopGuard:
    def check(self, action: dict, app: AppEntry, ctx: DesktopContext, *, target_path: Path | None = None) -> dict:
        """순서: 스키마 → 멈춤 → 횟수(12) → op가 등급에 맞는지 → 폴더 경계 → 확장자 → 승인.

        - op "launch"(open_app)와 "open_item"은 승인 필요(consequential).
        - op "list", "read_window", "go_up", "open_folder"는 폴더 경계 안이면 허용.
        - target_path가 user_folders 밖이면 DENIED_ORIGIN 코드로 거부(이름 이유를 말한다).
        """
        raise NotImplementedError
