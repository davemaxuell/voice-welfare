"""
[새 파일] ④ 데스크톱 대화 기술: 앱 켜기, 폴더 열기, 그리고 폴더·앱 창에서 듣는 공통 말.
BrowseSkill과 같은 약속이다: 메서드는 `async def x(..., ctx) -> dict`이고 dict는 core.turn.draft()가 만든다.
모든 draft에 view=DeskView를 싣는다. 오케스트레이터는 그 view의 platform("desktop")을 보고 "지금 앞에 있는 화면"을 바꾼다.

공통 말(오케스트레이터의 Front 프로토콜): screen, look, follow_link, back, read_main, list_links, listed_link.
BrowseSkill과 메서드 이름이 같다. 그래서 ROUTES는 `s.front.follow_link(...)` 한 줄로 두 화면을 다 처리한다.

말은 모두 코드가 만든다. 파일 이름·창 제목은 비신뢰 글이라 따옴표 안에 이름으로만 읽고, 문장으로 풀어 읽지 않는다.
"""
from __future__ import annotations

from typing import Awaitable, Callable

from cheongeum.agents.desktop.agent import DesktopAgent
from cheongeum.core.dialogue import DialogueState
from cheongeum.core.exec import ExecContext
from cheongeum.speech.picture import Eyes

ENTRIES_PER_PAGE = 10
# 폴더를 열자마자 읽어 주는 항목 수
ENTRIES_ON_OPEN = 5


class DeskSkill:
    def __init__(
        self,
        desk: DesktopAgent,
        dialogue: DialogueState,
        eyes: Eyes,
        # 문서 글 읽기(agents/web/docs.read_document를 오케스트레이터가 꽂는다. agents.web을 가져오지 않는다)
        read_document: Callable[[str], Awaitable[str | None]],
    ) -> None:
        raise NotImplementedError

    # ---------------------------------------------------------------- 어디로 가는 말(새 의도)

    async def open_folder(self, said: str, ctx: ExecContext) -> dict:
        """
        "문서 폴더 열어줘", "바탕화면에 뭐 있어?", (폴더 안에서) "병원서류 폴더 들어가줘".
          resolve_place(said) → 장소. 없으면 지금 폴더의 아래 폴더 이름으로 찾는다(find_entry). 그래도 없으면 되묻는다:
            "어느 폴더인지 모르겠어요. 다운로드, 문서, 바탕 화면, 사진, 음악, 동영상 폴더를 열 수 있어요."
          말: "다운로드 폴더를 열었어요. 폴더 2개, 파일 14개가 있어요. 최근 것부터 1번 진단서.pdf, 2번 …, 5번 …. 더 들으려면 '목록 더 알려줘'."
        draft("DESKTOP", "open-folder", speech, actions, view)
        """
        raise NotImplementedError

    async def open_app(self, said: str, ctx: ExecContext) -> dict:
        """
        "파일 탐색기 열어줘", "메모장 켜줘".
          resolve_app(said) → 앱. 없으면 추측하지 않고(검색으로 넘기지 않고) 되묻는다:
            "그 프로그램은 제가 아직 열 수 없어요. 지금은 파일 탐색기를 열 수 있어요."   (이름 목록은 앱 표에서)
          탐색기면 마지막으로 있던 폴더(없으면 다운로드)로 open_folder.
        draft("DESKTOP", "open-app", ...)
        """
        raise NotImplementedError

    # ---------------------------------------------------------------- 지금 화면에 하는 말(기존 의도, Front)

    async def screen(self, text: str, ctx: ExecContext) -> dict:
        """
        DESCRIBE_SCREEN. 규칙으로만 말한다(모델 없음).
        폴더: "다운로드 폴더예요. 폴더 2개, 파일 14개. 문서 9개, 사진 3개, 그 밖 2개예요." ("자세히"면 이름 10개)
        앱 창: "'제목 없음 - 메모장' 창이에요. 누를 수 있는 것은 파일, 편집, 보기 메뉴예요."
        """
        raise NotImplementedError

    async def look(self, text: str, ctx: ExecContext) -> dict:
        """
        LOOK. 이 앱의 창 하나를 가리고 찍어 설명을 듣는다. BrowseSkill.look과 같은 순서:
        desk.capture → Refused면 그 말 + screen() / Picture면 eyes.describe(names=항목·요소 이름) → pressable을 번호 목록으로.
        앱 표의 picture가 ask인 앱은 capture가 needs-approval로 돌아온다 → 승인 대기(kind="look")를 걸고 묻는다:
          "'○○' 창을 사진으로 찍어 OpenAI에 보내 설명을 받으려고 해요. 창에 보이는 글이 함께 가요. 글 칸은 가려요. 보낼까요? …"
        """
        raise NotImplementedError

    async def follow_link(self, name: str, ctx: ExecContext) -> dict:
        """
        FOLLOW_LINK와 "N번". 폴더에서는 항목 열기(desk.open_entry), 앱 창에서는 이름으로 누르기(desk.press).
          ok(파일)        "진단서.pdf를 열었어요. 내용을 들으려면 '읽어줘'라고 하세요."      → "open-file"
          ok(폴더)        open_folder와 같은 말                                              → "open-folder"
          needs-approval  ask_open(): 승인 대기 kind="desk"                                   → "confirm-click"
          unconfirmed     "…열었는지 확인하지 못했어요. 다시 할까요?"(승인 대기 유지)
          needs-clarification  "'보고서'에 맞는 것이 3개예요. 보고서_1월.hwp, …. 어느 것인지 말씀해 주세요."
          policy-denied   "프로그램 파일은 제가 열지 않아요. 직접 여시거나 주변 분께 부탁해 주세요."
        """
        raise NotImplementedError

    async def back(self, ctx: ExecContext) -> dict:
        """PREV. 폴더에서는 위 폴더로. 앱 창에서는 "이 창에서는 뒤로 갈 곳이 없어요"."""
        raise NotImplementedError

    async def list_links(self, more: bool, ctx: ExecContext) -> dict:
        """LIST_LINKS. 항목을 ENTRIES_PER_PAGE개씩 번호를 붙여 읽고 기억한다(listed_link가 쓴다). → "list-links" """
        raise NotImplementedError

    async def read_main(self, more: bool, ctx: ExecContext) -> dict:
        """
        READ_MAIN. 방금 연 문서 파일의 글을 읽는다(PDF·HWPX: read_document). 글을 못 찾으면
        "이 파일에서는 글을 찾지 못했어요. 스캔한 문서일 수 있어요."(파일 사진을 OpenAI에 보내는 것은 이번 범위가 아니다)
        앱 창(메모장 등)은 앱 표의 ReadText 동작으로. → "read-main"
        """
        raise NotImplementedError

    def listed_link(self, index: int) -> str | None:
        """방금 읽어 준 목록의 index번째 이름(0부터). BrowseSkill.listed_link(:95)와 같은 약속."""
        raise NotImplementedError

    # ---------------------------------------------------------------- 승인

    def ask_open(self, action: dict, view: dict, actions: list[dict], focused: bool) -> dict:
        """
        열기 전에 무엇을 왜 묻는지 소리로 말하고 승인 대기를 건다(BrowseSkill.ask_click, :212의 짝).
          "'다운로드 폴더'의 '설치안내.zip' 파일을 열려고 해요. 어떤 프로그램으로 열릴지 제가 알 수 없는 종류라서 열기 전에 여쭤봐요.
           열까요? 열려면 '진행해', 그만두려면 '거절'이라고 말씀해 주세요."
        dialogue.ask_approval({"kind": "desk", "action": action, "confirmation": {...},
                               "fingerprint": agents.desktop.approval.fingerprint(view, [action], question)})
        """
        raise NotImplementedError

    async def approved(self, approval: dict, ctx: ExecContext) -> dict:
        """
        승인 문이 지문·시간을 확인한 뒤 ctx.granted 안에서 부른다. kind="desk"는 desk.run_approved, kind="look"은 look의 뒷부분.
        unconfirmed면 승인 대기를 둔 채 다시 묻고, 그 밖에는 dialogue.clear_approval().
        """
        raise NotImplementedError
