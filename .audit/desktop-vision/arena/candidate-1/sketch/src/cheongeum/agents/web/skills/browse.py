"""
[바뀌는 부분만] agents/web/skills/browse.py

1. 생성자에 picture: ScreenPicture(세션당 하나)를 받는다.
2. screen()(browse.py:484-497)이 글·그림·둘 다를 고른다. 차단 화면·연습 신청서는 지금과 같다.
3. listed_at: 링크 목록을 마지막으로 읽어 준 시각(번호 고르기를 웹·데스크톱 중 누가 받을지 오케스트레이터가 비교).
"""
from __future__ import annotations

from cheongeum.core.context import ExecContext
from cheongeum.core.turn import draft
from cheongeum.understanding.filters import picture_request
from cheongeum.vision import ScreenPicture, choose_source


class BrowseSkill:
    # __init__(..., picture: ScreenPicture) 를 더한다. self.listed_at: float = 0.0

    async def screen(self, text: str, ctx: ExecContext) -> dict:
        """
        view = observe. 빈 화면이면 not_open(지금과 같음).
        연습 신청서이거나 '자세히'면 지금처럼 규칙 설명(describe_screen + ask_next). 그림은 쓰지 않는다.
        그 밖:
            asked = picture_request(text)
            d = digest_page(view)
            refused = d.kind == "blocked" or auth_page_kind(view) != "other" or password_fields(view)
            source = choose_source(asked=asked, text_chars=len(d.main), visuals=visuals(view), refused=refused, mode=self.picture.mode)
            text   → 지금 brief_screen 그대로
            picture → answer = await self.picture.explain(self.web.shot_source(view), ctx, session_state=self.dialogue.state)
            both   → lead = await self.narrator.brief_screen(view, ctx); answer = explain(..., lead=lead)
            answer.used가 unavailable이면 brief_screen으로 돌아가고 "그림 설명은 지금 쓸 수 없어요."를 붙인다(asked일 때만).
            answer.used가 refused면 그 이유 문장(차단이면 blocked_speech와 같은 내용).
        return draft(self.dialogue.state, "describe-screen", speech, view=view, masked=True, picture=answer.used == "picture")
        """
        raise NotImplementedError
