"""No browser, no ports: SessionOrchestrator with a fake adapter. Shows what a STOPPED session does with 'resume and X'."""
import asyncio, sys, inspect
sys.path.insert(0, sys.argv[1] + "/tests"); sys.path.insert(0, sys.argv[1] + "/src")
from conftest import create_test_runtime
from cheongeum.agents.web import WebExecutionAgent
from cheongeum.agents.welfare import WelfareInformationAgent
from cheongeum.orchestrator.session import OrchestratorDeps, SessionOrchestrator
from cheongeum.safety import PolicyConfig, PolicyGuard

class FakeAdapter:
    def __init__(self, url): self.url = url
    async def observe(self):
        return {"platform": "pc", "url": self.url, "title": "시험용 포털", "fields": [], "errors": [], "dialogs": [], "capturedAt": "2026-01-01T00:00:00.000Z"}
    async def execute(self, action): raise RuntimeError("fake adapter: no execution")
    async def close(self): pass

async def run(emulate_prefix: bool):
    rt = create_test_runtime()
    guard = PolicyGuard(PolicyConfig(allowedOrigins=[rt.profile.origin], allowedActionTypes=["navigate","click","fill","read"], allowedFieldIds=[], secretFieldIds=[], maxActionsPerTurn=12, readOnlyWeb=True))
    web = WebExecutionAgent(FakeAdapter("http://127.0.0.1:5174/external.html"), guard, rt.profile)
    s = SessionOrchestrator(OrchestratorDeps(intent_provider=rt.intent_provider, web=web, welfare=WelfareInformationAgent(rt.welfare_provider, rt.answer_llm), events=rt.events))
    if emulate_prefix:
        real = s._gate
        def gate(intents):
            return None if inspect.stack()[1].function == "_route" else real(intents)
        s._gate = gate
    await s.web.observe()
    for said in ["다시 시작하고 장애인연금은 얼마야", "다시 시작하고 화면 설명해줘"]:
        assert s.cancel()["state"] == "STOPPED"
        r = await s.handle_turn(said)
        print(f"  {said!r}: intent={r['intentType']} state={r['state']}\n     speech={r['speech'][:170]!r}")
        alone = None
    assert s.cancel()["state"] == "STOPPED"
    r = await s.handle_turn("다시 시작")
    print(f"  '다시 시작' alone: state={r['state']}")

print("current tree:"); asyncio.run(run(False))
print("current tree with the _route dispatch gate disabled (emulates the tree before the gate fix):"); asyncio.run(run(True))
