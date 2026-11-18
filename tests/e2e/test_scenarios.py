import pytest

from cheongeum.evaluation import DEMO_SCENARIO_PATH, is_active_pc, load_scenario_file, run_scenario

FILE = load_scenario_file(DEMO_SCENARIO_PATH)
# 시나리오 파일에는 planned로 남아 있지만 Phase 2에서 구현한 PC 시나리오(파일은 원본 문서라 수정하지 않음)
IMPLEMENTED_PHASE2 = ["S5-agent-collaboration"]
SCENARIOS = [s for s in FILE.scenarios if is_active_pc(s) or s.id in IMPLEMENTED_PHASE2]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=[s.id for s in SCENARIOS])
async def test_demo_scenario(new_session, scenario):
    session = await new_session()
    report = await run_scenario(scenario, session)
    failures = [f'"{s.utterance}" → {"; ".join(s.failures)}' for s in report.steps if not s.pass_]
    assert failures == [], "\n".join(failures)
