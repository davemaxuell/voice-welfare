import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { startUi } from "./web-ui-fixtures.ts";

let browser: Browser;
let ui: Awaited<ReturnType<typeof startUi>>;
let page: Page;
beforeAll(async () => { ui = await startUi(); browser = await chromium.launch({ channel: "chromium", args: ["--use-fake-device-for-media-stream"] }); }, 90_000);
beforeEach(async () => { page = await browser.newPage(); await page.goto(ui.url); }, 30_000);
afterEach(async () => { await page?.close(); await ui?.reset(); }, 30_000);
afterAll(async () => { await browser?.close(); await ui?.close(); }, 30_000);

it("마이크 권한을 거절해도 텍스트로 질문할 수 있다", async () => {
  const voice = await startUi(true, { REQUIRE_CONSENT: "false" });
  try {
    await page.context().grantPermissions([], { origin: voice.url });
    await page.goto(voice.url);
    const denied = await page.evaluate(async () => (await navigator.permissions.query({ name: "microphone" })).state);
    expect(denied).toBe("denied");
    await screen(page.locator("#mic-btn")).toBeEnabled();
    await page.locator("#mic-btn").click();
    await screen(page.locator("#error")).toContainText("브라우저 마이크 권한을 확인하거나 텍스트로 입력하세요.");
    await page.getByRole("button", { name: "마이크 설정 열기" }).click();
    await screen(page.locator("#microphone-settings")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "글로 입력", exact: true }).click();
    await screen(page.locator("#command")).toBeFocused();
    await screen(page.locator("#mic-btn")).toHaveAttribute("aria-pressed", "false");
    await page.locator("#command").fill("장애인연금이 뭐야");
    await page.locator("#command").press("Enter");
    await screen(page.locator("#log .assistant").last()).toContainText("장애인연금");
  } finally { await page.close(); await voice.close(); }
});

it("서버가 끊기면 사용 중인 수동 녹음 트랙을 닫고 음성을 보내지 않는다", async () => {
  const voice = await startUi(true, { REQUIRE_CONSENT: "false" });
  try {
    await page.context().grantPermissions(["microphone"], { origin: voice.url });
    await page.clock.install();
    await page.goto(voice.url);
    const tracks = await page.evaluateHandle(() => {
      const captured: MediaStreamTrack[] = [];
      const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await open(constraints);
        captured.push(...stream.getAudioTracks());
        return stream;
      };
      return captured;
    });
    let beats = 0, uploads = 0;
    page.on("request", r => { if (new URL(r.url()).pathname === "/api/audio/turn") uploads++; });
    await screen(page.locator("#send")).toBeEnabled();
    await page.route("**/api/session/*/heartbeat", route => { beats++; return route.abort("internetdisconnected"); });
    await page.clock.fastForward(15_100);
    await screen.poll(() => beats).toBe(1);
    await page.locator("#mic-btn").click();
    await screen(page.locator("#mic-btn")).toHaveAttribute("aria-pressed", "true");
    await page.clock.fastForward(14_950);
    await screen(page.locator("#task-label")).toHaveText("연결이 끊겼어요");
    await screen(page.locator("#capture-label")).toHaveText("마이크 꺼짐");
    const states = await tracks.evaluate(list => list.map(track => track.readyState));
    expect(states.length).toBeGreaterThan(0);
    expect(states.every(state => state === "ended")).toBe(true);
    expect(uploads).toBe(0);
  } finally { await page.close(); await voice.close(); }
});

it("듣던 마이크가 끊기면 대화를 끄고 연결 안내를 보여 준다", async () => {
  const voice = await startUi(true, { REQUIRE_CONSENT: "false" });
  try {
    await page.context().grantPermissions(["microphone"], { origin: voice.url });
    await page.goto(voice.url);
    await screen(page.locator("#conv-start")).toBeEnabled();
    await screen(page.locator("#tts-toggle")).toHaveText("음성 안내 켜짐");
    await page.locator("#tts-toggle").click();
    const track = await page.evaluateHandle(() => {
      let current: MediaStreamTrack | undefined;
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        await audio.resume();
        const mic = audio.createMediaStreamDestination();
        const tone = audio.createOscillator();
        tone.connect(mic);
        tone.start();
        current ??= mic.stream.getAudioTracks()[0];
        return mic.stream;
      };
      return () => { current?.stop(); current?.dispatchEvent(new Event("ended")); };
    });
    await page.locator("#conv-start").click();
    await screen(page.locator("#phase")).toHaveClass(/phase-listening/);
    await track.evaluate(end => end());
    await screen(page.locator("#error")).toContainText("마이크 연결이 끊겼거나");
    await screen(page.locator("#capture-label")).toHaveText("마이크 꺼짐");
    await screen(page.getByRole("button", { name: "마이크 설정 열기" })).toBeVisible();
    await screen(page.locator("#phase")).toHaveClass(/phase-off/);
    await screen(page.locator("#mic-btn")).toHaveAttribute("aria-pressed", "false");
  } finally { await page.close(); await voice.close(); }
});

it("test_double_clap_uses_continuous_mic_audio_and_releases_it", async () => {
  await page.locator("h1").click();
  const result = await page.evaluate(`(async () => {
    const { VoiceLoop } = await import('/src/mic.ts');
    const { audioContext } = await import('/src/audio.ts');
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
  })()`);
  expect(result).toEqual([1, "ended"]);
});

it("test_live_mode_talking_over_local_speech_stops_it", async () => {
  await page.locator("h1").click();
  const result = await page.evaluate(`(async () => {
    const { LiveConversation } = await import('/src/voice-edge.ts');
    const { serverTts } = await import('/src/speaker.ts');
    const { audioContext } = await import('/src/audio.ts');
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
  })()`);
  expect(result).toEqual({"whileListening": 0, "whileQuiet": 0, "stopped": true, "micStillLive": "live"});
});

it("test_clap_stop_during_permission_prompt", async () => {
  const result = await page.evaluate(`(async () => {
    const { VoiceLoop } = await import('/src/mic.ts');
    const { audioContext } = await import('/src/audio.ts');
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
  })()`);
  expect(result).toEqual("ended");
});

it("test_private_speech_mutes_existing_and_new_uploading_microphones", async () => {
  await page.locator("h1").click();
  const result = await page.evaluate(`(async () => {
    const { VoiceLoop, startRecording } = await import('/src/mic.ts');
    const { speakOnDevice } = await import('/src/speaker.ts');
    const { LiveConversation } = await import('/src/voice-edge.ts');
    const { audioContext } = await import('/src/audio.ts');
    const tracks = [];
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = audioContext().createMediaStreamDestination().stream;
      tracks.push(stream.getAudioTracks()[0]);
      return stream;
    };
    window.SpeechSynthesisUtterance = class {};
    speechSynthesis.getVoices = () => [{name: 'Device', lang: 'ko-KR', localService: true}];
    let complete;
    speechSynthesis.speak = utterance => { complete = () => utterance.onend(); };
    const loop = new VoiceLoop();
    await loop.start();
    const stopWatch = loop.watchBargeIn(() => {});
    const playback = speakOnDevice('비공개 테스트', 'ko');
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
  })()`);
  expect(result).toEqual({"muted": true, "restored": true});
});

it("마이크 권한 대기 중 설정을 열면 거절이나 늦은 허가가 오류로 남지 않는다", async () => {
  const voice = await startUi(true, { REQUIRE_CONSENT: "false" });
  try {
    await page.goto(voice.url);
    await screen(page.locator("#mic-btn")).toBeEnabled();
    await page.evaluate(`(() => {
      window.__mic = {};
      navigator.mediaDevices.getUserMedia = () => new Promise((resolve, reject) => {
        window.__mic.resolve = resolve;
        window.__mic.reject = reject;
        window.__mic.requested = true;
      });
    })()`);
    await page.locator("#mic-btn").click();
    await page.waitForFunction("window.__mic?.requested === true");
    await screen(page.locator("#capture-label")).toHaveText("마이크 준비 중");
    await page.evaluate("import('/src/conversation.ts').then(m => m.openSettings())");
    await page.evaluate("window.__mic.reject(new DOMException('dismissed', 'NotAllowedError'))");
    await page.evaluate("import('/src/conversation.ts').then(m => m.closeSettings())");
    await screen(page.locator("#capture-label")).toHaveText("마이크 꺼짐");
    await screen(page.locator("#error")).toBeHidden();

    await page.evaluate("window.__mic.requested = false");
    await page.locator("#mic-btn").click();
    await page.waitForFunction("window.__mic?.requested === true");
    await page.evaluate("import('/src/conversation.ts').then(m => m.openSettings())");
    const readyState = await page.evaluate(`(async () => {
      const { audioContext } = await import('/src/audio.ts');
      const stream = audioContext().createMediaStreamDestination().stream;
      window.__mic.resolve(stream);
      await new Promise(r => setTimeout(r, 50));
      return stream.getAudioTracks()[0].readyState;
    })()`);
    expect(readyState).toBe("ended");
    await page.evaluate("import('/src/conversation.ts').then(m => m.closeSettings())");
    await screen(page.locator("#capture-label")).toHaveText("마이크 꺼짐");
    await screen(page.locator("#error")).toBeHidden();
  } finally { await page.close(); await voice.close(); }
});
