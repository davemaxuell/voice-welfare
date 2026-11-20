"""
agents/web/skills/browse.py: 바뀌는 곳만. BrowseSkill(browse.py:65)의 화면 설명(browse.py:484 screen)과 사진 허락 묻기.

글 길은 그대로다. 사진은 글을 대신하지 않고 잇는다(글이 있으면 글이 먼저, 사진은 '더 본 것').
"""
from __future__ import annotations

from cheongeum.core.execctx import ExecContext
from cheongeum.sight import Seen, Sight


class _BrowseSkillChanges:
    sight: Sight  # 생성자에 하나 더 받는다(browse.py:66-75). 세션이 Sight 하나를 만들어 준다.

    async def screen(self, text: str, ctx: ExecContext) -> dict:
        """
        기존 흐름(browse.py:485-497)에서 설명 문장을 만들기 전에 한 단계가 들어간다.

            view = await self.web.observe(ctx)                                  # (기존) blank면 not_open
            facts = facts_from_view(view)                                       # (신규) agents/web/shot.py
            advice = self.sight.advise(facts, text, ctx.grants)                 # (신규) 순수
            speech = (기존 글 설명: describe_screen 또는 brief_screen)
            if advice.mode == "ask":     return self.ask_shot(view, text, ctx, lead=speech)   # 글 설명을 먼저 말하고 사진을 보낼지 묻는다
            if advice.mode == "refuse":  speech += " " + refusal_speech(advice.reason)
            if advice.mode == "both":
                seen = await self.sight.describe(self.web, facts, text, ctx)    # self.web이 ShotSource(WebExecutionAgent.capture)
                speech += " " + seen.speech
            if advice.note: speech += " " + advice.note
            return draft(self.dialogue.state, "describe-screen", speech, view=view, masked=True,
                         seen={"via": "both" if both-ok else "text", "masked": seen.masked if seen else 0})

        글 설명이 비어도(글이 거의 없는 화면) 사진 말만 남는 것이 정상이다. 그때 via는 "screenshot".
        """
        raise NotImplementedError

    def ask_shot(self, view: dict, text: str, ctx: ExecContext, lead: str = "") -> dict:
        """
        이번 대화에서 처음 사진을 보내기 전에 소리로 묻는다(승인 방식 그대로: 코드가 만든 문장, 모델 글 없음).
        질문: "'{사이트 이름}' 화면의 사진을 OpenAI에 보내서 설명해 드릴 수 있어요. 이름이나 번호를 적는 칸과 개인 정보처럼 보이는 글은 가려서 보내요.
               이번 대화에서는 필요할 때 다시 묻지 않고 보낼게요. 보낼까요? 보내려면 '응', 그만두려면 '거절'이라고 말씀해 주세요."
        dialogue.ask_approval({"kind": "shot", "action": capture_action, "url": view["url"], "then": {"text": text},
                               "confirmation": {...realSubmission False...}, "fingerprint": fingerprint(view, [capture_action], question)})
        fingerprint(approval.py:47)는 그대로 쓴다: 화면 주소(출처+경로)가 바뀌면 '화면이 바뀌었어요'로 승인을 버린다.
        draft("WAITING_FOR_USER_CONFIRMATION", "confirm-shot", lead + question).

        '응' 뒤에는 기술이 따로 하는 일이 없다: orchestrator/approvals.py의 "shot" 줄이 허락(_grants)을 더하고 self.screen(then["text"], ctx)을 다시 부른다.
        허락의 주인은 오케스트레이터 하나이고 기술은 읽기만 한다. 다시 처리는 같은 흐름이라 허락 뒤 경로가 하나뿐이다.
        """
        raise NotImplementedError
