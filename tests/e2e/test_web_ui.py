"""웹 UI(바닐라 JS) E2E: 실제 서버(API + 정적 UI)를 띄우고 Chromium으로 화면을 조작한다."""
import asyncio
import socket
from types import SimpleNamespace

import pytest_asyncio
import uvicorn
from conftest import create_test_runtime
from playwright.async_api import expect

from cheongeum.agents.web.browser import launch_browser
from cheongeum.server import close_all, create_app
from cheongeum.server.app import mount_web_ui


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest_asyncio.fixture(scope="module")
async def ui_url():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
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
export const applySpeechPrefs = real.applySpeechPrefs;
export const browserTts = real.browserTts;
export const serverTts = real.serverTts;
export const progressVoice = real.progressVoice;
export const isSpeaking = real.isSpeaking;
export const splitForSpeech = real.splitForSpeech;
export const takeInterruptedSpeech = real.takeInterruptedSpeech;
export const CUE_KINDS = real.CUE_KINDS;
export const MIC_OPEN_CUES = real.MIC_OPEN_CUES;
export const preloadCues = real.preloadCues;
export const renderCue = real.renderCue;
export const transitionCue = real.transitionCue;
export function earcon(kind) {
  (window.__cues ??= []).push(kind);
  return real.earcon(kind);
}
"""


async def record_cues(page):
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
    app, sessions = create_app(rt, voice=SimpleNamespace(stt=TextStt(), tts=rt.tts))
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
export const browserStt = { supported: false, listen() { return () => {}; } };
export async function startRecording() { throw new Error('no mic'); }
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
const now = () => performance.now();
export const applySpeechPrefs = real.applySpeechPrefs;
export const serverTts = real.serverTts;
export const progressVoice = real.progressVoice;
export const takeInterruptedSpeech = real.takeInterruptedSpeech;
export const preloadCues = real.preloadCues;
export const transitionCue = real.transitionCue;
export const browserTts = {
  supported: true,
  speak() {},
  async speakAndWait() {
    const start = now();
    await new Promise((r) => setTimeout(r, window.__speakMs));
    (window.__talking ??= []).push([start, now()]);
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
