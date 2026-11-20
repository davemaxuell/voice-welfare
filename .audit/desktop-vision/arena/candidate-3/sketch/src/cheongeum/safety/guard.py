"""
safety/guard.py: 바뀌는 곳만. PolicyGuard는 여전히 모든 조작의 단 하나의 문이다.

등급(tier)의 출처가 둘이 된다.
  웹 동작: 현재 주소의 출처(guard.py:93 tier_of, :116), 그대로.
  앱 동작: 앱 표의 줄(core/apps.py AppSpec.tier), PolicyConfig.apps로 들어온다. 손으로 따로 적지 않고 runtime이 표에서 만든다.
앱의 '출처'에 해당하는 것은 알려진 폴더 뿌리(PolicyConfig.roots)다. 뿌리 밖 길은 어떤 앱 동작도 DENIED_PATH.

위험도는 가드가 정한다(부르는 쪽은 높이기만, guard.py:137 주석): 앱 동작의 위험도 표는 아래 _app_risk 한 곳.
막지 말고 소리로 묻는다: NEEDS_CONFIRMATION은 조용한 실패가 아니라 질문이 된다(승인 문장은 기술이 코드로 만든다).
허용 목록에 없는 것(DENIED_EXECUTABLE, DENIED_PATH)도 사용자에게는 이유를 말한다(outcome_failure와 같은 길).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import AbstractSet, Any, Mapping, Sequence

from cheongeum.core.actions import AccessTier, parse_action  # AccessTier는 core로 이동(actions.py 변경 1)
from cheongeum.core.apps import OPENABLE_EXT, within_roots
from cheongeum.core.desktop import APP_VERBS, parse_app_action


@dataclass(frozen=True)
class AppRule:
    """한 앱에 대한 가드의 규칙. 앱 표(AppSpec)에서 만든다."""

    tier: AccessTier
    verbs: frozenset[str]


# PolicyConfig(guard.py:15)에 칸 둘 더하기(기본값이 있어 기존 생성처는 그대로 돈다)
#     apps: Mapping[str, AppRule] = field(default_factory=dict)
#     roots: Sequence[str] = ()          # 앱이 건드려도 되는 폴더 뿌리(알려진 폴더의 실제 경로)
#
# PolicyContext(guard.py:33)에 칸 둘 더하기
#     app: str | None = None             # 앱 동작이 겨누는 앱은 동작 자신이 들고 있어 쓰지 않을 수 있다(사진 허락 등 문맥용)
#     grants: AbstractSet[str] = field(default_factory=frozenset)   # ExecContext.grants에서 온다


class _PolicyGuardChanges:
    """PolicyGuard(guard.py:79)에 더해지는 메서드와 check()의 두 갈래."""

    config: Any

    def check(self, candidate: Any, ctx: Any) -> dict:
        # (신규) 맨 앞: 앱 동작이면 앱 갈래로. AppVerb와 ActionType의 이름은 겹치지 않아 type만 보면 가려진다.
        #     if isinstance(candidate, dict) and candidate.get("type") in APP_VERBS: return self._check_app(candidate, ctx)
        # (기존) parse_action → stopped → 속도 제한 → 허용 동작 유형 …  (guard.py:104-113)
        # (신규) 허용 동작 유형 검사 바로 뒤, 등급 분기 앞:
        #     if action["type"] == "capture": return self._check_capture(action, ctx)
        # (기존) 등급 분기 이후는 그대로
        raise NotImplementedError

    def _check_capture(self, action: dict, ctx: Any) -> dict:
        """
        화면 사진 찍기(웹). 나가는 데이터라서 등급과 별개의 허락이 하나 더 있다.
          - 등급이 none(허용되지 않은 주소, about:blank 등)이면 DENIED_ORIGIN.
          - ctx.grants에 "shot"이 있거나 이 동작의 id가 approvals에 있으면 ALLOWED_SHOT / APPROVED.
          - 그 밖에는 NEEDS_CONFIRMATION("화면 사진을 보내기 전에 사용자 허락이 필요합니다.").
        read-only 등급에서도 허락 뒤에는 된다(사진은 읽기다). 읽기 전용의 'risk != low는 거절'(guard.py:169)에 걸리지 않게 이 갈래가 먼저 처리한다.
        """
        raise NotImplementedError

    def _check_app(self, candidate: Any, ctx: Any) -> dict:
        """
        앱 동작 한 번의 허락. 순서(앞에서 막히면 뒤는 보지 않는다):
          1) parse_app_action 실패 → DENIED_SCHEMA            (모르는 동작·모르는 앱·경로 모양이 틀린 이름·좌표 같은 칸)
          2) ctx.stopped → DENIED_STOPPED, 속도 제한 → DENIED_RATE_LIMIT   (웹과 같은 문구·같은 한도)
          3) rule = self.config.apps.get(action["app"]); 없거나 tier none → DENIED_APP("아직 다루지 않는 앱이에요")
          4) action["type"] not in rule.verbs → DENIED_ACTION_TYPE
          5) 길이 있는 동작(open·up·list·read_item·history_back): target을 folder/name 또는 place로 풀어 within_roots(path, roots)가 아니면 DENIED_PATH
             (realpath로 정션·심볼릭 링크·'..'를 푼 뒤 비교. 풀어 쓴 길은 실행기가 효과 직전에 같은 함수로 한 번 더 본다)
          6) open + kind=file: 확장자가 OPENABLE_EXT에 없으면 DENIED_EXECUTABLE("프로그램·바로 가기 파일은 열지 않아요")
          7) capture_window: ctx.grants에 "shot"이 있거나 승인됐을 때만, rule.tier가 full이고 AppSpec.picture_ok일 때만
          8) 위험도: risk = max(action["risk"], _app_risk(action)). low가 아니거나 requiresConfirmation이면
             action["id"]가 approvals에 있어야 APPROVED, 아니면 NEEDS_CONFIRMATION. 아니면 ALLOWED.
        """
        raise NotImplementedError

    @staticmethod
    def _app_risk(action: dict) -> str:
        """
        앱 동작의 위험도 표(가드가 정한다). launch·focus_window·list·up·history_back·open(folder)·read_item = low.
        open(file)·restore_window = sensitive(다른 프로그램을 띄우거나 창을 옮기므로 묻고 한다).
        capture_window는 위험도가 아니라 7)의 허락으로 다룬다.
        """
        raise NotImplementedError
