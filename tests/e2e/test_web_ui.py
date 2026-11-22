"""웹 UI(바닐라 JS) E2E: 실제 서버(API + 정적 UI)를 띄우고 Chromium으로 화면을 조작한다."""
import asyncio
import json
import socket
from types import SimpleNamespace

import pytest
import pytest_asyncio
import uvicorn
from conftest import ROOT, create_test_runtime
from playwright.async_api import expect

from cheongeum.agents.web.browser import launch_browser
from cheongeum.server import close_all, create_app
from cheongeum.server.app import mount_web_ui


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture
async def ui_url(request):
    rt = create_test_runtime({"REQUIRE_CONSENT": "true", **getattr(request, "param", {})})
    app, sessions = create_app(rt)
    mount_web_ui(app)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    server.should_exit = True
    await task
    await close_all(sessions)
    await rt.close()


@pytest_asyncio.fixture
async def page():
    browser = await launch_browser(headless=True)
    ctx = await browser.new_context(locale="ko-KR")
    p = await ctx.new_page()
    yield p
    await browser.close()


@pytest.mark.parametrize("ui_url", [{"REQUIRE_CONSENT": "false"}], indirect=True)
async def test_typed_vault_reply_is_bound_when_typing_starts(ui_url, page):
    question = "내 이름은 박하늘이라고 저장해줘"
    ready, release = asyncio.Event(), asyncio.Event()
    answers = []

    async def hold_prompt(route):
        body = route.request.post_data_json
        if body["text"] == question:
            response = await route.fetch()
            ready.set()
            await release.wait()
            return await route.fulfill(response=response)
        answers.append(body["actionId"])
        await route.continue_()

    await page.route("**/api/turn", hold_prompt)
    await page.goto(ui_url)
    box = page.locator("#command")
    await box.fill(question)
    await box.press("Enter")
    try:
        await asyncio.wait_for(ready.wait(), 10)
        await box.fill("응")
    finally:
        release.set()
    panel = page.locator("#confirm-panel")
    await expect(panel).to_be_visible()
    await expect(page.locator("#send")).to_be_enabled()
    await box.press("Enter")
    await expect(page.locator("#log")).to_contain_text("확인할 작업이 바뀌었어요")
    assert answers == [""]
    await expect(panel).to_be_visible()
    await box.fill("응")
    await box.press("Enter")
    await expect(panel).to_be_hidden()
    assert answers[1]


@pytest.mark.parametrize("ui_url", [{"REQUIRE_CONSENT": "false"}], indirect=True)
async def test_held_sign_in_cancel_cannot_apply_to_another_handoff(ui_url, page):
    await page.goto(ui_url)
    box = page.locator("#command")
    cancel = page.locator("#auth-cancel")

    async def say(text):
        await expect(page.locator("#send")).to_be_enabled()
        await box.fill(text)
        async with page.expect_response(lambda response: response.url.endswith("/api/turn")) as reply:
            await box.press("Enter")
        return await (await reply.value).json()

    first = await say("로그인하고 싶어")
    await expect(cancel).to_be_enabled()
    await cancel.hover()
    await page.mouse.down()
    await say("인증 취소")
    await expect(cancel).to_be_hidden()
    second = await say("로그인하고 싶어")
    assert first["authHandoff"]["id"] != second["authHandoff"]["id"]
    await expect(cancel).to_be_enabled()
    await cancel.hover()
    await page.mouse.up()
    still = await say("화면 설명해줘")
    assert still["authHandoff"]["status"] == "waiting"
    assert still["authHandoff"]["id"] == second["authHandoff"]["id"]
    await cancel.press("Enter")
    await expect(cancel).to_be_hidden()


async def test_workspace_language_changes_starter_and_example_payloads(ui_url, page):
    from uuid import uuid4

    sid = "workspace-smoke"
    await page.route("**/api/session", lambda route: route.fulfill(json={
        "sessionId": sid, "state": "IDLE", "consentRequired": False, "lang": "ko",
    }))
    await page.route("**/api/session/*/language", lambda route: route.fulfill(json={
        "sessionId": sid, "state": "IDLE", "intentType": "SET_LANGUAGE", "semanticAction": "set-language",
        "turnId": str(uuid4()), "lang": route.request.post_data_json["lang"], "speech": "", "userUtterance": "",
    }))
    await page.goto(ui_url)
    await expect(page.locator("#welcome-panel")).to_be_visible()
    for lang, label, placeholder, snippet, start in [
        ("en", "Find a Government24 service", "Ask Cheongeum", "resident registration", "Start voice chat"),
        ("zh", "查找政府24办事服务", "向青音提问", "居民登记誊本", "开始语音对话"),
        ("ja", "政府24の行政手続きを探す", "チョンウムに質問する", "住民登録謄本", "音声会話を開始"),
        ("ko", "정부24 민원 찾기", "청음에게 물어보세요", "주민등록등본", "대화 시작"),
    ]:
        await page.locator("#lang-select").select_option(lang)
        await expect(page.locator("html")).to_have_attribute("lang", lang)
        await expect(page.locator("#command")).to_have_attribute("placeholder", placeholder)
        await expect(page.locator("#conv-start")).to_have_accessible_name(start + ("（Enter）" if lang in {"ja", "zh"} else " (Enter)"))
        await page.get_by_role("button", name=label).press("Enter")
        assert snippet in await page.locator("#command").input_value()
        await expect(page.locator("#command")).to_be_focused()
    await page.locator("#lang-select").select_option("en")
    await page.get_by_text("Show example requests", exact=True).click()
    await page.route("**/api/turn", lambda route: route.fulfill(status=409, json={"message": "Test finished"}))
    async with page.expect_request(lambda req: req.url.endswith("/api/turn")) as sent:
        await page.get_by_role("button", name="Read the main text.", exact=True).click()
    assert (await sent.value).post_data_json["text"] == "Read the main text."


async def test_consent_then_text_command(ui_url, page):
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    await page.goto(ui_url)
    hear = page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")
    await expect(hear).to_be_enabled(timeout=15000)
    await expect(hear).to_be_focused()
    await hear.click()
    yes = page.get_by_role("button", name="동의하고 시작 (Enter)")
    await expect(yes).to_be_visible()
    await yes.click()
    await expect(page.locator("#consent-panel")).to_be_hidden()
    await expect(page.locator("#log")).to_contain_text("동의해 주셔서 감사합니다")

    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("장애인연금 신청 도와줘")
    await box.press("Enter")
    await expect(page.locator("#st-state")).to_have_text("신청서 작성 중", timeout=20000)
    await expect(page.locator("#st-step")).to_contain_text("1/3")
    await expect(box).to_have_value("")  # 원문이 입력창에 남지 않음
    await expect(page.locator("#fields")).to_contain_text("성명")

    await box.fill("이름은 김하늘")
    await box.press("Enter")
    await expect(page.locator("#fields")).to_contain_text("입력됨: 김하늘", timeout=20000)
    await expect(page.locator("#actions")).to_contain_text("성공")
    assert errors == []


async def test_decline_and_high_contrast(ui_url, page):
    await page.goto(ui_url)
    await expect(page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")).to_be_enabled(timeout=15000)
    await page.get_by_role("button", name="안내 듣고 시작하기 (Enter)").click()
    await page.keyboard.press("Escape")
    await expect(page.locator("#log")).to_contain_text("복지 제도 질문에만 답할게요")
    await expect(page.get_by_role("button", name="대화 시작 (Enter)")).to_be_disabled()
    await page.get_by_role("button", name="고대비 꺼짐").click()
    await expect(page.locator("#app")).to_have_class("app high-contrast")


@pytest.mark.parametrize("granted", [True, False], ids=["voice-consent", "questions-only"])
async def test_starters_match_consent_and_stage_an_editable_question(ui_url, page, granted):
    await page.goto(ui_url)
    hear = page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")
    await expect(hear).to_be_focused()
    await hear.press("Enter")
    choice = "동의하고 시작 (Enter)" if granted else "동의하지 않음 (Esc)"
    await page.get_by_role("button", name=choice).press("Enter")
    starters = page.get_by_role("group", name="요청 예시 선택")
    await expect(starters.get_by_role("button")).to_have_count(5 if granted else 3)
    if granted:
        await expect(page.locator("#log li")).to_have_count(1)
        await expect(page.locator("#consent-record")).to_contain_text("동의해 주셔서 감사합니다")
        await expect(page.locator("#dictation-hint")).to_be_visible()
        label, request = "복지로 열기", "복지로 열어줘"
    else:
        await expect(starters.get_by_role("button", name="복지로 열기")).to_have_count(0)
        await expect(page.locator("#log")).to_contain_text("복지 제도 질문에만 답할게요")
        label, request = "지원 대상 알아보기", "장애인연금 지원 대상이 누구야?"

    turns = []
    page.on("request", lambda req: turns.append(req) if req.url.endswith("/api/turn") else None)
    await starters.get_by_role("button", name=label).press("Enter")
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await expect(box).to_have_value(request)
    await expect(box).to_be_focused()
    assert not turns


async def test_one_shot_api_recording_reports_listening(voice_ui_url, page):
    await fake_voice(page)
    await consented(page, voice_ui_url)
    await page.locator("#conv-end").click()
    await page.locator("#mic-btn").click()
    await expect(page.locator("#phase")).to_contain_text("듣고 있어요")
    await expect(page.locator("#conv-end")).to_be_hidden()
    async with page.expect_request(lambda req: "/api/audio/turn" in req.url and req.method == "POST"):
        await page.get_by_role("button", name="말하기 끝 (보내기)").click()


# 신호음 한도(mic.js): 박수 감지기는 봉우리/RMS > 4를 박수로, 듣기는 200ms(VoiceLoop.MIN_SPEECH_MS) 넘게 큰 소리를 말로 본다.
CUE_LIMITS_JS = """
async () => {
  const m = await import('/speaker.js');
  await m.preloadCues();
  const sr = 48000;
  const cues = {};
  for (const kind of m.CUE_KINDS) {
    const ctx = new OfflineAudioContext(1, sr * 3, sr);
    m.renderCue(kind, ctx, ctx.destination, 0);
    const x = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    let crest = 0;
    for (let i = 0; i + 512 <= x.length; i += 256) {
      let p = 0, s = 0;
      for (let j = i; j < i + 512; j++) { p = Math.max(p, Math.abs(x[j])); s += x[j] * x[j]; }
      if (p >= peak * 0.25) crest = Math.max(crest, p / Math.sqrt(s / 512));
    }
    const frame = sr / 20;
    const rms = [];
    for (let i = 0; i < x.length; i += frame) {
      let s = 0;
      for (let j = i; j < i + frame; j++) s += x[j] * x[j];
      rms.push(Math.sqrt(s / frame));
    }
    const top = Math.max(...rms);
    cues[kind] = { peak, crest, loudMs: rms.filter((r) => r > top * 10 ** (-30 / 20)).length * 50 };
  }
  return { cues, micOpen: m.MIC_OPEN_CUES };
}
"""


async def test_sound_cues_stay_under_mic_detector_limits(ui_url, page):
    await page.goto(ui_url)
    r = await page.evaluate(CUE_LIMITS_JS)
    assert len(r["cues"]) == 12
    for kind, m in r["cues"].items():
        assert m["peak"] > 0.05, kind
        assert m["crest"] < 4, (kind, m)
    assert sorted(r["micOpen"]) == ["done", "stopped", "thinking", "working"]
    for kind in r["micOpen"]:
        assert r["cues"][kind]["loudMs"] < 200, (kind, r["cues"][kind])


async def test_double_clap_uses_continuous_mic_audio_and_releases_it(ui_url, page):
    await page.goto(ui_url)
    await page.locator("h1").click()
    result = await page.evaluate("""async () => {
      const { VoiceLoop } = await import('/mic.js');
      const { audioContext } = await import('/audio.js');
      const ctx = audioContext();
      await ctx.resume();
      const mic = ctx.createMediaStreamDestination();
      navigator.mediaDevices.getUserMedia = async () => mic.stream;
      const loop = new VoiceLoop();
      let hits = 0;
      await loop.startClapDetector(() => hits++);
      const rate = ctx.sampleRate;
      const buffer = ctx.createBuffer(1, Math.round(rate * 1.7), rate);
      const channel = buffer.getChannelData(0);
      // Ringing after the first clap, then the second clap and an isolated late clap.
      for (const time of [0.1, 0.16, 0.41, 1.35]) {
        channel[Math.round(time * rate)] = 1;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(mic);
      const ended = new Promise(resolve => src.onended = resolve);
      src.start();
      await ended;
      loop.stop();
      return [hits, mic.stream.getAudioTracks()[0].readyState];
    }""")
    assert result == [1, "ended"]


async def test_live_barge_in_ignores_bleed_and_short_noise(ui_url, page):
    await page.goto(ui_url)
    result = await page.evaluate("""async () => {
      const { BargeDetector } = await import('/voice-edge.js');
      const run = frames => {
        const d = new BargeDetector();
        return frames.some(([level, speaking]) => d.feed(level, speaking));
      };
      const quiet = Array(20).fill([0.005, false]);
      const bleed = Array(40).fill([0.012, true]);
      const voice = n => Array(n).fill([0.15, true]);
      return {
        bleedOnly: run([...quiet, ...bleed]),
        shortSpike: run([...quiet, ...bleed, ...voice(3), ...bleed]),
        talkingOver: run([...quiet, ...bleed, ...voice(8)]),
        talkingWhileSilent: run([...quiet, ...Array(20).fill([0.15, false])]),
      };
    }""")
    assert result == {"bleedOnly": False, "shortSpike": False, "talkingOver": True, "talkingWhileSilent": False}


async def test_live_mode_talking_over_local_speech_stops_it(ui_url, page):
    await page.goto(ui_url)
    await page.locator("h1").click()
    result = await page.evaluate("""async () => {
      const { LiveConversation } = await import('/voice-edge.js');
      const { serverTts } = await import('/speaker.js');
      const { audioContext } = await import('/audio.js');
      const ctx = audioContext();
      await ctx.resume();
      const mic = ctx.createMediaStreamDestination();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const tone = ctx.createOscillator();
      tone.connect(gain).connect(mic);
      tone.start();
      let cancels = 0;
      serverTts.cancel = () => { cancels++; };
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const live = new LiveConversation('s', {});
      live.watchBargeIn(mic.stream);
      gain.gain.value = 0.4;
      await sleep(600);
      const whileListening = cancels;
      gain.gain.value = 0;
      live.localSpeech = true;
      await sleep(400);
      const whileQuiet = cancels;
      gain.gain.value = 0.4;
      await sleep(700);
      const whileTalkingOver = cancels;
      live.stop();
      tone.stop();
      return { whileListening, whileQuiet, stopped: whileTalkingOver > 0,
               micStillLive: mic.stream.getAudioTracks()[0].readyState };
    }""")
    assert result == {"whileListening": 0, "whileQuiet": 0, "stopped": True, "micStillLive": "live"}


async def test_clap_stop_during_permission_prompt(ui_url, page):
    await page.goto(ui_url)
    state = await page.evaluate("""async () => {
      const { VoiceLoop } = await import('/mic.js');
      const { audioContext } = await import('/audio.js');
      const mic = audioContext().createMediaStreamDestination();
      let requested, grant;
      const prompt = new Promise(r => requested = r);
      navigator.mediaDevices.getUserMedia = () => new Promise(r => { grant = r; requested(); });
      const loop = new VoiceLoop();
      const starting = loop.startClapDetector(() => {});
      await prompt;
      loop.stop();
      grant(mic.stream);
      await starting;
      return mic.stream.getAudioTracks()[0].readyState;
    }""")
    assert state == "ended"


async def test_private_speech_mutes_existing_and_new_uploading_microphones(ui_url, page):
    await page.goto(ui_url)
    await page.locator("h1").click()
    state = await page.evaluate("""async () => {
      const { VoiceLoop, startRecording } = await import('/mic.js');
      const { withPrivateReadback } = await import('/speaker.js');
      const { LiveConversation } = await import('/voice-edge.js');
      const { audioContext } = await import('/audio.js');
      const tracks = [];
      navigator.mediaDevices.getUserMedia = async () => {
        const stream = audioContext().createMediaStreamDestination().stream;
        tracks.push(stream.getAudioTracks()[0]);
        return stream;
      };
      let complete;
      const loop = new VoiceLoop();
      await loop.start();
      const stopWatch = loop.watchBargeIn(() => {});
      const playback = withPrivateReadback(() => new Promise(resolve => { complete = resolve; }));
      const pendingRecord = await startRecording(() => ({ append() {}, cancel() {} }), undefined, () => {});
      const live = new LiveConversation('test', {});
      const muted = tracks.every(track => !track.enabled) && live.localSpeech === true;
      complete();
      await playback;
      const restored = tracks.every(track => track.enabled);
      stopWatch();
      pendingRecord.cancel();
      loop.stop();
      return { muted, restored };
    }""")
    assert state == {"muted": True, "restored": True}


async def test_transition_cue_only_on_state_change(ui_url, page):
    await page.goto(ui_url)
    got = await page.evaluate("""async () => {
      const { transitionCue: t } = await import('/speaker.js');
      return [
        t('APPLICATION_OPEN', 'WAITING_FOR_USER_CONFIRMATION'), t('BROWSING', 'AUTH_HANDOFF'),
        t('APPLICATION_OPEN', 'MOCK_SUBMITTED'), t('APPLICATION_OPEN', 'RECOVERING'),
        t('APPLICATION_OPEN', 'VALIDATION_ERROR'), t('APPLICATION_OPEN', 'STOPPED'),
        t('MOCK_SUBMITTED', 'MOCK_SUBMITTED'), t('STOPPED', 'STOPPED'),
        t('WAITING_FOR_USER_CONFIRMATION', 'WAITING_FOR_USER_CONFIRMATION'),
        t('IDLE', 'APPLICATION_OPEN'), t('APPLICATION_OPEN', 'DONE'),
      ];
    }""")
    assert got == ["approve", "handoff", "success", "problem", "problem", "stopped", None, None, None, None, None]


async def test_earcon_always_resolves(ui_url, page):
    await page.goto(ui_url)
    hung = await page.evaluate("""async () => {
      const m = await import('/speaker.js');
      await m.preloadCues();
      const out = [];
      for (const k of m.CUE_KINDS) {
        const r = await Promise.race([m.earcon(k).then(() => 'ok'), new Promise((res) => setTimeout(() => res('hung'), 2500))]);
        if (r !== 'ok') out.push(k);
      }
      return out;
    }""")
    assert hung == []


# speaker.js를 감싸 earcon 호출을 window.__cues에 적는다(제품 코드에 시험용 갈고리를 두지 않음).
RECORD_CUES = """
import * as real from '/speaker.js?real';
export * from '/speaker.js?real';
export function earcon(kind) {
  (window.__cues ??= []).push(kind);
  return real.earcon(kind);
}
"""


async def record_cues(page):
    async def with_tts(route):
        response = await route.fetch()
        health = await response.json()
        await route.fulfill(json={**health, "tts": {"supported": True, "provider": "test-tts"}})
    await page.route("**/api/health", with_tts)
    await page.route("**/api/audio/speak", lambda route: route.fulfill(status=503, json={"message": "시험 음성"}))
    async def serve(route):
        await route.fulfill(content_type="text/javascript", body=RECORD_CUES)

    await page.route(lambda url: str(url).endswith("/speaker.js"), serve)


async def consented(page, ui_url):
    await page.goto(ui_url)
    hear = page.get_by_role("button", name="안내 듣고 시작하기 (Enter)")
    await expect(hear).to_be_enabled(timeout=15000)
    await hear.click()
    await page.get_by_role("button", name="동의하고 시작 (Enter)").click()
    await expect(page.locator("#consent-panel")).to_be_hidden()


async def test_private_prompt_never_uses_remote_or_device_speech(ui_url, page):
    await record_cues(page)
    await page.route("**/api/audio/speak", lambda route: route.fulfill(path=ROOT / "web/public/cues/done.ogg", content_type="audio/ogg"))
    await page.add_init_script("""
      window.privateSpeech = [];
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      const voices = [{name: 'Online', lang: 'ko-KR', localService: false}];
      voices.push({name: 'Device', lang: 'ko-KR', localService: true});
      window.speechSynthesis.getVoices = () => voices;
      window.speechSynthesis.speak = u => {
        window.privateSpeech.push([u.text, u.voice?.name]);
        queueMicrotask(() => u.onend?.());
      };
    """)
    remote = []
    page.on("request", lambda req: remote.append(req.post_data_json["text"]) if req.url.endswith("/api/audio/speak") else None)
    await consented(page, ui_url)
    box = page.locator("#command")
    await box.fill("내 이름은 별구름이라고 저장해줘")
    async with page.expect_request(lambda req: req.url.endswith("/api/audio/speak") and "화면 낭독기" in req.post_data_json["text"],
                                   timeout=5000):
        await box.press("Enter")
    await expect(page.locator("#log")).to_contain_text("이름 별구름")
    await expect(page.locator("#log")).to_have_attribute("tabindex", "0")
    assert any("화면 낭독기" in text for text in remote)
    assert await page.evaluate("window.privateSpeech") == []
    assert all("별구름" not in text for text in remote)


async def test_provider_speech_recovers_the_interrupted_chunk_and_announces_once(ui_url, page):
    await page.goto(ui_url)
    await page.locator("h1").click()
    calls = await page.evaluate("""async () => {
      const { serverTts } = await import('/speaker.js');
      const { audioContext } = await import('/audio.js');
      await audioContext().resume();
      const cue = await (await fetch('/cues/done.ogg')).blob();
      const calls = [];
      let interrupted = false;
      const synthesize = async text => {
        calls.push(text);
        if (text === '두 번째.' && !interrupted) {
          interrupted = true;
          throw Object.assign(new Error(), {status: 503});
        }
        return cue;
      };
      await serverTts.speak('첫 번째. 두 번째.', synthesize);
      await serverTts.speak('다음 안내.', synthesize);
      return calls;
    }""")
    assert calls == ["첫 번째.", "두 번째.", "두 번째.", "음성 연결이 잠시 끊겼다가 다시 연결됐어요.", "다음 안내."]


async def test_static_ui_serves_the_shared_voice_profile_and_all_coral_setup_recordings(ui_url, page):
    profile = await page.request.get(ui_url + "voice-profile.json")
    assert await profile.json() == json.loads((ROOT / "src/core/voice_profile.json").read_text(encoding="utf-8"))
    directory = ROOT / "web/public/setup-audio"
    for path in (path for path in directory.rglob("*") if path.is_file()):
        response = await page.request.get(ui_url + "setup-audio/" + path.relative_to(directory).as_posix())
        assert response.ok and await response.body() == path.read_bytes(), path.name


async def fill_to_approval(page):
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("장애인연금 신청 도와줘")
    await box.press("Enter")
    await expect(page.locator("#st-state")).to_have_text("신청서 작성 중", timeout=20000)
    await box.fill("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10")
    await box.press("Enter")
    await expect(page.locator("#fields")).to_contain_text("입력됨: 김하늘", timeout=20000)
    await box.fill("제출해")
    await box.press("Enter")
    await expect(page.locator("#st-state")).to_have_text("승인 대기", timeout=20000)


@pytest.mark.parametrize("ui_url", [{"REQUIRE_CONSENT": "false"}], indirect=True)
async def test_pointer_held_on_old_vault_prompt_cannot_approve_its_replacement(ui_url, page):
    await page.goto(ui_url)
    box = page.locator("#command")
    button = page.locator("#confirm-yes")
    await box.fill("내 이름은 구름별이라고 저장해줘")
    await box.press("Enter")
    await expect(button).to_be_enabled()
    await button.hover()
    await page.mouse.down()
    await box.fill("내 이름은 여름별이라고 저장해줘")
    await box.press("Enter")
    await expect(page.locator("#log")).to_contain_text("이름 여름별")
    await expect(button).to_be_enabled()
    await button.hover()
    await page.mouse.up()
    await box.fill("내 정보 알려줘")
    await expect(page.locator("#send")).to_be_enabled()
    await box.press("Enter")
    await expect(page.locator("#log")).to_contain_text("저장된 정보가 없어요.")


async def test_approval_plays_its_cue_once(ui_url, page):
    await record_cues(page)
    await consented(page, ui_url)
    await expect(page.locator("#tts-toggle")).to_have_text("음성 안내 켜짐")
    await fill_to_approval(page)
    assert await page.evaluate("window.__cues ?? []") == ["approve"]


async def test_stop_plays_stopped_once_even_with_voice_guidance_off(ui_url, page):
    await record_cues(page)
    await consented(page, ui_url)
    await page.get_by_role("button", name="음성 안내 켜짐").click()
    await fill_to_approval(page)
    assert await page.evaluate("window.__cues ?? []") == []
    await page.get_by_role("button", name="멈춰 (모든 동작 중단)").click()
    await expect(page.locator("#st-state")).to_have_text("중단됨", timeout=20000)
    assert await page.evaluate("window.__cues ?? []") == ["stopped"]


class TextStt:
    """녹음 대신 글자를 보내는 받아쓰기. 진행 물음이 아니면 늦게 돌려준다(오래 걸리는 일)."""

    name = "test-text"
    supported = True
    localLanguages = ["ko"]

    async def transcribe(self, audio: bytes, *, language: str, mime_type: str, signal=None) -> dict:
        text = audio.decode().strip()
        if "어디까지" not in text:
            await asyncio.sleep(6)
        return {"text": text}


@pytest_asyncio.fixture(scope="module")
async def voice_ui_url():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    app, sessions = create_app(rt, voice=SimpleNamespace(stt=TextStt(), tts=SimpleNamespace(supported=True, name="test-tts")))
    mount_web_ui(app)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    server.should_exit = True
    await task
    await close_all(sessions)
    await rt.close()


# 마이크 대신: window.__clips의 글자를 차례로 한 발화씩 돌려준다. 없으면 cancelListening()까지 기다린다.
FAKE_MIC = """
export async function startRecording() { return { stop: async () => new Blob(['기초연금'.padEnd(300, ' ')], {type:'audio/webm'}), cancel() {} }; }
export async function listMicrophones() { return []; }
export function preferredMicrophone() { return undefined; }
export class VoiceLoop {
  async start() {}
  get deviceLabel() { return '시험 마이크'; }
  async isSilent() { return false; }
  async startClapDetector() {}
  listenOnce() {
    const text = (window.__clips ??= []).shift();
    if (text) return Promise.resolve(new Blob([text.padEnd(300, ' ')], { type: 'audio/webm' }));
    return new Promise((resolve) => { this.pending = resolve; });
  }
  cancelListening() { this.pending?.(null); this.pending = undefined; }
  watchBargeIn() { return () => {}; }
  async listenAfterBarge() { return null; }
  stop() { this.cancelListening(); }
}
"""

# 말하기 대신: 한 번 말할 때마다 window.__speakMs 동안 말한 것으로 치고 [시작, 끝]을 window.__talking에,
# 신호음은 [종류, 시각]을 window.__cues에 적는다.
FAKE_SPEECH = """
import * as real from '/speaker.js?real';
export * from '/speaker.js?real';
const now = () => performance.now();
export const serverTts = {
  async speak() {
    const start = now();
    await new Promise((r) => setTimeout(r, window.__speakMs));
    (window.__talking ??= []).push([start, now()]);
    return "played";
  },
  cancel() {},
};
export function earcon(kind) {
  (window.__cues ??= []).push([kind, now()]);
  return real.earcon(kind);
}
"""


def serve_js(body):
    async def serve(route):
        await route.fulfill(content_type="text/javascript", body=body)

    return serve


async def fake_voice(page):
    await page.route(lambda url: str(url).endswith("/mic.js"), serve_js(FAKE_MIC))
    await page.route(lambda url: str(url).endswith("/speaker.js"), serve_js(FAKE_SPEECH))


async def test_progress_cues_never_play_over_speech(voice_ui_url, page):
    await fake_voice(page)
    # 동의하면 바로 대화가 시작된다: 질문(6초 걸림)을 받고, 일하는 동안 진행 상황을 묻는다.
    await page.add_init_script("""
      window.__speakMs = 2500;
      window.__clips = ['장애인연금이 뭐야', '지금 어디까지 했어?'];
    """)
    await consented(page, voice_ui_url)
    # 동의 안내 → 인사 → 진행 물음의 답 → 질문의 답을 말한 뒤 다시 듣기 신호음까지
    await page.wait_for_function(
        "() => (window.__talking ?? []).length >= 4"
        " && (window.__cues ?? []).filter(([k]) => k === 'listen').length >= 2",
        timeout=40000,
    )
    talking = await page.evaluate("window.__talking")
    cues = await page.evaluate("window.__cues")
    progress = [(kind, round(at)) for kind, at in cues if kind in ("thinking", "working")]
    assert any(kind == "working" for kind, _ in progress), cues
    over_speech = [(kind, at) for kind, at in progress if any(s <= at <= e for s, e in talking)]
    assert over_speech == [], (over_speech, [(round(s), round(e)) for s, e in talking])


async def test_keyboard_welfare_answer_shows_source_date_and_next_action(ui_url, page):
    await page.goto(ui_url)
    await page.get_by_role("button", name="안내 듣고 시작하기 (Enter)").press("Enter")
    await page.get_by_role("button", name="동의하고 시작 (Enter)").press("Enter")
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("장애인연금 지원대상이 누구야?")
    await box.press("Enter")
    card = page.get_by_role("region", name="복지 제도 답변")
    await expect(card).to_be_visible()
    await expect(card).to_contain_text("저장된 자료")
    await expect(card).to_contain_text("2026-11-15")
    await expect(card).to_contain_text("다음 행동")
    assert (await card.get_by_role("link").get_attribute("href")).startswith("https://")
    await expect(box).to_be_focused()


@pytest.mark.parametrize("ui_url", [{"PILOT_PROFILE": "personal"}], indirect=True)
async def test_same_tab_reload_offers_resume_with_microphone_off(ui_url, page):
    await page.goto(ui_url)
    await page.get_by_role("button", name="복구 켜고 시작").press("Enter")
    await page.get_by_role("button", name="안내 듣고 시작하기 (Enter)").press("Enter")
    await page.get_by_role("button", name="동의하고 시작 (Enter)").press("Enter")
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("127.0.0.1:5174/external.html 열어줘")
    await box.press("Enter")
    await expect(page.locator("#st-access")).to_contain_text("읽기 전용")
    await box.fill("이름 칸에 김하늘 써줘")
    await box.press("Enter")
    await expect(page.get_by_role("button", name="입력 승인")).to_be_visible()
    token = await page.evaluate("sessionStorage.getItem('cheongeum.recovery')")
    await page.reload()
    restore = page.get_by_role("button", name="이전 작업 이어하기")
    await expect(restore).to_be_visible()
    await expect(box).to_be_disabled()
    await restore.press("Enter")
    await expect(page.get_by_role("button", name="입력 승인")).to_be_hidden()
    await expect(page.get_by_role("button", name="음성 입력", exact=True)).to_have_attribute("aria-pressed", "false")
    await expect(page.locator("#log")).not_to_contain_text("김하늘")
    assert await page.evaluate("sessionStorage.getItem('cheongeum.recovery')") != token
    await page.get_by_role("button", name="이용 종료", exact=True).press("Enter")
    await expect(page.get_by_role("button", name="새 작업 시작")).to_be_focused()
    assert await page.evaluate("sessionStorage.getItem('cheongeum.recovery')") is None

async def test_no_key_never_uses_browser_speech(ui_url, page):
    await page.add_init_script("""
      window.browserVoiceCalls = 0;
      window.SpeechRecognition = class {
        static async available() { window.browserVoiceCalls++; return 'available'; }
        start() { window.browserVoiceCalls++; }
      };
      window.speechSynthesis.speak = () => { window.browserVoiceCalls++; };
    """)
    await consented(page, ui_url)
    await expect(page.locator("#mic-btn")).to_be_disabled()
    await expect(page.locator("#conv-start")).to_be_disabled()
    await expect(page.locator("#tts-toggle")).to_be_disabled()
    await expect(page.locator("#dictation-hint")).to_contain_text("API 키")
    await expect(page.locator("#command")).to_be_enabled()
    assert await page.evaluate("window.browserVoiceCalls") == 0


async def test_field_confirmation_reads_same_destination_and_stale_id_cannot_write(ui_url, page):
    await page.goto(ui_url)
    await page.get_by_role("button", name="안내 듣고 시작하기 (Enter)").click()
    await page.get_by_role("button", name="동의하고 시작 (Enter)").click()
    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("127.0.0.1:5174/external.html 열어줘")
    await box.press("Enter")
    await expect(page.locator("#st-access")).to_contain_text("읽기 전용")
    await box.fill("이름 칸에 김하늘 써줘")
    await box.press("Enter")
    await expect(page.get_by_role("button", name="입력 승인")).to_be_enabled()
    hint = await page.locator("#confirm-hint").inner_text()
    assert "127.0.0.1:5174" in hint and "김하늘" in hint
    await expect(page.locator("#log")).to_contain_text(hint)
    await page.get_by_role("button", name="거절", exact=True).press("Enter")
    await expect(page.locator("#confirm-panel")).to_be_hidden()
    await expect(page.locator("#fields")).not_to_contain_text("입력됨: 김하늘")
