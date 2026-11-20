import asyncio
from types import SimpleNamespace

import pytest

from cheongeum.understanding import understand as understand_mod
from cheongeum.understanding.fastpath import fast_intent
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider
from cheongeum.understanding.understand import Understanding
from conftest import FakeLlm, flat


rules = RuleBasedIntentProvider(["이름"])


async def understand(text, llm, state="BROWSING", *, clarifying=False, awaited=None):
    deps = SimpleNamespace(llm=llm, intent_provider=rules)
    return await Understanding(rules, deps, ["이름"]).understand(
        text, IntentContext(state, "name" if awaited else None), awaited=awaited, clarifying=clarifying,
        page=None, recent=[], trace=lambda _: None,
    )


@pytest.mark.parametrize(("text", "state", "kind"), [
    ("멈춰", "BROWSING", "STOP"),
    ("지금 어디까지 했어?", "BROWSING", "PROGRESS"),
    ("응", "WAITING_FOR_USER_CONFIRMATION", "APPROVE"),
    ("아니", "WAITING_FOR_USER_CONFIRMATION", "REJECT"),
    ("다 했어", "AUTH_HANDOFF", "AUTH_DONE"),
    ("복지로 열어줘", "IDLE", "OPEN_SITE"),
    ("정부24", "IDLE", "OPEN_SITE"),
    ("공지사항 눌러줘", "BROWSING", "FOLLOW_LINK"),
    ("화면 사진으로 설명해줘", "BROWSING", "DESCRIBE_PICTURE"),
])
async def test_fast_path_skips_model(text, state, kind):
    fake = FakeLlm()
    out = await understand(text, fake, state)
    assert out.by == "fast" and out.intents[0]["type"] == kind
    assert fake.calls == []


async def test_model_decides_misread_phrase():
    fake = FakeLlm({"intent_plan": {"steps": [flat("POLICY_QUESTION", topic="필요한 서류")]}})
    out = await understand("신청하지 마시고 필요한 서류만 알려줘", fake)
    assert out.by == "fake" and out.intents == [{"type": "POLICY_QUESTION", "topic": "필요한 서류"}]
    assert [c["schemaName"] for c in fake.calls] == ["intent_plan"]


async def test_question_while_waiting_never_approves():
    text = "이 버튼 눌러도 돼?"
    fake = FakeLlm({"intent_plan": {"steps": [flat("UNKNOWN", text=text)]}})
    out = await understand(text, fake, "WAITING_FOR_USER_CONFIRMATION")
    assert out.by == "fake" and out.intents == [{"type": "UNKNOWN", "text": text}]


async def test_planner_unknown_is_final():
    text = "그거 말고 다른 거 찾아줘"
    fake = FakeLlm({"intent_plan": {"steps": [flat("UNKNOWN", text=text)]}})
    out = await understand(text, fake)
    assert out.by == "fake" and out.intents == [{"type": "UNKNOWN", "text": text}]


async def test_planner_error_falls_back():
    def fail(**_):
        raise RuntimeError

    out = await understand("문의사항 눌러줘", FakeLlm(fn=fail))
    assert out.by == "rules-fallback" and out.intents == [{"type": "FOLLOW_LINK", "name": "문의사항"}]


async def test_planner_timeout_falls_back(monkeypatch):
    class SlowLlm:
        async def generate(self, **_):
            await asyncio.sleep(10)

    monkeypatch.setattr(understand_mod, "PLAN_TIMEOUT_S", 0.05)
    out = await understand("문의사항 눌러줘", SlowLlm())
    assert out.by == "rules-fallback" and out.intents[0]["type"] == "FOLLOW_LINK"


@pytest.mark.parametrize("steps", [
    [],
    "APPROVE",
    [flat("READ_MAIN"), flat("APPROVE")],
    [flat("READ_MAIN"), flat("DESCRIBE_PICTURE")],
])
async def test_bad_plan_falls_back_as_a_whole(steps):
    out = await understand("문의사항 눌러줘", FakeLlm({"intent_plan": {"steps": steps}}))
    assert out.by == "rules-fallback" and out.intents == [{"type": "FOLLOW_LINK", "name": "문의사항"}]


async def test_split_rules_fallback_does_not_grant_approval():
    fake = FakeLlm({"intent_plan": {"steps": [flat("APPROVE")]}})
    out = await understand("응 그리고 본문 읽어줘", fake, "WAITING_FOR_USER_CONFIRMATION")
    assert out.by == "rules-fallback" and all(i["type"] != "APPROVE" for i in out.intents)


async def test_unknown_step_keeps_its_question():
    text = "자격이 뭐야? 그리고 오늘 날씨는 어때?"
    plan = [flat("UNKNOWN"), flat("POLICY_QUESTION", topic="자격"), flat("UNKNOWN", text="오늘 날씨는 어때?")]
    out = await understand(text, FakeLlm({"intent_plan": {"steps": plan}}))
    assert out.intents == [{"type": "POLICY_QUESTION", "topic": "자격"}, {"type": "UNKNOWN", "text": "오늘 날씨는 어때?"}]


async def test_only_duplicate_unknown_steps_leave_one_unknown():
    text = "그거 말고 다른 거 찾아줘"
    out = await understand(text, FakeLlm({"intent_plan": {"steps": [flat("UNKNOWN"), flat("UNKNOWN")]}}))
    assert out.by == "fake" and out.intents == [{"type": "UNKNOWN", "text": text}]


@pytest.mark.parametrize(("text", "clarifying", "awaited"), [
    ("김하늘", False, SimpleNamespace(validate=lambda _: SimpleNamespace(ok=True))),
    ("두 번째 항목", True, None),
    ("2번 눌러줘", False, None),
])
async def test_contextual_input_skips_model(text, clarifying, awaited):
    fake = FakeLlm()
    out = await understand(text, fake, clarifying=clarifying, awaited=awaited)
    assert out.by == "rules" and fake.calls == []


@pytest.mark.parametrize("llm", [None, FakeLlm()])
@pytest.mark.parametrize("parts", [
    ["화면 사진으로 설명해줘", "본문 읽어줘"],
    ["본문 읽어줘", "화면 사진으로 설명해줘"],
])
async def test_compound_picture_commands_keep_both_steps(parts, llm):
    out = await understand(" 그리고 ".join(parts), llm)
    assert out.intents == [rules.parse_sync(part, IntentContext("BROWSING")) for part in parts]
    if llm:
        assert llm.calls == []


def test_picture_needs_explicit_words():
    assert fast_intent("스크린샷 없이 차트를 알려줘", IntentContext("BROWSING"), rules) is None


async def test_later_clause_can_withdraw_picture_request_even_on_failure():
    text = "화면 사진으로 설명해줘 그리고 사진 보내지 마"
    out = await understand(text, FakeLlm({"intent_plan": {"steps": [flat("DESCRIBE_PICTURE")]}}))
    assert all(i["type"] != "DESCRIBE_PICTURE" for i in out.intents)
