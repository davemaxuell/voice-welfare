"""
[바뀌는 것만] agents/web/skills/browse.py — 사진 경로 둘(look, screen의 자동 판단). 누르는 길은 바뀌지 않는다.
"""
from __future__ import annotations

from cheongeum.core.exec import ExecContext
from cheongeum.speech.picture import Eyes


class BrowseSkill:
    # __init__에 eyes: Eyes 하나가 더 온다(오케스트레이터가 한 번 만들어 웹·데스크톱 기술에 같은 것을 준다).

    async def look(self, text: str, ctx: ExecContext) -> dict:
        """
        "화면 사진으로 설명해줘", "이 그림 뭐야?": 지금 화면을 가리고 찍어 설명을 듣는다(LOOK 의도).

          if not self.eyes.on:
              → 글 설명(self.screen) 앞에 "사진 설명은 지금 꺼져 있어요."
          out = await self.web.capture(ctx)
          Refused면
              → out.shot.speech + (blocked·auth가 아니면 글 설명을 이어 붙인다). 사진은 어디에도 가지 않았다.
          seen = await self.eyes.describe(out.shot, question=text, title=view["title"],
                                         names=picture_names(view), sources=picture_sources(view), ctx=ctx)
          self._listed_links = list(seen.pressable)       # "2번 눌러줘"(listed_link, :95)가 그대로 쓴다
          speech = notice + seen.speech + (가린 것이 있으면 "입력 칸 N곳은 가리고 보냈어요.") + pressable 안내
          return draft(browse_state(view), "look", speech, actions=out.actions, view=view, masked=True, from_image=True)

        notice = self.narrator.once("picture", "화면 사진을 OpenAI로 보내 설명을 받아요. 입력 칸과 개인정보는 가리고 보내요. ")
        pressable 안내(코드가 만든다) = "여기서 누를 수 있는 것은 1번 '…', 2번 '…'예요. 누르려면 '1번 눌러줘'라고 하세요."

        사진을 본 뒤의 조작은 모두 기존 길이다: "1번 눌러줘" → listed_link → follow_link(name) → _locate가 outline.items에서
        이름으로 찾음 → PolicyGuard → 어댑터가 ref의 role·name을 다시 확인. 사진·모델 출력에서 ref나 위치가 나오는 길은 없다.
        이름 없는 그림 단추는 names에 없어 pressable에 들어오지 못한다(그럴 때 말: "이름이 없는 그림이라 제가 누를 수는 없어요").
        """
        raise NotImplementedError

    async def screen(self, text: str, ctx: ExecContext) -> dict:
        """
        (browse.py:484) 지금 동작 그대로 + 한 갈래:
        짧은 설명(brief_screen) 뒤에, wants_picture(view)이고 eyes.on이면 사진 설명을 이어 붙인다.

          speech = await self.narrator.brief_screen(view, ctx)          # 글로 아는 것(검증됨)이 먼저
          if wants_picture(view) and self.eyes.on:
              out = await self.web.capture(ctx)
              Picture면 speech = f"{speech} 글이 적은 화면이라 사진으로도 봤어요. {seen.speech}"   → from_image=True
              Refused면 붙이지 않는다(blocked·auth는 brief_screen이 이미 말했다)

        신청서(모의)·"자세히"는 지금처럼 규칙 설명만(describe_screen). 사진을 쓰지 않는다.
        페이지를 연 직후(page_intro)와 목표 수행 단계는 사진을 쓰지 않는다. 글이 적으면 한 번만 알려 준다:
        narrator.once("thin", "글이 거의 없고 그림이 큰 화면이에요. '사진으로 설명해줘'라고 하시면 사진을 보고 알려 드려요.")
        """
        raise NotImplementedError
