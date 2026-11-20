"""
[새 파일] DesktopGuard: 데스크톱 동작의 단일 관문. PolicyGuard(safety/guard.py)의 형제이고, 결정의 모양·코드는 같다
({allowed, code, reason}, ALLOWED·APPROVED·NEEDS_CONFIRMATION·DENIED_*). decision·deny는 guard.py에서 가져온다.

등급은 주소가 아니라 앱 신원(등록 표의 실행 파일 + 창 종류)에서 온다. 창 제목은 보지 않는다(비신뢰·자주 바뀜).
위험도는 부르는 쪽이 높일 수만 있다: 에이전트가 '인터넷에서 받은 파일'처럼 관찰한 사실로 requiresConfirmation을 올리고,
가드는 확장자로 따로 올리거나 막는다. 가드는 IO를 하지 않는다(경로가 정말 폴더 안인지는 실행 직전 포트가 본다).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import AbstractSet, Any, Mapping

from cheongeum.core.desktop import AppId, AppTier, DesktopVerb, PlaceId, parse_desktop_action

# 말로 실행하지 않는 파일(프로그램·스크립트·바로 가기·설치 파일). 열려면 사용자가 직접.
EXECUTABLE_EXTS = frozenset(
    {".exe", ".com", ".bat", ".cmd", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp",
     ".msix", ".appx", ".appinstaller", ".scr", ".pif", ".hta", ".cpl", ".lnk", ".url", ".reg", ".jar", ".inf",
     ".dll", ".sys", ".application", ".appref-ms", ".gadget", ".iso", ".img", ".vhd", ".vhdx"}
)
# 매크로가 들어 있을 수 있는 문서: 열기 전에 묻는다
MACRO_EXTS = frozenset({".docm", ".dotm", ".xlsm", ".xltm", ".xlam", ".pptm", ".potm", ".ppam", ".ppsm", ".sldm"})
# 청음이 직접 글을 뽑아 읽어 줄 수 있는 형식(core/documents.read_document + 글 파일)
READABLE_EXTS = frozenset({".pdf", ".hwpx", ".txt", ".md", ".csv"})


@dataclass(frozen=True)
class DesktopPolicy:
    # 앱별 등급과 허용 동작(agents/desktop/registry.py에서 만든다. 손으로 따로 적지 않는다)
    tiers: Mapping[AppId, AppTier]
    verbs: Mapping[AppId, frozenset[DesktopVerb]]
    places: frozenset[PlaceId]
    maxActionsPerTurn: int = 12


@dataclass
class DesktopPolicyContext:
    stopped: bool = False
    approvals: AbstractSet[str] = field(default_factory=set)
    # 웹·데스크톱 합친 이번 턴 조작 수(ExecContext.counter)
    actionsThisTurn: int = 0


class DesktopGuard:
    def __init__(self, policy: DesktopPolicy) -> None:
        self.policy = policy

    def check(self, candidate: Any, ctx: DesktopPolicyContext) -> dict:
        """
        순서: 형식(parse_desktop_action, 아니면 DENIED_SCHEMA) → 멈춤(DENIED_STOPPED) → 턴당 한도(DENIED_RATE_LIMIT)
        → 앱 등급(control 아니면 DENIED_APP_TIER) → 앱의 허용 동작(DENIED_ACTION_TYPE) → 폴더 허용 목록(DENIED_PLACE)
        → 파일 동작이면 확장자:
            open_file + EXECUTABLE_EXTS → DENIED_EXECUTABLE("프로그램 파일은 말로 실행하지 않아요": 부르는 쪽이 대안을 말함)
            read_file + READABLE_EXTS 밖 → DENIED_NOT_READABLE
            open_file + MACRO_EXTS → 위험도 올림
        → 위험도(risk != low 또는 requiresConfirmation 또는 위에서 올림): approvals에 id가 있으면 APPROVED, 없으면 NEEDS_CONFIRMATION
        → ALLOWED.
        """
        raise NotImplementedError

    @staticmethod
    def extension(action: dict) -> str:
        """target.rel 마지막 조각의 확장자(소문자, 점 포함). 없으면 ""."""
        raise NotImplementedError
