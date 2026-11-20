"""
④ Agent A의 데스크톱 짝: 이름 붙은 동작으로 앱·파일을 다룬다. 모든 동작은 DesktopGuard → 경로 재확인 → 포트 → 재관찰.
새 단계 "agents.desktop": core, safety, speech.phrasing, understanding, vision을 가져온다(agents.web은 가져오지 않는다).
밖(오케스트레이터·런타임)에서 쓰는 것은 아래뿐이다. windows.py는 런타임만 create_desktop_port로 쓴다.
"""
from cheongeum.agents.desktop.agent import DesktopAgent
from cheongeum.agents.desktop.focus import FocusMemory, numbered_owner, resolve_focus
from cheongeum.agents.desktop.model import DesktopView, Focus
from cheongeum.agents.desktop.registry import policy
from cheongeum.agents.desktop.skill import DesktopSkill, SurfaceReport

__all__ = [
    "DesktopAgent",
    "DesktopSkill",
    "DesktopView",
    "Focus",
    "FocusMemory",
    "SurfaceReport",
    "numbered_owner",
    "policy",
    "resolve_focus",
]
