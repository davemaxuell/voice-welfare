"""
동의·멈춤 문: 동의 전이나 중단 상태에서는 화면을 읽거나 브라우저를 쓰는 의도를 실행하지 않는다.
동의 문은 턴 전체, 여러 질문의 질문마다, _route가 의도를 바꾼 뒤 실행 직전에 묻는다.
멈춤 문은 턴을 시작할 때 한 번만 묻는다. 상태는 턴이 끝날 때 바뀌므로, 실행 직전에 다시 물으면
'다시 시작하고 화면 설명해줘'의 뒤 단계가 막힌다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from cheongeum.core.intents import INTENTS

# 동의 전에도 할 수 있는 것: 화면·브라우저를 쓰지 않는 복지 제도 질문과 도움 안내(의도 표의 before_consent)
ALLOWED_WITHOUT_CONSENT = frozenset(i.type for i in INTENTS if i.before_consent)


@dataclass(frozen=True)
class GateRefusal:
    state: str | None  # None이면 지금 상태를 그대로 둔다
    semanticAction: str
    speech: str


def gate_refusal(intent_types: Sequence[str], consent: str, state: str) -> GateRefusal | None:
    """턴 시작의 문: 동의, 그다음 멈춤"""
    refusal = consent_refusal(intent_types, consent)
    if refusal:
        return refusal
    if state == "STOPPED" and intent_types[0] != "RESUME":
        return GateRefusal("STOPPED", "none", "지금은 중단 상태라서 아무것도 실행하지 않았습니다. 계속하려면 '다시 시작'이라고 말씀하세요.")
    return None


def consent_refusal(intent_types: Sequence[str], consent: str) -> GateRefusal | None:
    if consent != "granted" and any(t not in ALLOWED_WITHOUT_CONSENT for t in intent_types):
        return GateRefusal(
            None,
            "consent",
            "먼저 시작 화면의 안내를 듣고 동의해 주세요. 동의 전에는 화면을 읽거나 브라우저를 조작하지 않습니다."
            if consent == "pending"
            else "동의하지 않으셔서 화면을 읽거나 브라우저를 조작하지 않습니다. 복지 제도 질문은 할 수 있습니다.",
        )
    return None
