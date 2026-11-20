"""
[바뀌는 부분만] orchestrator/session.py

오케스트레이터는 지금처럼 순서·문·라우팅만 한다. 더하는 것:
 1. OrchestratorDeps.desktop(DesktopAgent | None)·vision_llm.
 2. 세션당 ScreenPicture 하나, DesktopSkill 하나(BrowseSkill과 나란히).
 3. 턴의 표면(Turn.focus): _process_korean이 _begin_turn 바로 뒤에 한 번 정한다(멈춤·진행 물음 길에서는 정하지 않는다: 즉시 답해야 함).
 4. ROUTES: 새 네 줄 + 표면에 따라 갈리는 세 줄(DESCRIBE_SCREEN·PREV·FOLLOW_LINK).
 5. _unknown의 번호 고르기: numbered_owner(웹·데스크톱 listed_at 비교)로 주인을 고른다.
 6. _approve: 표면별 주인(orchestrator/approvals.py).
 7. _finish: 초안에 desktop 관찰이 있으면 그 요약, 표면이 데스크톱이면 웹 관찰로 떨어지지 않는다. FocusMemory를 여기서만 쓴다.
    초안의 history가 있으면 기록(LLM에 가는 최근 대화)에 speech 대신 그 문장을 넣는다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from cheongeum.agents.desktop import DesktopAgent, DesktopSkill, Focus, FocusMemory, numbered_owner
from cheongeum.core.context import ExecContext
from cheongeum.vision import ScreenPicture


@dataclass
class OrchestratorDeps:
    # ... 지금 칸 그대로(session.py:43-65) ...
    # 새: 데스크톱 앱·파일(윈도 + DESKTOP_APPS). None이면 데스크톱 의도는 안내 한 문장만.
    desktop: DesktopAgent | None = None
    # 새: 그림 설명 LLM(OpenAI만). None이면 그림 설명 꺼짐(글 설명은 그대로).
    vision_llm: Any = None
    vision_mode: str = "auto"


@dataclass
class Turn:
    # ... 지금 칸 그대로(session.py:77-86) ...
    # 새: 이번 턴의 표면. None = 정하지 않은 턴(멈춤·진행 물음·동의) → 지금처럼 웹.
    focus: Focus | None = None


class SessionOrchestrator:
    def __init__(self, deps: OrchestratorDeps) -> None:
        """
        지금 생성자에 더한다:
            self.picture = ScreenPicture(lambda: deps.vision_llm, action_log=deps.action_log, mode=deps.vision_mode)
            self.browse = BrowseSkill(..., picture=self.picture)
            self.desktop = DesktopSkill(deps.desktop, self.dialogue, self.picture, clock=lambda: deps.clock())
            self._web_approvals = WebApprovals(deps.web, self.browse, self.form, self.guided)
            self._focus_memory = FocusMemory()
        """
        raise NotImplementedError

    async def _turn_focus(self, turn) -> Focus:
        """
        _process_korean에서 _begin_turn 바로 뒤에 한 번. 데스크톱이 없으면 Focus.web()(OS를 부르지 않는다).
        있으면 deps.desktop.focus(enabled=True, memory=self._focus_memory). 실패하면 Focus.web()(지금과 같은 동작으로 떨어짐).
        """
        raise NotImplementedError

    # _understand(session.py:709): page는 표면이 데스크톱이면 앱 이름("파일 탐색기")만. 창 제목·파일 이름은 LLM에 넘기지 않는다.
    # _what_can_i_say(session.py:904): 표면이 데스크톱이면 lead = ("컴퓨터",).
    # _maybe_spoken_secret(session.py:977): 표면이 자격 증명 창이면 risky(비밀번호를 말할 수 있는 순간).
    # _route(session.py:843): list_just_read = self._last_semantic in ("list-links", "list-items")

    async def _unknown_numbered(self, index: int, text: str, turn) -> dict | None:
        """
        _unknown(session.py:1176-1180)의 번호 고르기를 바꾼다:
            owner = numbered_owner(self.browse.listed_at, self.desktop.listed_at)
            desktop → self.desktop.pick_numbered(index, "read" if '읽어|들려' in text else "open", ctx)
            web     → 지금처럼 browse.listed_link → follow_link
            None    → None(아래 규칙으로 계속)
        """
        raise NotImplementedError

    def _finish_surface(self, turn, d: dict) -> tuple[str | None, str | None, dict | None]:
        """
        _finish(session.py:597, 632-638)의 page·accessMode·observation 세 칸:
          d['desktop']가 있으면 DesktopSkill.report(d['desktop'])
          아니면 view = d.get('view') or (self.web.current_view if turn.focus is None or turn.focus.surface == 'web'
                                            else None)  → 지금 코드(_summarize, access_mode)
          표면이 데스크톱인데 관찰이 없는 초안(도움말 등)이면 데스크톱 마지막 관찰의 요약(없으면 None).
        그리고 self._focus_memory = FocusMemory(surface=…, fg_hwnd=deps.desktop.foreground_hwnd() if deps.desktop else None, window=…)
        """
        raise NotImplementedError


# ROUTES(session.py:1210)에 더하고 바꾸는 줄:
#
#   "OPEN_APP":   lambda s, i, t: s.desktop.open(i["target"], t.focus, t.ctx),
#   "LIST_ITEMS": lambda s, i, t: s.desktop.list_items(i.get("target"), i["more"], t.focus, t.ctx),
#   "OPEN_ITEM":  lambda s, i, t: s.desktop.open_item(i["name"], t.focus, t.ctx),
#   "READ_ITEM":  lambda s, i, t: s.desktop.read_item(i["name"], t.focus, t.ctx) if s.desktop.available
#                 else s.browse.read_download({"type": "READ_DOWNLOAD", "list": False}, t.ctx),   # 꺼져 있으면 "이 파일 읽어줘"의 오늘 동작
#   "DESCRIBE_SCREEN": lambda s, i, t: s.desktop.describe(t.text, t.focus, t.ctx) if _on_desktop(t) else s.browse.screen(t.text, t.ctx),
#   "PREV":        lambda s, i, t: s.desktop.up(t.focus, t.ctx) if _on_desktop(t) else (지금 줄),
#   "FOLLOW_LINK": lambda s, i, t: s.desktop.open_item(i["name"], t.focus, t.ctx) if _on_desktop(t) else s.browse.follow_link(i["name"], t.ctx),


def _on_desktop(t) -> bool:
    """이번 턴 표면이 데스크톱인가(Turn.focus가 없으면 아니다)."""
    return t.focus is not None and t.focus.surface == "desktop"
