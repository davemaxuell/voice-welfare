import json
from types import SimpleNamespace

import pytest

from conftest import FIXTURES, FakeLlm
from cheongeum.agents.web import create_mock_welfare_profile, field_vocabulary
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider
from cheongeum.understanding.understand import Understanding

CASES = json.loads((FIXTURES / "understanding_cases.json").read_text(encoding="utf8"))


@pytest.mark.parametrize("online", [True, False], ids=["model", "offline"])
@pytest.mark.parametrize("case", [c for c in CASES if c["fast"]], ids=lambda c: c["text"])
async def test_fast_cases_never_call_the_model(case, online):
    vocab = field_vocabulary(create_mock_welfare_profile("http://127.0.0.1:5174"))
    rules = RuleBasedIntentProvider(vocab)
    model = FakeLlm()
    parser = Understanding(rules, SimpleNamespace(llm=model if online else None, intent_provider=rules), vocab)
    result = await parser.understand(case["text"], IntentContext(state=case["state"]), awaited=None,
                                     clarifying=False, page=None, recent=[], trace=lambda _: None)
    assert result.intents[0]["type"] in case["expect"]
    assert not model.calls
