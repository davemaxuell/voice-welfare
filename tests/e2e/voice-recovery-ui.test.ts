import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { startUi } from "./web-ui-fixtures.ts";

let browser: Browser, page: Page, ui: Awaited<ReturnType<typeof startUi>>;
beforeAll(async () => { ui = await startUi(); browser = await chromium.launch(); });
beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page?.close(); await ui?.reset(); });
afterAll(async () => { await Promise.all([browser?.close(), ui?.close()]); });
async function openPage() { await page.goto(ui.url); await page.locator("h1").click(); }

it("사용자가 끈 음성은 서비스 연결 상태가 바뀌어도 꺼진 상태로 기억한다", async () => {
  await openPage();
  const preference = () => page.evaluate("import('/src/conversation.ts').then(m => m.isNarrationMuted())");
  expect(await preference()).toBe(false);
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), tts: { supported: true, provider: "test" } } });
  });
  await page.reload();
  await screen(page.locator("#tts-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#tts-toggle").click();
  await page.unroute("**/api/health");
  await page.reload();
  await screen(page.locator("#tts-toggle")).toBeDisabled();
  expect(await preference()).toBe(true);
});

it("음성이 중간에 끊겨도 실패한 문장만 재시도하고 같은 음성으로 복구를 한 번 알린다", async () => {
  await openPage();
  const result = await page.evaluate(`(async () => {
    const { serverTts, noteVoiceInterruption, reportVoiceRecovery } = await import('/src/speaker.ts');
    const { audioContext } = await import('/src/audio.ts');
    const { ApiError } = await import('/src/api.ts');
    await audioContext().resume();
    const bytes = new Uint8Array(44 + 320);
    const view = new DataView(bytes.buffer);
    const tag = (index, text) => bytes.set(new TextEncoder().encode(text), index);
    tag(0,'RIFF'); view.setUint32(4,bytes.length-8,true); tag(8,'WAVE'); tag(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,8000,true); view.setUint32(28,16000,true); view.setUint16(32,2,true);
    view.setUint16(34,16,true); tag(36,'data'); view.setUint32(40,320,true);
    const calls = [], played = [];
    let lost = false, other = 0;
    speechSynthesis.speak = () => { other++; };
    const fetchAudio = async text => {
      calls.push(text);
      if (text === '두 번째.' && !lost) {
        lost = true; noteVoiceInterruption(); await reportVoiceRecovery(fetchAudio);
        throw new ApiError('server', 'VOICE_LIMIT', 429, 0);
      }
      return new Blob([bytes], { type: 'audio/wav' });
    };
    const first = await serverTts.speak('첫 번째. 두 번째.', fetchAudio, 0, 1.25, 'ko', offset => played.push(offset));
    const next = await serverTts.speak('다음 안내.', fetchAudio);
    return { calls, first, next, other, played };
  })()`);
  expect(result).toEqual({ calls: ["첫 번째.", "두 번째.", "두 번째.", "음성 연결이 잠시 끊겼다가 다시 연결됐어요.", "다음 안내."],
    first: "played", next: "played", other: 0, played: [1, 2] });
});

it("첫 문장을 합성하는 동안 조사 결과가 기존 답변을 끊지 않고 첫 소리부터 아바타가 말한다", async () => {
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({json: {...await response.json(), workspaceAvailable: true, tts: {supported: true, provider: "test"}}});
  });
  await page.route("**/api/audio/speak", route => route.fulfill({path: "web/public/cues/done.ogg", contentType: "audio/ogg"}));
  await openPage();
  await page.locator("#consent-hear").click();
  await page.locator("#consent-yes").click();
  await screen(page.locator("#consent-panel")).toBeHidden();
  const result = await page.evaluate(`(async () => {
    const speaker = await import('/src/speaker.ts');
    const { deliverResearch } = await import('/src/conversation.ts');
    const { audioContext } = await import('/src/audio.ts');
    await audioContext().resume();
    const clip = await (await fetch('/cues/done.ogg')).blob();
    let finishFirstChunk, cancelled = false;
    const firstChunk = new Promise(resolve => { finishFirstChunk = resolve; });
    const audioEvents = [];
    speaker.serverTts.cancel();
    const off = speaker.onSpeaking(playing => audioEvents.push(playing));
    const foreground = speaker.serverTts.speak('먼저 요청한 답변이에요.', async (_, speed, signal) => {
      signal.addEventListener('abort', () => { cancelled = true; });
      await firstChunk;
      return clip;
    });
    const duringSynthesis = { reserved: speaker.isSpeechReserved(), speaking: speaker.isSpeaking() };
    const attempt = await deliverResearch('reservation-test', '다른 조사 결과예요.', 'ko');
    finishFirstChunk();
    const completed = await foreground;
    const afterSpeech = speaker.isSpeechReserved();
    off();
    const delivered = await deliverResearch('reservation-test', '다른 조사 결과예요.', 'ko');
    return { duringSynthesis, attempt, cancelled, completed, audioEvents, afterSpeech, delivered };
  })()`);
  expect(result).toEqual({duringSynthesis: {reserved: true, speaking: false}, attempt: false, cancelled: false,
    completed: "played", audioEvents: [true, false], afterSpeech: false, delivered: true});
});

it("연결 실패와 중복 닫힘 신호가 와도 기존 마이크를 놓고 새 연결 하나만 만든다", async () => {
  await openPage();
  const result = await page.evaluate(`(async () => {
    const { LiveConversation } = await import('/src/voice-edge.ts');
    const { isSpeechReserved, isSpeaking, withPrivateReadback } = await import('/src/speaker.ts');
    const { audioContext } = await import('/src/audio.ts');
    const { api } = await import('/src/api.ts');
    const peers = [], sockets = [], tracks = [];
    await audioContext().resume();
    navigator.mediaDevices.getUserMedia = async () => {
      const stream = audioContext().createMediaStreamDestination().stream;
      tracks.push(stream.getAudioTracks()[0]);
      return stream;
    };
    window.RTCPeerConnection = class extends EventTarget {
      iceGatheringState = 'complete'; connectionState = 'connected';
      channel = { readyState: 'connecting', close() { this.readyState = 'closed'; this.onclose?.(); } };
      constructor() { super(); peers.push(this); }
      addTrack() {} createDataChannel() { return this.channel; }
      createOffer() { return Promise.resolve({ type:'offer', sdp:'v=0' }); }
      async setLocalDescription(desc) { this.localDescription = desc; }
      async setRemoteDescription() { this.channel.readyState = 'open'; this.channel.onopen?.(); }
      close() {}
    };
    api.conversationSocket = () => {
      const socket = { close() { this.onclose?.({code:1000}); } };
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    };
    let offers = 0, recovered = 0, failures = 0, results = 0, finishOldResult;
    const oldResult = new Promise(resolve => { finishOldResult = resolve; });
    let recovery; const ready = new Promise(resolve => { recovery = resolve; });
    const live = new LiveConversation('session', {
      offer(socket) { offers++; socket.onmessage({ data: JSON.stringify({sdp:'answer'}) }); },
      recovered() { recovered++; recovery(); }, failure() { failures++; }, caption() {}, phase() {},
      async result(_, exact) { results++; if (exact === true) await oldResult; },
    });
    await live.start();
    const oldDelivery = sockets[0].onmessage({data: JSON.stringify({result: {}, exact: true})});
    const awaitingExact = isSpeechReserved();
    peers[0].connectionState = 'failed'; peers[0].onconnectionstatechange();
    sockets[0].onclose({code:1006}); peers[0].channel.onclose();
    await ready;
    const afterReconnect = isSpeechReserved();
    await sockets[1].onmessage({ data: JSON.stringify({result: {}, exact: false}) });
    finishOldResult();
    await oldDelivery;
    const awaitingNative = isSpeechReserved();
    peers[1].channel.onmessage({data: JSON.stringify({type:'session.output_transcript.delta', delta:'안내'})});
    const nativeOutput = isSpeechReserved();
    const duringPrivate = await withPrivateReadback(async () => {
      live.updateAudio();
      return {reserved: isSpeechReserved(), speaking: isSpeaking(), muted: live.audio.muted};
    });
    live.updateAudio();
    const afterPrivate = isSpeechReserved();
    await sockets[1].onmessage({data: JSON.stringify({result: {}, exact:false})});
    peers[1].channel.onmessage({data: JSON.stringify({type: 'session.closed'})});
    const afterSessionEnd = isSpeechReserved();
    const beforeStop = tracks.map(t => t.readyState);
    live.stop();
    return { offers, recovered, failures, results, beforeStop, afterStop: tracks.map(t => t.readyState),
      awaitingExact, afterReconnect, awaitingNative, nativeOutput, duringPrivate, afterPrivate, afterSessionEnd, afterClose: isSpeechReserved() };
  })()`);
  expect(result).toEqual({ offers: 2, recovered: 1, failures: 0, results: 3, beforeStop: ["ended", "live"], afterStop: ["ended", "ended"],
    awaitingExact: true, afterReconnect: false, awaitingNative: true, nativeOutput: true,
    duringPrivate: {reserved: true, speaking: false, muted: true}, afterPrivate: false, afterSessionEnd: false, afterClose: false });
});
