"""
[바뀌는 것만] orchestrator/session.py

핵심은 하나다: 오케스트레이터가 "지금 앞에 있는 화면"(front)을 안다. 웹 화면이거나 데스크톱 화면이다.
front는 따로 정해 주는 값이 아니라 마지막으로 말해 준 화면(view)의 platform에서 나온다("pc" | "desktop").
쓰는 곳은 _finish 한 군데다. 기술은 지금처럼 draft에 view를 실을 뿐이다.

그래서
 - 폴더에서 "화면 설명해줘"·"목록 알려줘"·"진단서 열어줘"·"뒤로 가줘"·"읽어줘"는 새 의도가 아니라 기존 의도가 front로 간 것이다.
 - _finish의 page·observation·accessMode는 front의 화면에서 나온다(지금은 늘 self.web.current_view, :597).
 - 승인 문(_approve)의 뼈대(다시 보기 → 지문 비교 → 2분 → granted)는 하나이고, 다시 보는 곳·지문 함수·실행만 승인 대기의 액션 종류로 갈린다.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Protocol

from cheongeum.agents.desktop.agent import DesktopAgent
from cheongeum.core.exec import ExecContext


@dataclass
class OrchestratorDeps:
    # ... 기존 칸(session.py:43-65)은 그대로 ...
    intent_provider: Any
    web: Any
    welfare: Any
    # 화면 사진 설명(core.picture.VisionLlm). OpenAI일 때만 만들어진다. 없으면 사진 기능이 꺼지고 글 설명만 한다.
    vision: Any = None
    # 데스크톱 실행 에이전트. Windows가 아니거나 꺼 두면 None: OPEN_APP·OPEN_FOLDER는 "이 컴퓨터에서는 지원하지 않아요"라고 답한다.
    desk: DesktopAgent | None = None
    clock: Callable[[], float] = time.monotonic


class Front(Protocol):
    """지금 앞에 있는 화면에 하는 말. BrowseSkill과 DeskSkill이 같은 이름으로 갖고 있다(BrowseSkill은 이름을 바꾸지 않는다)."""

    async def screen(self, text: str, ctx: ExecContext) -> dict: ...
    async def look(self, text: str, ctx: ExecContext) -> dict: ...
    async def follow_link(self, name: str, ctx: ExecContext) -> dict: ...
    async def back(self, ctx: ExecContext) -> dict: ...
    async def read_main(self, more: bool, ctx: ExecContext) -> dict: ...
    async def list_links(self, more: bool, ctx: ExecContext) -> dict: ...
    def listed_link(self, index: int) -> str | None: ...


# 승인을 받았지만 물어본 뒤 화면이 바뀌어 하지 않은 일(승인 대기 종류별, :73). 종류는 다섯으로 닫혀 있고 시험이 표와 맞춘다.
NOT_DONE = {
    "click": "누르지 않았어요.",
    "assist": "넣지 않았어요.",
    None: "모의접수하지 않았어요.",
    "desk": "열지 않았어요.",
    "look": "사진을 보내지 않았어요.",
}


class SessionOrchestrator:
    def __init__(self, deps: OrchestratorDeps) -> None:
        """
        더해지는 줄:
          self.eyes = Eyes(deps)                                        # 웹·데스크톱 기술이 같은 것을 쓴다
          self.browse = BrowseSkill(..., eyes=self.eyes)
          self.desk = DeskSkill(deps.desk, self.dialogue, self.eyes, read_document=...) if deps.desk else None
          self._front = "pc"
        """
        raise NotImplementedError

    @property
    def front(self) -> Front:
        """self.desk if self._front == "desktop" and self.desk else self.browse"""
        raise NotImplementedError

    def _front_view(self) -> dict | None:
        """front의 마지막 화면: 데스크톱이면 deps.desk.current_view, 아니면 self.web.current_view."""
        raise NotImplementedError

    def _finish(self, turn: Any, draft: dict) -> dict:
        """
        (:587) 바뀌는 네 줄.

          view = draft.get("view") or self._front_view()                       # 지금: draft.get("view") or self.web.current_view
          if draft.get("view"):
              was, self._front = self._front, view.get("platform", "pc")       # front를 쓰는 유일한 곳
              if was == "pc" and self._front == "desktop":
                  self.dialogue.drop_value_wait()                              # 신청서 값 대기를 접는다(dialogue.py:138)
                  # 그러지 않으면 폴더에서 한 "보고서"라는 말이 _unknown(:1181)에서 이름 칸에 들어간다
          "page": view["pageId"], "accessMode": self._access_mode(view), "observation": self._summarize(view)
          "flags": {..., "fromImage": bool(draft.get("from_image")) or None}

        _access_mode(view): platform이 desktop이면 deps.desk.access_mode(view), 아니면 self.web.access_mode(view).
        _summarize(view)(:666): platform이 desktop이면 core.desk.desk_summary(view), 아니면 지금 그대로.

        사진에서 온 말은 기록에 표시를 달아 넣는다: self._history.append({..., "fromImage": True}).
        _recent_dialogue(:706)는 그런 줄을 "청음: (화면 사진을 설명함)"으로 바꿔 준다.
        사진 속 글이 다음 턴의 의도 계획(LLM)에 들어가는 길을 끊는다. "쉽게 말해줘"(_rephrase)는 원문을 그대로 쓴다.
        """
        raise NotImplementedError

    async def _approve(self, turn: Any) -> dict:
        """
        (:1117) 뼈대는 그대로, 세 군데만 화면에 따라 갈린다.

          approval = self.dialogue.approval ...
          kind = approval.get("kind")
          actions = approval.get("actions") or [approval["action"]]
          on_desk = is_desk_action(actions[0])                                  # core.desk. 승인 대기에 든 액션에서 나온다
          view = await (self.deps.desk.observe(turn.ctx) if on_desk else self.web.observe(turn.ctx))
          now, changed = (desk_recheck if on_desk else recheck)(approval["fingerprint"], view, actions)
          if changed: clear_approval + f"{changed} 그래서 {NOT_DONE[kind]} ..."          # 지금과 같은 문장 틀
          if self.dialogue.approval_age >= APPROVAL_TTL_S: 다시 묻는다                    # 지금과 같다
          with turn.ctx.granted([a["id"] for a in actions]):
              if on_desk:
                  return await self.desk.approved(approval, turn.ctx)
              ... click / assist / submit 는 지금 그대로 ...

        멈춤(_stop, :275)은 바꾸지 않는다: approvals와 승인 대기를 지우는 것으로 데스크톱 승인도 함께 사라진다.
        """
        raise NotImplementedError


# ROUTES(:1210)에서 바뀌는 줄과 새 줄. 나머지 30여 줄은 그대로다.
#
#   "FOLLOW_LINK":     lambda s, i, t: s.front.follow_link(i["name"], t.ctx),
#   "READ_MAIN":       lambda s, i, t: s.front.read_main(i["more"], t.ctx),
#   "LIST_LINKS":      lambda s, i, t: s.front.list_links(i["more"], t.ctx),
#   "DESCRIBE_SCREEN": lambda s, i, t: s.front.screen(t.text, t.ctx),
#   "PREV":            lambda s, i, t: s.form.prev(t.ctx) if s._front == "pc" and is_form_open(s.web.current_view) else s.front.back(t.ctx),
#   "LOOK":            lambda s, i, t: s.front.look(t.text, t.ctx),
#   "OPEN_FOLDER":     lambda s, i, t: s._desk_or_off(lambda d: d.open_folder(i["place"], t.ctx)),
#   "OPEN_APP":        lambda s, i, t: s._desk_or_off(lambda d: d.open_app(i["target"], t.ctx)),
#
# _desk_or_off: self.desk가 없으면 draft(state, "none", "이 컴퓨터에서는 폴더와 프로그램을 여는 기능을 쓸 수 없어요.").
#
# _unknown(:1177-1180)의 "2번": self.browse.listed_link → self.front.listed_link, self.browse.follow_link → self.front.follow_link.
#
# 웹으로 돌아오기: 웹 기술의 draft는 웹 view를 싣고 있으므로 "복지로 열어줘"·"크롬 켜줘"(_open_browser, :871)·검색이면 front가 저절로 "pc"가 된다.
# _open_browser는 신청서가 열려 있으면 form.ask_next(view)를 이어 말해 하던 칸으로 돌아온다.
