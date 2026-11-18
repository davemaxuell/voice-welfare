"""
의도 표(core/intents.py) 한 곳에서 나온 것들이 서로 맞는지: 예문은 규칙이 알아듣고, 파생 목록은 표와 같고,
LLM 계획은 승인·중단 말고 모든 종류를 만들 수 있고, 오케스트레이터는 모든 종류를 처리한다.
"""
import pytest

from cheongeum.agents.web import create_mock_welfare_profile, field_vocabulary
from cheongeum.core.intents import HELP_GROUPS, INTENTS, help_pages
from cheongeum.core.turn import INTENT_TYPES, SESSION_STATES, parse_intent
from cheongeum.orchestrator.session import HELP_POINTER, ROUTES
from cheongeum.safety.gates import ALLOWED_WITHOUT_CONSENT
from cheongeum.understanding import INTENT_JSON_SCHEMA, LLM_INTENT_TYPES, IntentContext, RuleBasedIntentProvider, flat_to_intent
from cheongeum.understanding.llm_planner import system_prompt

VOCAB = field_vocabulary(create_mock_welfare_profile("http://localhost:5174"))
rules = RuleBasedIntentProvider(VOCAB)
EXAMPLES = [(i.type, e) for i in INTENTS for e in i.examples]
SPOKEN = [(i.type, i.examples[0].text) for i in INTENTS if i.help]
SCHEMA = INTENT_JSON_SCHEMA["schema"]


def parse(text: str, state: str = "IDLE") -> dict:
    return rules.parse_sync(text, IntentContext(state=state))


def test_one_row_per_type_with_two_examples():
    types = [i.type for i in INTENTS]
    assert len(types) == len(set(types)) == 37
    for i in INTENTS:
        assert len(i.examples) >= 2, i.type
        assert i.help is None or i.help in HELP_GROUPS, i.type
        assert all(e.state in SESSION_STATES for e in i.examples), i.type


@pytest.mark.parametrize("type_,example", EXAMPLES, ids=[f"{t}:{e.text}" for t, e in EXAMPLES])
def test_example_is_understood_by_rules(type_, example):
    assert parse(example.text, example.state)["type"] == type_


@pytest.mark.parametrize("type_,text", SPOKEN, ids=[t for t, _ in SPOKEN])
@pytest.mark.parametrize("state", ["IDLE", "BROWSING", "APPLICATION_OPEN"])
def test_help_example_is_understood_on_any_screen(type_, text, state):
    # 도움말은 줄의 첫 예문을 어느 화면에서나 읽어 준다
    assert parse(text, state)["type"] == type_


def test_fill_examples_name_practice_fields():
    fill = next(i for i in INTENTS if i.type == "FILL")
    for e in fill.examples:
        assert all(f["fieldMention"] in VOCAB for f in parse(e.text, e.state)["fills"])


def test_derived_lists_follow_the_table():
    assert INTENT_TYPES == tuple(i.type for i in INTENTS)
    assert set(LLM_INTENT_TYPES) == set(INTENT_TYPES) - {"APPROVE", "STOP", "PROGRESS"}
    assert SCHEMA["properties"]["type"]["enum"] == list(LLM_INTENT_TYPES)
    assert ALLOWED_WITHOUT_CONSENT == {
        "POLICY_QUESTION",
        "HELP_HUMAN",
        "STOP",
        "PROGRESS",
        "DISCOVER",
        "SERVICE_DETAIL",
        "PRECHECK",
        "PREPARE_APPLY",
        "WHAT_CAN_I_SAY",
    }


def test_planner_prompt_describes_exactly_the_llm_types():
    prompt = system_prompt(VOCAB)
    for i in INTENTS:
        assert (f"- {i.type}: {i.describe}" in prompt) == i.llm, i.type


def test_every_type_except_unknown_is_routed():
    assert set(ROUTES) == set(INTENT_TYPES) - {"UNKNOWN"}


# ---------------------------------------------------------------- LLM 계획 왕복


def matches_strict_schema(flat: dict) -> bool:
    """OpenAI strict 출력 모양: 모든 칸이 있고(쓰지 않으면 null), 칸마다 허용된 타입"""
    py = {"string": str, "boolean": bool, "array": list, "null": type(None)}
    if set(flat) != set(SCHEMA["required"]) or set(flat) != set(SCHEMA["properties"]):
        return False
    for key, value in flat.items():
        spec = SCHEMA["properties"][key]
        kinds = spec["type"] if isinstance(spec["type"], list) else [spec["type"]]
        if not any(type(value) is py[k] for k in kinds):
            return False
        if "enum" in spec and value not in spec["enum"]:
            return False
    return all(set(f) == {"fieldMention", "value"} for f in flat["fills"] or [])


TOPIC_PARAMS = ("topic", "goal", "target", "name", "query", "service")


def to_flat(intent: dict) -> dict:
    """의도 → LLM이 냈을 평탄화 답(이 테스트가 정한 칸 대응)"""
    flat: dict = dict.fromkeys(SCHEMA["required"])
    for key, value in intent.items():
        flat["topic" if key in TOPIC_PARAMS else key] = value
    return flat


LLM_EXAMPLES = [(t, e) for t, e in EXAMPLES if t in LLM_INTENT_TYPES]


@pytest.mark.parametrize("type_,example", LLM_EXAMPLES, ids=[f"{t}:{e.text}" for t, e in LLM_EXAMPLES])
def test_planner_can_express_every_llm_type(type_, example):
    ruled = parse(example.text, example.state)
    flat = to_flat(ruled)
    assert matches_strict_schema(flat)
    assert flat_to_intent(flat, example.text) == parse_intent(ruled) == ruled


@pytest.mark.parametrize("type_", ["APPROVE", "STOP", "PROGRESS"])
def test_planner_cannot_approve_stop_or_report_progress(type_):
    assert type_ not in SCHEMA["properties"]["type"]["enum"]
    assert flat_to_intent({**dict.fromkeys(SCHEMA["required"]), "type": type_}, "응") is None


def test_planner_more_and_site_slots():
    base = dict.fromkeys(SCHEMA["required"])
    assert flat_to_intent({**base, "type": "READ_MAIN"}, "더") == {"type": "READ_MAIN", "more": False}
    assert flat_to_intent({**base, "type": "LIST_LINKS", "more": True}, "더") == {"type": "LIST_LINKS", "more": True}
    assert flat_to_intent({**base, "type": "SEARCH", "topic": "기초연금", "site": "복지로"}, "x") == {
        "type": "SEARCH",
        "query": "기초연금",
        "site": "복지로",
    }
    # 링크 이름·검색어 없이는 실행하지 않는다(추측 금지): 계획 전체가 규칙 결과로 돌아간다
    assert flat_to_intent({**base, "type": "FOLLOW_LINK"}, "가자") is None
    assert flat_to_intent({**base, "type": "SEARCH"}, "찾아") is None


# ---------------------------------------------------------------- 도움말


@pytest.mark.parametrize("lead", [("신청서",), ("웹 읽기",), ("시작", "복지 정보")])
def test_help_pages_read_every_example_once(lead):
    pages = help_pages(lead, consented=True)
    said = [t for page in pages for _, texts in page for t in texts]
    assert sorted(said) == sorted(t for _, t in SPOKEN)
    for page in pages:
        groups = [g for g, _ in page]
        assert 1 <= len(page) <= 3 and len(groups) == len(set(groups))
        assert all(1 <= len(texts) <= 2 for _, texts in page)


def test_screen_group_leads_every_page_until_it_runs_out():
    pages = help_pages(("신청서",), consented=True)
    form_pages = [p for p in pages if any(g == "신청서" for g, _ in p)]
    assert pages[: len(form_pages)] == form_pages
    assert all(p[0][0] == "신청서" for p in form_pages)


def test_help_before_consent_reads_only_what_runs_before_consent():
    said = [t for page in help_pages(("시작", "복지 정보"), consented=False) for _, texts in page for t in texts]
    assert said
    assert {parse(t)["type"] for t in said} <= ALLOWED_WITHOUT_CONSENT


@pytest.mark.parametrize(
    "text,more",
    [(HELP_POINTER.split("'")[1], False), ("다른 말도 알려줘", True), ("도움말", False)],
)
def test_phrases_the_help_tells_you_to_say(text, more):
    assert parse(text, "APPLICATION_OPEN") == {"type": "WHAT_CAN_I_SAY", "more": more}
