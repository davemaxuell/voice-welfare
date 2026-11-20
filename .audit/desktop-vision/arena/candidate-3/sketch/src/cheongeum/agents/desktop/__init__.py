"""
④ Agent A의 앱 쪽: 이름 붙은 동작으로 데스크톱 앱을 연다(파일 탐색기부터). 웹 쪽(agents/web)과 서로 가져오지 않는다.
공개: DesktopAgent(동작), AppSkill(대화), AppOutcome. OS 호출은 port.py의 DesktopPort 뒤(win32.py)에만 있다.
단계 방향: agents.desktop → core, safety, speech.phrasing, sight. (test_layers.ALLOWED에 한 줄)
"""
from cheongeum.agents.desktop.agent import AppOutcome, DesktopAgent
from cheongeum.agents.desktop.skill import AppSkill

__all__ = ["AppOutcome", "AppSkill", "DesktopAgent"]
