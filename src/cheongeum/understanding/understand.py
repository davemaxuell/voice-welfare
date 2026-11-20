"""② 말 이해. 안전 명령과 대화 중인 선택을 먼저 처리하고, 모델이 없거나 계획에 실패하면 규칙을 쓴다."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable, Protocol, Sequence

from cheongeum.core.jsutil import rx
from cheongeum.understanding.fastpath import fast_intent, picture_command_parts
from cheongeum.understanding.filters import is_question_like
from cheongeum.understanding.llm_planner import plan_with_llm
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider, clean_value, is_picture_request

PLAN_TIMEOUT_S = 8.0


# 목표 하나의 조각일 수 있는 것: 읽기·묻기뿐(입력·신청 시작처럼 따로 할 일이 섞이면 나눈다)
_GOAL_PARTS = frozenset({"GOAL", "CURRENT_STEP", "DESCRIBE_SCREEN", "READ_MAIN", "ABOUT_SITE", "POLICY_QUESTION", "UNKNOWN"})


def merge_fills(intents: list[dict]) -> list[dict]:
    """연속된 입력 명령은 하나로 합친다(한 번에 화면 확인)."""
    out: list[dict] = []
    for i in intents:
        prev = out[-1] if out else None
        if i["type"] == "FILL" and prev and prev["type"] == "FILL" and len(prev["fills"]) + len(i["fills"]) <= 5:
            out[-1] = {"type": "FILL", "fills": [*prev["fills"], *i["fills"]]}
        else:
            out.append(i)
    return out


@dataclass(frozen=True)
class Understood:
    intents: list[dict]
    # 오케스트레이터의 INTENT_DETECTED 기록에 남길 이해 경로
    by: str


class AwaitedField(Protocol):
    """값을 기다리는 입력 칸(agents/web의 FieldProfile). 형식 검사만 본다."""

    validate: Callable[[str], Any] | None


class UnderstandingDeps(Protocol):
    """llm·intent_provider는 테스트가 세션을 만든 뒤 바꾸므로 부를 때마다 읽는다."""

    llm: Any
    intent_provider: Any


class Understanding:
    def __init__(self, rules: RuleBasedIntentProvider, deps: UnderstandingDeps, vocabulary: Sequence[str]) -> None:
        self._rules = rules
        self.deps = deps
        self._vocabulary = vocabulary

    async def understand(
        self,
        text: str,
        ctx: IntentContext,
        *,
        awaited: AwaitedField | None,
        clarifying: bool,
        page: str | None,
        recent: list[str],
        trace: Callable[[str], None],
        max_steps: int = 6,
    ) -> Understood:
        llm = self.deps.llm
        if llm is None:
            result = await self._by_rules(text, ctx, "rules")
            if result.intents[0]["type"] != "UNKNOWN" or ctx.awaitingFieldId or self._contextual(text, awaited, clarifying):
                return result
            provider = self.deps.intent_provider
            return Understood([await provider.parse(text, ctx)], provider.name)

        fast = fast_intent(text, ctx, self._rules)
        if fast and fast["type"] != "DESCRIBE_PICTURE":
            return Understood([fast], "fast")
        # 사진을 요청한 절은 모델이 대신 만들 수 없다. 함께 요청한 읽기 등도 원래 순서로 처리한다.
        if parts := picture_command_parts(text, self._rules):
            intents = []
            by = "fast"
            for part in parts:
                step = await self.understand(part, ctx, awaited=awaited, clarifying=clarifying, page=page, recent=recent, trace=trace)
                if any(i["type"] == "APPROVE" for i in step.intents):
                    return Understood([{"type": "UNKNOWN", "text": text}], "rules")
                intents.extend(step.intents)
                if step.by != "fast":
                    by = step.by
            return Understood(merge_fills(intents), by)
        if fast:
            return Understood([fast], "fast")
        if self._contextual(text, awaited, clarifying):
            return Understood([await self._rules.parse(text, ctx)], "rules")
        trace("LLM 계획")
        try:
            plan = await asyncio.wait_for(
                plan_with_llm(llm, text, ctx, self._vocabulary, page=page, history=recent, max_steps=max_steps), PLAN_TIMEOUT_S,
            )
        except Exception:
            plan = None
        if plan is None:
            return await self._by_rules(text, ctx, "rules-fallback")
        if len(plan) == 1:
            return Understood(plan, llm.name)
        kept = [i for i in plan if i["type"] != "UNKNOWN" or i["text"] != text]
        return Understood(merge_fills(kept) or [{"type": "UNKNOWN", "text": text}], llm.name)

    @staticmethod
    def _contextual(text: str, awaited: AwaitedField | None, clarifying: bool) -> bool:
        if awaited and not is_question_like(text):
            if not awaited.validate or awaited.validate(clean_value(text)).ok:
                return True
        return clarifying or bool(rx(r"\d{1,2}\s*번(?:이요|요|(?:을|를)?\s*(?:눌러|열어|선택해)(?:\s*(?:줘요?|주세요))?)?[.!。]?").fullmatch(text.strip()))

    async def _by_rules(self, text: str, ctx: IntentContext, by: str) -> Understood:
        parts = self._rules.split_commands(text)
        single = await self._rules.parse(text, ctx)
        if len(parts) > 1:
            parsed = [await self._rules.parse(p, ctx) for p in parts]
            # "정부24에서 … 찾아줘. 로그인하지 말고, 어떤 단계부터 … 알려줘"는 목표 하나: 나누면 뒤의 조건·질문을 잃는다
            if single["type"] == "GOAL" and all(i["type"] in _GOAL_PARTS for i in parsed):
                return Understood([single], by)
            if all(i["type"] != "UNKNOWN" for i in parsed):
                # 절을 나누더라도 승인·사진 요청의 범위는 전체 발화로 확인한다.
                if any(i["type"] == "APPROVE" or (
                    i["type"] == "DESCRIBE_PICTURE" and not is_picture_request(i["question"], utterance=text)
                ) for i in parsed):
                    return Understood([single], by)
                return Understood(merge_fills(parsed), by)
        return Understood([single], by)
