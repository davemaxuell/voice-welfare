"""② 말 이해: 규칙으로 여러 명령 나누기 → 규칙 하나로 이해 → 안 되면 LLM 계획. 무엇이 이해했는지(by)도 함께 돌려준다."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol, Sequence

from ieum.core.jsutil import rx
from ieum.understanding.filters import is_question_like
from ieum.understanding.llm_planner import plan_with_llm
from ieum.understanding.rules import IntentContext, RuleBasedIntentProvider, clean_value


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
    # 누가 이해했는지: "rules", 의도 공급자 이름, LLM 이름(오케스트레이터의 INTENT_DETECTED 기록)
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
    ) -> Understood:
        """
        말 이해: ① 규칙으로 여러 명령 나누기 → ② 규칙 하나로 이해 → ③ 안 되면 LLM 계획(여러 명령·애매한 말).
        값을 기다리는 중이거나 되묻기·번호 고르기 중이면 LLM을 거치지 않는다(빠르게, 오해 없이).
        """
        parts = self._rules.split_commands(text)
        if len(parts) > 1:
            parsed = [await self._rules.parse(p, ctx) for p in parts]
            if all(i["type"] != "UNKNOWN" for i in parsed):
                return Understood(merge_fills(parsed), "rules")
        single = await self._rules.parse(text, ctx)
        if single["type"] != "UNKNOWN":
            return Understood([single], "rules")
        # 값을 기다리는 중이고 그 항목 형식에 맞는 말이면 바로 입력(빠르게). 맞지 않으면 LLM이 해석한다.
        valid_value = (
            bool(awaited) and not is_question_like(text) and (awaited.validate(clean_value(text)).ok if awaited.validate else True)  # type: ignore[union-attr]
        )
        contextual = valid_value or clarifying or rx(r"^\d{1,2}\s*번").search(text) or (ctx.awaitingFieldId and not self.deps.llm)
        if contextual:
            return Understood([single], "rules")
        if not self.deps.llm:
            by = self.deps.intent_provider.name
            return Understood([await self.deps.intent_provider.parse(text, ctx)], by)
        trace("LLM 계획")
        plan = await plan_with_llm(self.deps.llm, text, ctx, self._vocabulary, page=page, history=recent)
        by = self.deps.llm.name
        if plan and not (len(plan) == 1 and plan[0]["type"] == "UNKNOWN"):
            return Understood(merge_fills([i for i in plan if i["type"] != "UNKNOWN"]), by)
        return Understood([single], by)
