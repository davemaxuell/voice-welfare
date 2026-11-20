import json
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from cheongeum.agents.web.autopilot import Autopilot
from cheongeum.core.jsutil import AbortController
from cheongeum.core.llm import OPENAI_BASE_URL, OpenAIStructuredLlm
from cheongeum.core.model_stack import STACK
from cheongeum.language.i18n import translate_in, translate_out
from cheongeum.orchestrator.public_task import PublicTask, decide
from cheongeum.server.public_search import TavilySearch
from cheongeum.server.voice_edge import LiveProvider
from cheongeum.understanding.chat import chat_route
from cheongeum.understanding.llm_planner import plan_with_llm
from cheongeum.understanding.rules import IntentContext
from conftest import FakeLlm


DEMONSTRATION = re.compile(
    r"""\bfor example\b|\be\.g\.|\bexample\s*:|(?:예시?|예문)\s*[:：]|["'”’]\s*→"""
    r"|로그인은 됐고 국가장학금 서류만 알려줘|FILL\(이름=김하늘\)"
    r"|such as an annual calendar|such as Korean public holidays", re.IGNORECASE,
)


async def test_outgoing_instructions_and_real_user_context(http_mock, monkeypatch):
    requests = http_mock(lambda _: httpx.Response(200, json={"choices": []}))
    model = OpenAIStructuredLlm(model=STACK.agent, base_url=OPENAI_BASE_URL)
    utterance = "하이코리아 홈페이지 열어줘"
    prior = "예: 안내문에 적힌 표현을 다시 읽어 주세요."
    public_history = [{"agency": "정부24", "request": prior, "reply": "읽었어요."}]
    await decide(model, utterance, "ko", PublicTask(agency="정부24"), voice=True,
                 recent=public_history, signal=AbortController().signal)
    await plan_with_llm(model, utterance, IntentContext(state="BROWSING"), ["이름"], history=[prior])
    await chat_route(model, utterance, page=None, last_assistant=None, recent=[prior], asked_just_now=False)
    await translate_in(model, "Open the homepage", "en")
    await translate_out(model, utterance, "en", verified=True)
    monkeypatch.setattr("cheongeum.server.public_search.post_json", AsyncMock(return_value={"results": []}))
    await TavilySearch("test", model, None)(PublicTask(goal="공공기관 운영 시간"), "ko", AbortController().signal)

    payloads = {}
    for request in requests:
        body = json.loads(request.content)
        name = body["response_format"]["json_schema"]["name"]
        assert [m["role"] for m in body["messages"]] == ["system", "user"], name
        instructions, user = body["messages"]
        assert not DEMONSTRATION.search(instructions["content"]), name
        payloads[name] = user["content"]

    assert set(payloads) == {"public_service_decision", "intent_plan", "chat_route",
                             "translate_in", "translate_out", "public_search_answer"}
    assert json.loads(payloads["public_service_decision"])["recent"] == public_history
    for name in ("intent_plan", "chat_route"):
        data = json.loads(payloads[name])
        assert data["utterance"] == utterance
        assert data["recent"] == [prior]


async def test_live_startup_and_delegation_instructions(http_mock):
    requests = http_mock(lambda _: httpx.Response(201, json={"session": {"id": "test"}, "transport": {"sdp": "answer"}}))
    live = LiveProvider(SimpleNamespace(base_url=OPENAI_BASE_URL, api_key="test", edge_model=STACK.voice))
    session = SimpleNamespace(lang="ko", state="IDLE", recent_voice_dialogue=lambda: [])
    await live.offer("v=0", session, 1.0)
    offer = json.loads(requests[0].content)["session"]
    assert "input" not in offer
    assert not DEMONSTRATION.search(offer["instructions"])
    question, = offer["delegation"]["decisions"]["questions"]
    assert not DEMONSTRATION.search(question["instructions"])


@pytest.mark.parametrize(("facts", "schema"), [((), "browse_step"), (("procedure",), "public_browse_step")])
async def test_browser_step_instructions(facts, schema):
    page = SimpleNamespace(id="web", observe=AsyncMock(return_value=None))
    model = FakeLlm({schema: {"action": "fail", "answer": "읽을 자료가 없습니다."}})
    context = SimpleNamespace(signal=AbortController().signal, is_stopped=lambda: False, trace=lambda *args: None)
    agent = Autopilot(page, model, search_url=lambda query: query)
    await agent.run("신청 절차를 알려줘", context, requested_facts=facts)
    call, = model.calls
    assert call["schemaName"] == schema
    assert not DEMONSTRATION.search(call["system"])
