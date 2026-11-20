"""
AppSkill: 앱 쪽 대화 기술(웹의 BrowseSkill, browse.py:65의 짝). 말을 DesktopAgent 호출로 잇고, 결과를 짧은 한국어 답(draft)으로 만든다.

규칙(웹 기술과 같다):
 - 답은 핵심만 짧게. 부가 정보는 '목록 더'·'화면 설명해줘'에서(CLAUDE.md Conventions).
 - 추측 금지: 이름이 여럿이거나 없으면 실행하지 않고 되묻는다. 모르는 앱 이름은 지어내지 않는다(웹 검색으로 대체하지도 않는다).
 - 막지 말고 소리로 묻는다: 승인이 필요한 동작은 질문이 되고(ask_open_file, 2차), 못 하는 일은 이유와 대신 할 수 있는 일을 말한다.
 - 모든 draft에 surface="app", page="app:<앱 id>", access=<등급>을 싣는다. _finish가 웹 화면을 대신 쓰지 않게 하려는 것이다(session.py:597 view = draft.get("view") or self.web.current_view).
 - 파일·폴더 이름은 귀로만 간다: draft에 historySpeech("폴더 내용을 읽어 줬어요")를 실어 _history(대화 기록, LLM에 가는 것)에는 이름이 들어가지 않게 한다.
   (사용자의 파일 이름에는 이름·주민등록번호가 들어 있을 수 있다. session.py:601 _history_speech는 금고 값만 가린다.)

이 모듈이 LLM을 부르지 않는다. 폴더 내용을 읽어 주는 말은 speech/apps.py의 규칙 문장이다.
"""
from __future__ import annotations

from cheongeum.agents.desktop.agent import DesktopAgent
from cheongeum.core.dialogue import DialogueState
from cheongeum.core.execctx import ExecContext


class AppSkill:
    def __init__(self, agent: DesktopAgent | None, dialogue: DialogueState) -> None:
        """agent가 None이면 데스크톱 기능이 꺼진 것(윈도가 아님 또는 DESKTOP_APPS 꺼짐). 모든 메서드가 같은 한 문장으로 답한다."""
        self.agent = agent
        self.dialogue = dialogue

    async def open_app(self, spoken: str, ctx: ExecContext) -> dict:
        """
        resolve_app(spoken)(core/apps.py)로 앱을 찾는다.
          없음 → "그 앱은 아직 몰라요. 지금은 파일 탐색기를 열 수 있어요." (되묻기, 아무것도 실행하지 않음)
          tier none → "{label}은(는) 아직 열 수 없어요. 지금은 파일 탐색기를 열 수 있어요."
          탐색기 → agent.launch → "파일 탐색기를 열었어요. 어느 폴더로 갈까요? 다운로드, 문서, 바탕 화면, 사진 중에서 말씀해 주세요."
        state는 "APP_OPEN".
        """
        raise NotImplementedError

    async def open_item(self, spoken: str, ctx: ExecContext) -> dict:
        """
        폴더로 들어간다. 도착하면 한 번에 알려 주는 것: 폴더 이름, 폴더 수·파일 수, 앞 몇 개(speech/apps.py speak_window).
          "다운로드 폴더예요. 폴더 2개, 파일 14개가 있어요. 최근 것부터, 이력서 PDF 파일, 계약서 한글 문서, ... 더 들으시려면 '더'라고 하세요."
        여럿 맞음 → "'이력서'가 둘이에요. 이력서 폴더, 이력서 PDF 파일 중 어느 쪽인가요?"(NEEDS_CLARIFICATION)
        없음 → "'이력서'를 이 폴더에서 못 찾았어요. 목록을 읽어 드릴까요?"
        뿌리 밖·실행 파일 → 가드의 이유를 그대로 말한다("프로그램 파일은 열지 않아요. 옆에 있는 분께 부탁해 주세요.").
        """
        raise NotImplementedError

    async def read_list(self, more: bool, ctx: ExecContext) -> dict:
        """목록을 8개씩. more면 이어서(읽기 위치는 BrowseSkill._reading처럼 이 기술이 들고 있다). 폴더가 바뀌면 처음부터."""
        raise NotImplementedError

    async def up(self, ctx: ExecContext) -> dict: ...

    async def back(self, ctx: ExecContext) -> dict:
        """앱 상태에서 PREV(뒤로 가줘)가 오면 이쪽으로(ROUTES가 상태로 가른다)."""
        raise NotImplementedError

    async def describe(self, text: str, ctx: ExecContext) -> dict:
        """
        앱 상태에서 DESCRIBE_SCREEN("화면 설명해줘", "지금 창 읽어줘"). 파일 탐색기는 글로 충분하다: agent.list_view로 지금 폴더를 다시 읽고
        '지금 어디예요, 몇 개 있어요, 앞 몇 개'를 말한다. 사진은 앱 표의 picture_ok가 True인 앱에서만, 웹과 같은 Sight 길로(3차).
        """
        raise NotImplementedError

    async def ask_open_file(self, name: str, ctx: ExecContext) -> dict:
        """[2차] 파일을 기본 프로그램으로 열기 전에 묻는다. 문장은 코드가 만든다: "'이력서.pdf'를 기본 프로그램으로 열려고 해요. 열까요? 열려면 '눌러'…"."""
        raise NotImplementedError

    async def approved(self, approval: dict, ctx: ExecContext) -> dict:
        """[2차] orchestrator/approvals.py의 "app" 줄이 부른다. 승인받은 동작 하나만 실행하고 결과를 말한다(그 뒤를 혼자 이어 가지 않는다)."""
        raise NotImplementedError
