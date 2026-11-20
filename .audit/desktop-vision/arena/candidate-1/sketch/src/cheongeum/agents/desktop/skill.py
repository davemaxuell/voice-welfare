"""
[새 파일] DesktopSkill: 데스크톱 대화 기술(BrowseSkill의 짝). 오케스트레이터는 이것만 부른다.
말은 모두 코드가 짠다(agents/desktop/speech.py). 모델이 쓴 말은 그림 설명(ScreenPicture가 표시를 붙여 줌)뿐이다.
승인 문의 데스크톱 쪽 주인(ApprovalOwner)이기도 하다: recheck·run_approved·not_done.

어느 폴더의 이름인가(open_item·read_item): ① 이번 턴 표면이 탐색기 창이면 그 창의 폴더 ② 아니면 마지막으로 읽어 준 목록의 폴더
③ 둘 다 없으면 되묻는다("어느 폴더의 파일인지 말씀해 주세요"). 다운로드 폴더로 짐작하지 않는다.
이름이 '이·이거·그거'(rules.DEICTIC)면 탐색기 창에서 선택된 항목(하나일 때만, 키보드로 고른 파일). 없거나 여럿이면 되묻는다.
데스크톱이 꺼져 있으면(윈도가 아님·DESKTOP_APPS=false) 모든 메서드가 같은 안내 한 문장을 돌려준다.
초안 extra:
 - desktop = DesktopView(_finish가 TurnResult의 page·observation·accessMode를 여기서 만든다)
 - history = 기록(LLM에 가는 최근 대화)에 넣을 코드 문장. 파일 이름·창 제목을 빼서 개인 파일 이름이 LLM으로 가지 않게.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal

from cheongeum.core.context import ExecContext, Rechecked
from cheongeum.core.dialogue import DialogueState
from cheongeum.vision import ScreenPicture

from cheongeum.agents.desktop.agent import DesktopAgent
from cheongeum.agents.desktop.model import DesktopView, FolderEntry, Focus

UNAVAILABLE = "이 컴퓨터에서는 아직 앱과 파일을 다루지 못해요. 웹 페이지와 복지 정보는 도와드릴 수 있어요."


@dataclass
class Listing:
    """마지막으로 읽어 준 번호 목록(이 기술만 쓴다). 번호는 1부터, 사용자가 들은 순서 그대로."""

    view: DesktopView
    entries: tuple[FolderEntry, ...]
    offset: int


@dataclass(frozen=True)
class SurfaceReport:
    """TurnResult에 들어갈 화면 요약(_finish가 씀). observation은 ObservationSummary 모양, 경로 없음."""

    page: str
    accessMode: Literal["full", "read-only", "none"]
    observation: dict


class DesktopSkill:
    def __init__(self, agent: DesktopAgent | None, dialogue: DialogueState, picture: ScreenPicture, clock: Callable[[], float]) -> None:
        self.agent = agent
        self.dialogue = dialogue
        self.picture = picture
        self._clock = clock
        self._listing: Listing | None = None
        # 번호 목록을 마지막으로 읽어 준 시각(BrowseSkill.listed_at과 오케스트레이터가 비교)
        self.listed_at = 0.0

    @property
    def available(self) -> bool:
        return self.agent is not None

    async def describe(self, text: str, focus: Focus, ctx: ExecContext) -> dict:
        """
        DESCRIBE_SCREEN(표면이 데스크톱일 때). 창 종류별:
          app(탐색기) → "파일 탐색기, 다운로드 폴더예요. 파일 23개, 폴더 2개. 선택된 것은 …" (파일 시스템 + 셸 API, 그림 없음)
          shell       → 바탕화면 폴더 목록 첫 쪽
          foreign     → "'카카오톡' 창이에요. 제가 조작할 수는 없고 읽어 드리기만 해요." + UIA 이름 요약
          credential  → "로그인이나 인증서 창이라 읽지 않았어요. 이 단계는 직접 해 주세요."
        그림: choose_source(asked=picture_request(text), text_chars=UIA 글 길이, visuals=1 if foreign else 0, refused=…)가
        picture·both면 self.picture.explain(self.agent.shot_source(view), …). 내려 둔 창이면 먼저 올릴지 묻는다.
        """
        raise NotImplementedError

    async def list_items(self, target: str | None, more: bool, focus: Focus, ctx: ExecContext) -> dict:
        """
        LIST_ITEMS. target에서 폴더 이름(understanding/apps.find_desktop_name). 없으면 표면의 탐색기 창 폴더, 그것도 없으면
        마지막 목록 폴더(more), 그것도 없으면 되묻기. 한 번에 LIST_PAGE개, 번호를 붙여 읽고 listed_at을 지금 시각으로.
        semantic "list-items". history = "다운로드 폴더 목록 5개를 읽어 드렸어요."
        """
        raise NotImplementedError

    async def open(self, target: str, focus: Focus, ctx: ExecContext) -> dict:
        """
        OPEN_APP. find_desktop_name(target):
          앱 → agent.launch(app) → "파일 탐색기를 열었어요. {첫 화면 설명}"
          폴더 → agent.show_folder(place, (), 표면이 탐색기면 그 창) → "다운로드 폴더를 열었어요. 파일 23개, …" + 첫 쪽 목록
          못 찾음 → 실행하지 않고 "'{말한 이름}'은 아직 제가 열 수 있는 앱이 아니에요. 지금은 파일 탐색기와 다운로드·바탕화면·문서… 폴더를 열 수 있어요."
        semantic "open-app".
        """
        raise NotImplementedError

    async def open_item(self, name: str, focus: Focus, ctx: ExecContext) -> dict:
        """
        OPEN_ITEM, 그리고 표면이 데스크톱일 때의 FOLLOW_LINK. 폴더 → show_folder(들어가기) + 목록 첫 쪽.
        파일 → agent.point_at → needs-approval이면 ask_open(코드 문장, 승인 대기), ok이면 바로 open_file.
        가드가 막은 실행 파일 → "'설치.exe'는 프로그램 파일이라 말로 실행하지 않아요. 앱은 '파일 탐색기 열어줘'처럼 이름으로 말씀해 주세요."
        이름이 여럿 맞으면 후보에 번호를 붙여 되묻고 listed_at을 갱신(그 번호로 고를 수 있게).
        """
        raise NotImplementedError

    async def read_item(self, name: str, focus: Focus, ctx: ExecContext) -> dict:
        """
        READ_ITEM. 읽을 수 있는 형식이면 agent.read_file → 앞부분을 chunk_text로 나눠 읽고 "계속 읽어줘"로 이어 읽기
        (BrowseSkill의 읽기 위치와 같은 방식, 이 기술 안에 위치를 둔다). 옛 HWP·그림 파일 등은 이유와 대안을 말한다.
        semantic "read-item". history = "'파일' 내용을 읽어 드렸어요."
        """
        raise NotImplementedError

    async def pick_numbered(self, index: int, verb: Literal["open", "read"], ctx: ExecContext) -> dict:
        """_unknown의 번호 고르기("2번 열어줘", "1번 읽어줘")가 데스크톱 목록 차례일 때. 목록이 없거나 번호 밖이면 되묻기."""
        raise NotImplementedError

    async def up(self, focus: Focus, ctx: ExecContext) -> dict:
        """PREV(표면이 데스크톱일 때): 한 단계 위 폴더. 알려진 폴더의 맨 위면 "다운로드 폴더가 맨 위예요."."""
        raise NotImplementedError

    def ask_open(self, outcome, entry: FolderEntry, view: DesktopView) -> dict:
        """
        승인을 묻는다(BrowseSkill.ask_click의 짝, 코드가 짠 문장):
        "'다운로드' 폴더의 '신청서.hwp' 파일을 열려고 해요. 인터넷에서 받은 파일이라 열기 전에 여쭤봐요.
         열려면 '진행해', 그만두려면 '거절'이라고 말씀해 주세요."
        dialogue.ask_approval({'surface': 'desktop', 'kind': 'open', 'action', 'confirmation': {actionId, purpose, site: '파일 탐색기',
        values: [], realSubmission: False}, 'fingerprint': approval.fingerprint(action, entry, question)})
        → draft("WAITING_FOR_USER_CONFIRMATION", "confirm-open", question, desktop=view, actions=outcome.actions)
        """
        raise NotImplementedError

    # ---------------------------------------------------------------- ApprovalOwner(orchestrator/approvals.py)

    async def recheck(self, approval: dict, ctx: ExecContext) -> Rechecked:
        """agent.stat(place, rel)로 지금 항목을 보고 approval.recheck로 비교."""
        raise NotImplementedError

    async def run_approved(self, approval: dict, ctx: ExecContext) -> dict:
        """
        agent.open_file(action) (오케스트레이터가 이미 granted 블록 안에서 부른다).
        unconfirmed → 승인 대기를 둔 채 "열렸는지 확인하지 못했어요. 다시 할까요? …"(웹 ask_again과 같은 모양).
        ok → clear_approval, "'신청서.hwp'를 열었어요. 새 창 '{제목 앞 30자}'이 떴어요."
        """
        raise NotImplementedError

    def not_done(self, approval: dict) -> str:
        return "열지 않았어요."

    # ---------------------------------------------------------------- _finish용

    @staticmethod
    def report(view: DesktopView) -> SurfaceReport:
        """
        page = "desktop:explorer" | "desktop:window" | "desktop:shell", accessMode = control→full, describe→read-only, none→none,
        observation = {page, url: "desktop://explorer/downloads/회의자료"(place id + rel, 경로 아님), title: 말할 위치, fields: [], errors: []}.
        """
        raise NotImplementedError
