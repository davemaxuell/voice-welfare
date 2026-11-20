"""
[새 파일] 이번 턴이 어느 표면(웹·데스크톱)을 말하는지. 모두 순수 함수(포트가 준 사실만 본다).

규칙(resolve_focus):
 1. 데스크톱이 꺼져 있으면 언제나 web(지금과 같음).
 2. 지금 앞 창이 없거나 청음 자신(own)이면, 지난번 표면 그대로.
 3. 지금 앞 창이 청음이 지난 턴을 마칠 때의 앞 창과 같으면, 지난번 표면 그대로.
    (청음이 브라우저에서 사이트를 열었는데 브라우저 창이 앞으로 오지 못한 경우: 앞 창은 그대로 탐색기여도 말하는 곳은 웹.)
 4. 사용자가 창을 바꿨으면(Alt+Tab) 그 창: browser → web, app·shell·foreign·credential → desktop.
기억(FocusMemory)은 오케스트레이터 _finish 한 곳에서만 쓴다(초안에 데스크톱 관찰이 있으면 desktop, 웹 관찰이 있으면 web).

번호 고르기("2번 열어줘")의 주인은 창이 아니라 '마지막으로 목록을 읽어 준 쪽'이다: 웹·데스크톱 기술이 각자 listed_at을 들고,
읽을 때 비교한다(numbered_owner). 같은 상태를 한쪽이 다른 쪽에 맞춰 쓰지 않는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cheongeum.agents.desktop.model import Focus, WindowKind, WindowRef
from cheongeum.agents.desktop.port import ProcessFamily

SHELL_CLASSES = frozenset({"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"})


@dataclass(frozen=True)
class FocusMemory:
    surface: Literal["web", "desktop"] = "web"
    # 청음이 지난 턴을 마칠 때의 앞 창
    fg_hwnd: int | None = None
    # 그때 데스크톱 표면이었다면 그 창(같은 창을 다시 볼 때 씀)
    window: WindowRef | None = None


def classify_window(win: WindowRef, family: ProcessFamily) -> tuple[WindowKind, str | None]:
    """
    (창 종류, 등록된 앱 ID). 판정 순서: own(조상 프로세스) → browser(자손 프로세스) → credential(shot_policy.credential_window)
    → shell(SHELL_CLASSES) → app(registry.app_of) → foreign. 제목은 credential 보조 단서로만 본다.
    """
    raise NotImplementedError


def resolve_focus(enabled: bool, now: WindowRef | None, family: ProcessFamily | None, memory: FocusMemory) -> Focus:
    raise NotImplementedError


def numbered_owner(web_listed_at: float, desktop_listed_at: float) -> Literal["web", "desktop", None]:
    """마지막으로 번호 목록을 읽어 준 쪽. 둘 다 0이면 None."""
    raise NotImplementedError
