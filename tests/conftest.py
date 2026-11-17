"""
테스트 공통: 모의 사이트(5174)를 띄우고(이미 떠 있으면 재사용) 테스트 런타임을 만든다.
테스트는 인터넷 없이 돈다: LLM_PROVIDER=mock, REQUIRE_CONSENT=false, 검색은 로컬 합성 포털.
기본 headless, HEADED=1이면 브라우저 창 표시.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from ieum.agents.web.browser import stop_playwright  # noqa: E402
from ieum.practice_site import is_reachable, start_mock_site  # noqa: E402
from ieum.server.runtime import AgentRuntime, load_config  # noqa: E402

MOCK_URL = "http://localhost:5174"
PORTAL = "127.0.0.1:5174/external.html"
FIXTURES = ROOT / "tests" / "fixtures"


def create_test_runtime(env: dict | None = None) -> AgentRuntime:
    headed = os.environ.get("HEADED") == "1"
    return AgentRuntime(
        load_config(
            {
                "MOCK_SITE_URL": MOCK_URL,
                "HEADLESS": "false" if headed else "true",
                "BROWSER_SLOWMO_MS": "200" if headed else "0",
                "LLM_PROVIDER": "mock",
                "REQUIRE_CONSENT": "false",
                "READ_ONLY_WEB": "true",
                "VISUAL_CURSOR": "false",
                # 테스트는 인터넷 없이: 검색은 로컬 합성 포털의 검색으로
                "WEB_SEARCH_URL": "http://127.0.0.1:5174/external.html?q={q}",
                **(env or {}),
            }
        )
    )


@pytest.fixture(scope="session", autouse=True)
def mock_site():
    """모의 사이트가 이미 떠 있으면 재사용하고, 아니면 테스트 동안 띄운다."""
    site = None if is_reachable(MOCK_URL) else start_mock_site(5174)
    yield
    if site:
        site.close()


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _playwright_driver():
    yield
    await stop_playwright()


@pytest_asyncio.fixture(scope="module")
async def runtime():
    rt = create_test_runtime()
    yield rt
    await rt.close()


class SessionFactory:
    """테스트마다 세션을 만들고 끝나면 닫는다."""

    def __init__(self, rt: AgentRuntime) -> None:
        self.rt = rt
        self.opened: list = []

    async def __call__(self, rt: AgentRuntime | None = None):
        s = await (rt or self.rt).create_session()
        self.opened.append(s)
        return s


@pytest_asyncio.fixture
async def new_session(runtime):
    factory = SessionFactory(runtime)
    yield factory
    for s in factory.opened:
        await s.close()


class FakeLlm:
    """스키마 이름별로 답을 정한 가짜 LLM(네트워크 없음)."""

    name = "fake"

    def __init__(self, answers: dict | None = None, fn=None) -> None:
        self.answers = answers or {}
        self.fn = fn
        self.calls: list[dict] = []

    async def generate(self, *, system, user, schemaName, schema, signal=None):  # noqa: N803
        self.calls.append({"system": system, "user": user, "schemaName": schemaName, "schema": schema})
        if self.fn:
            return self.fn(system=system, user=user, schemaName=schemaName, schema=schema)
        return self.answers.get(schemaName)


def with_llm(session, llm) -> None:
    """세션에 가짜 LLM을 붙인다(오케스트레이터와 Agent B 모두)."""
    session.deps.llm = llm
    session.deps.welfare.llm = llm


@pytest.fixture
def http_mock(monkeypatch):
    """httpx.AsyncClient 요청을 가짜 응답으로 바꾼다(네트워크 없음). use(handler) → 요청 목록."""
    import httpx

    calls: list = []
    state: dict = {"handler": None}
    orig = httpx.AsyncClient.__init__

    def handle(request):
        calls.append(request)
        return state["handler"](request)

    def init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handle)
        orig(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", init)

    def use(handler):
        state["handler"] = handler
        return calls

    return use


def field_value(r: dict, field_id: str):
    return next((f["value"] for f in (r.get("observation") or {}).get("fields", []) if f["fieldId"] == field_id), None)
