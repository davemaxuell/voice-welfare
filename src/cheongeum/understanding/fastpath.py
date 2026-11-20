"""안전 명령과 등록된 예문은 모델을 거치지 않고 사용자가 한 말에서 바로 판정한다."""
from __future__ import annotations

from cheongeum.core.intents import INTENTS
from cheongeum.core.lexicon import approval, command_key, done_reply
from cheongeum.core.sites import PUBLIC_AGENCIES
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider, is_picture_request, is_progress_question, is_stop_utterance
from cheongeum.understanding.sites import is_site_name


_COMMANDS = {i.type: {command_key(e.text) for e in i.examples} for i in INTENTS if i.type != "UNKNOWN"}
_REGISTERED = set().union(*_COMMANDS.values())
_DIRECT = set().union(*(words for kind, words in _COMMANDS.items() if kind not in {"GOAL", "POLICY_QUESTION", "FIND_PLACE"}))
_AGENCY_OPENS = {command_key(alias + suffix) for site in PUBLIC_AGENCIES.values() for alias in site.names
                 for suffix in ("", "열어줘", "열어주세요", "로 가줘", "으로 가줘")}


def is_exact_command(text: str) -> bool:
    """등록된 조작 명령과 기관 열기는 공공업무 계획을 건너뛴다."""
    key = command_key(text)
    return key in _DIRECT or key in _AGENCY_OPENS


def picture_command_parts(text: str, rules: RuleBasedIntentProvider) -> list[str]:
    """복합 명령에서 사용자가 화면 사진을 직접 요청한 절이 있는지 확인한다."""
    if not any(word in text for word in ("사진", "캡처", "캡쳐", "스크린")):
        return []
    parts = rules.split_commands(text)
    if len(parts) > 1 and any(is_picture_request(part.rstrip(".!。"), utterance=text) for part in parts):
        return parts
    return []


def fast_intent(text: str, ctx: IntentContext, rules: RuleBasedIntentProvider) -> dict | None:
    if is_stop_utterance(text):
        return {"type": "STOP"}
    if is_progress_question(text):
        return {"type": "PROGRESS"}
    if is_picture_request(text.rstrip(".!。")):
        return {"type": "DESCRIBE_PICTURE", "question": text}
    if ctx.state == "WAITING_FOR_USER_CONFIRMATION" and (answer := approval(text)):
        return {"type": "APPROVE" if answer == "approve" else "REJECT"}
    if ctx.state == "AUTH_HANDOFF" and done_reply(text):
        return rules.parse_sync(text, ctx)
    if command_key(text) in _REGISTERED or is_site_name(text):
        intent = rules.parse_sync(text, ctx)
        if intent["type"] != "UNKNOWN":
            return intent
    return None
