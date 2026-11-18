import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

function microphone() {
  const stop = vi.fn();
  const tracks = [{ stop }];
  return { stop, stream: { getTracks: () => tracks, getAudioTracks: () => tracks } };
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("권한을 기다리는 중 취소하면 뒤늦게 열린 모든 마이크를 닫는다", async () => {
  const { startRecording, VoiceLoop } = await import("../../web/src/mic.ts");
  const devices = [microphone(), microphone(), microphone()];
  const pending = devices.map(() => deferred<ReturnType<typeof microphone>["stream"]>());
  const permissions = pending.values();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => permissions.next().value?.promise } });
  const loop = new VoiceLoop();
  const start = loop.start();
  const clap = loop.startClapDetector(() => {});
  const controller = new AbortController();
  const recording = startRecording(15000, controller.signal);
  loop.stop();
  controller.abort();
  devices.forEach(({ stream }, i) => pending[i]?.resolve(stream));
  await Promise.all([start, clap, expect(recording).rejects.toThrow()]);
  for (const device of devices) expect(device.stop).toHaveBeenCalledOnce();
});

it("끼어들기 제한 시간이 지난 뒤에도 다음 발화는 끝까지 녹음한다", async () => {
  vi.useFakeTimers();
  let level = 0;
  vi.stubGlobal("window", { AudioContext: class {
    state = "running";
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (data: Float32Array) => data.fill(level) }; }
  } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.resolve(microphone().stream) } });
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    onstop?: () => void;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.onstop?.(); }
  });
  const { VoiceLoop } = await import("../../web/src/mic.ts");
  const voice = new VoiceLoop();
  const start = voice.start();
  await vi.advanceTimersByTimeAsync(450);
  await start;
  level = 0.5;
  const first = voice.listenAfterBarge(2000);
  await vi.advanceTimersByTimeAsync(250);
  expect(voice.endUtterance()).toBe(true);
  expect(await first).toBeInstanceOf(Blob);
  const next = voice.listenOnce();
  await vi.advanceTimersByTimeAsync(2100);
  expect(voice.endUtterance()).toBe(true);
  expect(await next).toBeInstanceOf(Blob);
  voice.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("안내 중 짧은 말로 끼어들면 그 말을 담은 녹음을 돌려준다", async () => {
  vi.useFakeTimers();
  const word = { from: 0, to: 0 };
  const speaking = () => Date.now() >= word.from && Date.now() < word.to;
  vi.stubGlobal("window", { AudioContext: class {
    state = "running";
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (data: Float32Array) => data.fill(speaking() ? 0.2 : 0.001) }; }
  } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.resolve(microphone().stream) } });
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported() { return true; }
    state = "inactive";
    mimeType = "audio/webm";
    onstop?: (() => void) | null;
    ondataavailable?: (e: { data: Blob }) => void;
    private since = 0;
    private timer?: ReturnType<typeof setInterval>;
    start(slice: number) {
      this.state = "recording";
      this.since = Date.now();
      this.timer = setInterval(() => this.emit(), slice);
    }
    private emit() {
      const heard = word.from < Date.now() && word.to > this.since;
      this.since = Date.now();
      this.ondataavailable?.({ data: new Blob([heard ? "멈춰" : "-"]) });
    }
    stop() {
      clearInterval(this.timer);
      this.emit();
      this.state = "inactive";
      this.onstop?.();
    }
  });
  const { VoiceLoop } = await import("../../web/src/mic.ts");
  const voice = new VoiceLoop();
  const start = voice.start();
  await vi.advanceTimersByTimeAsync(450);
  await start;
  word.from = Date.now() + 500;
  word.to = word.from + 450;
  let barged = false;
  const stopWatch = voice.watchBargeIn(() => { barged = true; });
  await vi.advanceTimersByTimeAsync(1000);
  expect(barged).toBe(true);
  stopWatch();
  const clip = voice.listenAfterBarge(2000);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await (await clip)?.text()).toContain("멈춰");
  voice.stop();
});

it("취소 후 브라우저 음성 예약과 서버 음성 요청이 남지 않는다", async () => {
  vi.useFakeTimers();
  const speak = vi.fn();
  vi.stubGlobal("window", {
    speechSynthesis: { speaking: true, pending: false, cancel: vi.fn(), speak },
    AudioContext: class { state = "running"; },
  });
  vi.stubGlobal("SpeechSynthesisUtterance", class {});
  const { browserTts, serverTts, takeInterruptedSpeech } = await import("../../web/src/speaker.ts");
  const done = browserTts.speakAndWait("첫 문장");
  browserTts.cancel();
  await vi.advanceTimersByTimeAsync(100);
  await done;
  expect(speak).not.toHaveBeenCalled();
  const waiting = deferred<Blob>();
  let signal: AbortSignal | undefined;
  const remote = serverTts.speak("다음 문장", (_chunk, current) => {
    signal = current;
    return waiting.promise;
  });
  serverTts.cancel();
  expect(await remote).toBe("cancelled");
  expect(signal?.aborted).toBe(true);
  expect(takeInterruptedSpeech()).toEqual({ text: "다음 문장", fromChunk: 0, kind: "server" });
  waiting.resolve(new Blob());
});

it("이전 대화의 마이크 권한 응답은 새 대화나 키보드 바인딩에 영향을 주지 않는다", async () => {
  vi.useFakeTimers();
  const addEventListener = vi.fn();
  vi.stubGlobal("location", new URL("http://localhost/"));
  vi.stubGlobal("window", {
    addEventListener, AudioContext: class {
      state = "running";
      decodeAudioData() { return Promise.resolve({ duration: 0.1 }); }
    },
  });
  vi.stubGlobal("fetch", async () => new Response(new Blob()));
  const oldMic = microphone();
  const nextMic = microphone();
  const oldPermission = deferred<typeof oldMic.stream>();
  const nextPermission = deferred<typeof nextMic.stream>();
  const requests = [oldPermission, nextPermission].values();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => requests.next().value?.promise } });
  const { api } = await import("../../web/src/api.ts");
  const session = vi.spyOn(api, "createSession").mockResolvedValue({
    state: "IDLE", llmProvider: "mock", sessionId: "test", consentRequired: false,
  });
  vi.spyOn(api, "health").mockResolvedValue({ stt: { supported: true, provider: "local" }, tts: { supported: false, provider: "mock" } });
  vi.spyOn(api, "reminders").mockResolvedValue({});
  const ui = await import("../../web/src/conversation.ts");
  await Promise.all([ui.start(), ui.start()]);
  expect(session).toHaveBeenCalledOnce();
  expect(addEventListener.mock.calls.filter(([event]) => event === "keyup")).toHaveLength(1);
  const first = ui.startConversation();
  ui.endConversation(false);
  const second = ui.startConversation();
  oldPermission.resolve(oldMic.stream);
  await first;
  expect(oldMic.stop).toHaveBeenCalledOnce();
  expect(ui.snapshot().phase).toBe("starting");
  ui.endConversation(false);
  nextPermission.resolve(nextMic.stream);
  await second;
  expect(nextMic.stop).toHaveBeenCalledOnce();
  expect(ui.snapshot().phase).toBe("off");
  vi.spyOn(api, "turn").mockRejectedValue(new Error("offline"));
  await ui.send("입력한 비밀 원문");
  expect(ui.snapshot().messages.some(m => m.text.includes("입력한 비밀 원문"))).toBe(false);
});
