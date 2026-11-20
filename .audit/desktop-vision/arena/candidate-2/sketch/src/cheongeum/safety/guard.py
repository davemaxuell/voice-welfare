"""
[바뀌는 것만] safety/guard.py — PolicyGuard는 여전히 모든 조작의 단일 관문이다. 문이 하나 더 생기는 것이 아니라
같은 클래스에 데스크톱 쪽 판정(check_desk)이 붙는다. 앞의 네 검사(형식 → 중단 → 횟수 → 종류)는 한 함수를 함께 쓴다.

등급의 근원
 - 웹: URL 출처(tier_of, guard.py:93). 그대로다. "uia://" 같은 가짜 주소를 allowedOrigins에 넣지 않는다.
 - 데스크톱: 앱 표(core/apps.py)의 AppSpec.tier와 장소 표의 PlaceSpec. app_tier가 읽는다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import AbstractSet, Any, Sequence

from cheongeum.core.apps import AccessTier


@dataclass
class PolicyConfig:
    # ... 기존 칸(guard.py:15-29)은 그대로 ...
    # 켜 둔 데스크톱 앱 id. 기본은 닫힘(빈 목록): 직접 만든 설정과 다른 OS에서는 데스크톱 조작이 모두 DENIED_APP.
    desktopApps: Sequence[str] = ()


@dataclass
class DeskContext:
    """check_desk가 보는 것. 화면 글·창 제목은 넣지 않는다(판정은 액션과 표만으로)."""

    stopped: bool = False
    approvals: AbstractSet[str] = field(default_factory=set)
    actionsThisTurn: int = 0


# 웹 쪽 변경은 두 줄:
#   READ_ONLY_TYPES(guard.py:49)에 "capture"를 더한다(읽기 전용 사이트의 화면도 사진으로 설명한다).
#   server/runtime.py:264 allowedActionTypes에 "capture"를 더한다.
#   tier == "none"이면 지금처럼 DENIED_ORIGIN이라 빈 화면·허용되지 않은 주소는 찍히지 않는다.


class PolicyGuard:
    # ... __init__, is_allowed_url, tier_of, check, _risky_button, _check_read_only 는 그대로 ...

    def app_tier(self, app_id: str | None) -> AccessTier:
        """앱의 접근 등급. 표에 없거나 켜 두지 않은 앱은 none. TurnResult.accessMode도 이것을 쓴다."""
        raise NotImplementedError

    def check_desk(self, candidate: Any, ctx: DeskContext) -> dict:
        """
        데스크톱 조작 판정. 돌려주는 모양은 check와 같다({"allowed", "code", "reason"}).

        순서
          1. parse_desk_action 실패 → DENIED_SCHEMA (좌표·경로 문자열·모르는 칸이 여기서 걸린다)
          2. 중단 → DENIED_STOPPED / 횟수 → DENIED_RATE_LIMIT        (check와 같은 함수)
          3. app이 표에 없거나 desktopApps에 없음 → DENIED_APP
          4. type이 그 앱의 verbs에 없음 → DENIED_ACTION_TYPE
          5. 종류별:
             show_folder  저위험.
             open_file    file_kind(name): program → DENIED_FILE_KIND("프로그램 파일은 청음이 열지 않습니다"),
                          other·archive → 승인 필요, document·image·media → 저위험.
             invoke       이름이 SECRET_LABEL → DENIED_SECRET. tier가 read-only면 RISKY_BUTTON 이름은 거부,
                          full이면 RISKY_BUTTON 이름은 승인 필요(웹과 같은 규칙, 같은 정규식).
             act          ActSpec을 표에서 찾는다(없으면 DENIED_ACTION_TYPE). 위험도 = max(표의 risk, 액션의 risk).
                          value가 있으면 detect_sensitive(model=False).hasSecretValue → DENIED_SECRET.
             capture_window  AppSpec.picture: never → DENIED_PICTURE, ask → 승인 필요, free → 저위험.
             launch       저위험.
          6. 위험도가 low가 아니거나 requiresConfirmation이면 승인 확인: id가 approvals에 있으면 APPROVED, 없으면 NEEDS_CONFIRMATION.
             (웹의 read-only처럼 조용히 거부하지 않는다. 물어서 될 일은 묻는다.)
          7. ALLOWED

        위험도는 부르는 쪽이 높일 수만 있다: 5의 판정이 액션에 적힌 risk보다 낮아지는 일은 없다.
        """
        raise NotImplementedError
