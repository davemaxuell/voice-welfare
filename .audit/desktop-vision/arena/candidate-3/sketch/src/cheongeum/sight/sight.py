"""
Sight: 화면 사진 설명의 깊은 모듈. 부르는 쪽은 두 메서드만 안다.

    advice = sight.advise(facts, 사용자_말, ctx.grants)        # 지금 사진을 쓸까? (순수)
    seen = await sight.describe(source, facts, 사용자_말, ctx)   # 찍고, 보고, 검증하고, 출처를 밝혀 말로 만든다

안에 숨는 것: 사진 쓸지 정하기(policy), 마스킹이 끝난 사진만 받기(ShotSource가 MaskedShot을 돌려준다), 모델 호출과 중단, 비식별화한 문맥 만들기,
숫자·주소·주입 검증과 말 만들기(answer), 실패를 정직한 말로 바꾸기.
밖에 남는 것: 허락을 묻는 대화(BrowseSkill.ask_shot, 대화 상태는 기술이 만진다), 글 설명(Narrator, 사진은 글을 대신하지 않고 잇는다).

이 클래스가 기억하는 것은 한 번만 하는 안내를 이미 했는지(_told) 하나다. 허락(grants)은 오케스트레이터가 하나만 들고(ExecContext.grants)
여기서는 읽기만 한다(주인이 둘이면 서로 다른 말을 한다).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import AbstractSet, Literal

from cheongeum.core.execctx import ExecContext
from cheongeum.core.vision import ScreenFacts, ShotRefusalReason, ShotSource, VisionModel
from cheongeum.sight.policy import Advice, advise as _advise  # noqa: F401  (Advice는 sight 밖으로도 나간다)


@dataclass(frozen=True)
class Seen:
    """사진 길의 결과. 부르는 쪽이 speech를 글 설명 뒤에 잇는다."""

    status: Literal["ok", "refused", "unavailable", "failed"]
    speech: str  # status가 ok면 '사진으로 보면 …', 아니면 이유를 말하는 한두 문장
    refusal: ShotRefusalReason | None = None
    # 아래 둘은 사진 속 이름 중 코드가 확인한 것. 다음 턴 '눌러' 말과 맞춰 보는 데 쓸 수 있다(Sight는 기억하지 않는다).
    pressable: tuple[str, ...] = ()
    picture_only: tuple[str, ...] = ()
    masked: int = 0  # MaskReport의 가린 수 합(TurnResult.seen.masked)


class Sight:
    def __init__(self, vision: VisionModel | None) -> None:
        """vision이 None이면 사진 설명이 꺼진 것이다(LLM_VISION_* 미설정 또는 OpenAI가 아님). advise는 청한 경우에만 그 사실을 말한다."""
        self._vision = vision
        self._told: set[str] = set()  # 한 번만 하는 안내('틀릴 수 있어요')를 이미 했는지

    @property
    def available(self) -> bool:
        return self._vision is not None

    def advise(self, facts: ScreenFacts, ask: str, grants: AbstractSet[str]) -> Advice:
        """policy.advise 한 줄 위임이 아니라, available을 채워 주는 자리다(부르는 쪽이 모델 유무를 몰라도 된다)."""
        raise NotImplementedError

    async def describe(self, source: ShotSource, facts: ScreenFacts, ask: str, ctx: ExecContext) -> Seen:
        """
        advise가 사진을 허락한 뒤에만 부른다(아니면 ValueError: 사진은 부르는 쪽 실수로 새지 않는다).
          1) shot = await source.capture(ctx)       → ShotRefusal이면 Seen(refused, refusal_speech(reason))
          2) user = jdumps({ask, title, pageText[:1200], pressables[:30]})  각각 redact_text를 거친다(screen.py:243 summarize_body와 같은 규칙)
          3) raw = await self._vision.look(system=SHOT_SYSTEM, user=user, shot=shot, schemaName=SHOT_SCHEMA_NAME, schema=SHOT_SCHEMA, signal=ctx.signal)
             → None이면 Seen(failed, "사진을 보지 못했어요. 글로 설명한 것만 믿으셔도 돼요.")
          4) composed = compose(raw, facts, ask, first_time="picture-hint" not in self._told); None이면 failed와 같이
          5) ctx.trace("VERIFYING", AGENT_IDS.screen, ...)  '사진 답 검증: 숫자 버림 여부, 다리 일치 n/m'
        중단: ctx.signal이 서면 모델 호출이 바로 끝난다(post_json의 race_abort). 그 경우 Seen을 만들지 않고 호출자가 ABORTED 흐름으로 간다.
        """
        raise NotImplementedError
