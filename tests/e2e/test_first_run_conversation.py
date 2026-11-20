"""첫 실행 뒤의 대화: 부르는 이름으로 인사하고, 동의 뒤 음성 단계를 차례로 진행한다."""
import pytest_asyncio

from conftest import create_test_runtime


@pytest_asyncio.fixture(scope="module")
async def personal_runtime():
    rt = create_test_runtime({"PILOT_PROFILE": "personal"})
    yield rt
    await rt.close()


async def test_consent_greets_by_saved_call_name(new_session, personal_runtime):
    personal_runtime.personal_store().set_call_name("홍길동")
    try:
        s = await new_session(personal_runtime)
        result = await s.consent_to(True)
        assert result["speech"].startswith("홍길동님, 반가워요.")
    finally:
        personal_runtime.personal_store().set_call_name(None)


async def test_consent_without_a_name_keeps_the_usual_greeting(new_session):
    s = await new_session()
    assert (await s.consent_to(True))["speech"].startswith("동의해 주셔서 감사합니다.")


async def test_vault_read_includes_call_name(new_session, personal_runtime):
    personal_runtime.personal_store().set_call_name("홍길동")
    try:
        s = await new_session(personal_runtime)
        assert "부르는 이름 홍길동님" in (await s.handle_turn("내 정보 알려줘"))["speech"]
    finally:
        personal_runtime.personal_store().set_call_name(None)


async def test_name_kept_only_for_the_session_without_a_personal_store(new_session):
    s = await new_session()
    assert s.deps.personal is None
    assert s.remember_call_name("홍길동") is False and s.call_name == "홍길동"
    other = await new_session()
    assert other.call_name is None


# ---------------------------------------------------------------- 동의 뒤 음성 단계

import pytest  # noqa: E402
from pydantic import SecretStr  # noqa: E402

from cheongeum.orchestrator.first_run import LINES  # noqa: E402
from cheongeum.personal.seal import Seal  # noqa: E402
from cheongeum.server.settings import SettingsInput, SettingsStore  # noqa: E402


def _runtime(tmp_path, device="personal", step="stage2"):
    rt = create_test_runtime({"PILOT_PROFILE": "personal"} if device == "personal" else {})
    rt.settings = SettingsStore(tmp_path / "preferences.json", lambda: Seal(key=b"f" * 32))
    rt.settings.save(SettingsInput(apiKey=SecretStr("sk-test"), deviceUse=device))
    if step != "stage2":
        rt.settings.set_first_run(step)
    return rt


@pytest_asyncio.fixture
async def personal_first_run(tmp_path):
    rt = _runtime(tmp_path)
    yield rt
    await rt.close()


@pytest_asyncio.fixture
async def shared_first_run(tmp_path):
    rt = _runtime(tmp_path, device="shared")
    yield rt
    await rt.close()


async def _to_stop_step(s):
    await s.consent_to(True)
    await s.handle_turn("안녕하세요")
    await s.handle_turn("홍길동이라고 불러 줘")
    return await s.handle_turn("네")


async def test_consent_on_first_run_starts_the_mic_check(new_session, personal_first_run):
    s = await new_session(personal_first_run)
    r = await s.consent_to(True)
    assert r["speech"].endswith(LINES["mic"]["ko"])
    assert s.dialogue.first_run == "mic" and personal_first_run.settings.first_run == "mic"


async def test_name_saved_on_personal_pc_after_yes(new_session, personal_first_run):
    s = await new_session(personal_first_run)
    await s.consent_to(True)
    heard = await s.handle_turn("안녕하세요")
    assert "'안녕하세요'라고 들었어요" in heard["speech"] and LINES["name"]["ko"] in heard["speech"]
    asked = await s.handle_turn("홍길동이라고 불러 줘")
    assert "홍길동님이라고 부를게요" in asked["speech"]
    done = await s.handle_turn("네")
    assert LINES["stop-practice"]["ko"] in done["speech"] and LINES["name-shared"]["ko"] not in done["speech"]
    assert personal_first_run.personal_store().call_name() == "홍길동"
    assert personal_first_run.settings.first_run == "stop"


async def test_name_on_shared_pc_is_session_only_and_not_greeted_next_time(new_session, shared_first_run):
    s = await new_session(shared_first_run)
    done = await _to_stop_step(s)
    assert LINES["name-shared"]["ko"] in done["speech"] and s.call_name == "홍길동"
    again = await new_session(shared_first_run)
    assert "홍길동" not in (await again.consent_to(True))["speech"]


async def test_stop_on_the_stop_step_praises_then_yes_plays_the_intro(new_session, personal_first_run):
    s = await new_session(personal_first_run)
    await _to_stop_step(s)
    stopped = await s.handle_turn("멈춰")
    assert stopped["speech"] == LINES["stop-praise"]["ko"] and s.dialogue.first_run == "intro"
    intro = await s.handle_turn("네")
    script = intro["introScript"]
    assert [line["pose"] for line in script][:7] == ["welcome", "listening", "screen-reading", "confirmation",
                                                    "auth-handoff", "stopped", "complete"]
    assert script[0]["text"].startswith("홍길동님, 반가워요!")
    assert script[-1]["text"] == LINES["practice-offer"]["ko"] and script[-1]["ask"] is True
    assert s.dialogue.first_run == "practice" and personal_first_run.settings.first_run == "practice"


async def test_another_command_ends_the_guide_and_runs_it(new_session, personal_first_run):
    s = await new_session(personal_first_run)
    await s.web.adapter.page.route("https://www.bokjiro.go.kr/**",
                                   lambda r: r.fulfill(body="<title>복지로</title><main>복지로</main>", content_type="text/html"))
    await s.consent_to(True)
    await s.handle_turn("안녕하세요")
    opened = await s.handle_turn("복지로 열어줘")
    assert opened["intentType"] == "OPEN_SITE" and s.dialogue.first_run is None
    assert personal_first_run.settings.first_run == "name"


@pytest.mark.parametrize("step", ["name"])
async def test_reopened_session_resumes_at_recorded_step(new_session, tmp_path, step):
    rt = _runtime(tmp_path, step=step)
    try:
        s = await new_session(rt)
        assert (await s.consent_to(True))["speech"].endswith(LINES["name"]["ko"])
        # 이어 가기는 한 번만: 이번에도 끝내지 않고 앱을 닫으면 다음에는 묻지 않는다
        assert rt.settings.first_run == "done"
        later = await new_session(rt)
        assert LINES["name"]["ko"] not in (await later.consent_to(True))["speech"]
    finally:
        await rt.close()


async def test_practice_yes_opens_the_practice_form_and_finishes(new_session, tmp_path):
    rt = _runtime(tmp_path, step="practice")
    try:
        s = await new_session(rt)
        assert (await s.consent_to(True))["speech"].endswith(LINES["practice-offer"]["ko"])
        opened = await s.handle_turn("네")
        assert opened["state"] == "APPLICATION_OPEN" and s.dialogue.first_run is None
        assert rt.settings.first_run == "done"
    finally:
        await rt.close()


async def test_practice_no_finishes_quietly(new_session, tmp_path):
    rt = _runtime(tmp_path, step="practice")
    try:
        s = await new_session(rt)
        await s.consent_to(True)
        assert (await s.handle_turn("아니요"))["speech"] == LINES["practice-no"]["ko"]
        assert rt.settings.first_run == "done" and s.dialogue.first_run is None
    finally:
        await rt.close()


async def test_call_name_stays_out_of_the_history_sent_to_models(new_session, personal_first_run):
    s = await new_session(personal_first_run)
    await _to_stop_step(s)
    await s.handle_turn("멈춰")
    await s.handle_turn("네")
    texts = " ".join(h["text"] for h in s.export_history())
    assert "홍길동" not in texts and "홍길동" not in " ".join(s._recent_dialogue(20))
    again = await new_session(personal_first_run)
    greeted = await again.consent_to(True)
    assert greeted["speech"].startswith("홍길동님")
    assert "홍길동" not in " ".join(h["text"] for h in again.export_history())
