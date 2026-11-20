import { afterEach, expect, it, vi } from "vitest";
import { createClapDetector } from "../../web/src/clap.ts";
import { progressVoice, splitForSpeech, transitionCue } from "../../web/src/speaker.ts";
import { BargeDetector } from "../../web/src/voice-edge.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("test_live_barge_in_ignores_bleed_and_short_noise", () => {
  const run = (frames: [number, boolean][]) => {
    const d = new BargeDetector();
    return frames.some(([level, speaking]) => d.feed(level, speaking));
  };
  const quiet = Array<[number, boolean]>(20).fill([0.005, false]);
  const bleed = Array<[number, boolean]>(40).fill([0.012, true]);
  const voice = (n: number) => Array<[number, boolean]>(n).fill([0.15, true]);
  expect({
    bleedOnly: run([...quiet, ...bleed]),
    shortSpike: run([...quiet, ...bleed, ...voice(3), ...bleed]),
    talkingOver: run([...quiet, ...bleed, ...voice(8)]),
    talkingWhileSilent: run([...quiet, ...Array<[number, boolean]>(20).fill([0.15, false])]),
  }).toEqual({ bleedOnly: false, shortSpike: false, talkingOver: true, talkingWhileSilent: false });
});

it("test_transition_cue_only_on_state_change", () => {
  const t = transitionCue;
  expect([
    t("APPLICATION_OPEN", "WAITING_FOR_USER_CONFIRMATION"), t("BROWSING", "AUTH_HANDOFF"),
    t("APPLICATION_OPEN", "MOCK_SUBMITTED"), t("APPLICATION_OPEN", "RECOVERING"),
    t("APPLICATION_OPEN", "VALIDATION_ERROR"), t("APPLICATION_OPEN", "STOPPED"),
    t("MOCK_SUBMITTED", "MOCK_SUBMITTED"), t("STOPPED", "STOPPED"),
    t("WAITING_FOR_USER_CONFIRMATION", "WAITING_FOR_USER_CONFIRMATION"),
    t("IDLE", "APPLICATION_OPEN"), t("APPLICATION_OPEN", "DONE"),
  ]).toEqual(["approve", "handoff", "success", "problem", "problem", "stopped", undefined, undefined, undefined, undefined, undefined]);
});

/** 20 ms 묶음: 조용한 바탕에 날카로운 짧은 소리(박수) 하나를 넣는다. */
function frame(rate: number, sharp: boolean) {
  const samples = new Float32Array(Math.round(rate * 0.02)).fill(0.001);
  if (sharp) for (let i = 0; i < 8; i++) samples[100 + i] = i % 2 === 0 ? 0.9 : -0.9;
  return samples;
}
function knock(rate: number) {
  // 낮은 소리: 봉우리는 크지만 값이 천천히 바뀐다(밝지 않다)
  return Float32Array.from({ length: Math.round(rate * 0.02) }, (_, i) => 0.9 * Math.sin((2 * Math.PI * 60 * i) / rate));
}

it("박수 두 번은 0.15~0.8초 사이일 때만 알린다", () => {
  const rate = 24000;
  const claps = (gapMs: number) => {
    const detect = createClapDetector(rate);
    const heard: boolean[] = [];
    for (let at = 0; at <= 1000 + gapMs; at += 20) heard.push(detect(frame(rate, at === 1000 || at === 1000 + gapMs), at));
    return heard.some(Boolean);
  };
  expect(claps(300)).toBe(true);
  expect(claps(100)).toBe(false);
  expect(claps(1000)).toBe(false);
});

it("낮은 두드림 소리는 박수로 보지 않는다", () => {
  const rate = 24000;
  const detect = createClapDetector(rate);
  const heard: boolean[] = [];
  for (let at = 0; at <= 1400; at += 20) heard.push(detect(at === 1000 || at === 1300 ? knock(rate) : frame(rate, false), at));
  expect(heard.some(Boolean)).toBe(false);
});

it("긴 안내는 문장으로 나누고 첫 조각은 짧게 둔다", () => {
  expect(splitForSpeech("첫 문장이에요. 둘째 문장이다. 셋째 문장이요. 넷째.")).toEqual(["첫 문장이에요.", "둘째 문장이다. 셋째 문장이요. 넷째."]);
  expect(splitForSpeech("你好。我们开始吧！好的")).toEqual(["你好。", "我们开始吧！ 好的"]);
  expect(splitForSpeech("  ")).toEqual([]);
});

it("진행 안내는 시작 15초 뒤, 새 단계만, 조용할 때만 말한다", () => {
  vi.useFakeTimers();
  progressVoice.seen = 0;
  progressVoice.start();
  const report = (seq: number, latest = "복지로를 여는 중이에요.") => ({ running: true, spoken: true, seq, latest });
  expect(progressVoice.pick(report(1), false)).toBeUndefined();
  vi.advanceTimersByTime(15_000);
  expect(progressVoice.pick(report(1), true)).toBeUndefined();
  expect(progressVoice.pick({ ...report(1), spoken: false }, false)).toBeUndefined();
  expect(progressVoice.pick(report(1), false)).toBe("복지로를 여는 중이에요.");
  vi.advanceTimersByTime(15_000);
  expect(progressVoice.pick(report(1), false)).toBeUndefined();
  expect(progressVoice.pick(report(2, "검색 결과를 읽는 중이에요."), false)).toBe("검색 결과를 읽는 중이에요.");
});

function microphone(level: () => number) {
  const stop = vi.fn();
  const track = { stop, onended: null, onmute: null, enabled: true, label: "내장 마이크", readyState: "live" };
  return { stop, stream: { getTracks: () => [track], getAudioTracks: () => [track] }, level };
}

/** 마이크 워크릿 대신: 소리 크기는 analyser가, 40 ms 묶음은 onFrame으로 직접 넣는다. */
async function voiceLoop(level: () => number) {
  const mic = microphone(level);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => Promise.resolve(mic.stream) } });
  const ports: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (data: unknown) => void; close: () => void }[] = [];
  vi.stubGlobal("AudioContext", class {
    state = "running";
    audioWorklet = { addModule: () => Promise.resolve() };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() { return { fftSize: 0, getFloatTimeDomainData: (data: Float32Array) => data.fill(level()) }; }
  });
  vi.stubGlobal("AudioWorkletNode", class {
    port = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
    constructor() { ports.push(this.port); }
    disconnect() {}
  });
  const { VoiceLoop } = await import("../../web/src/mic.ts");
  const sent: ArrayBuffer[][] = [];
  const loop = new VoiceLoop(() => {
    const frames: ArrayBuffer[] = [];
    sent.push(frames);
    return { append: (f: ArrayBuffer) => frames.push(f), commit: () => Promise.resolve("receipt"), cancel: vi.fn() };
  });
  const start = loop.start();
  await vi.advanceTimersByTimeAsync(450);
  await start;
  const feed = (n: number) => { for (let i = 0; i < n; i++) ports[0]?.onmessage?.({ data: new ArrayBuffer(4) }); };
  return { loop, sent, feed, mic };
}

it("말이 시작되기 전 소리를 앞에 붙여 보내고, 조용해지면 끝낸다", async () => {
  vi.useFakeTimers();
  let level = 0;
  const { loop, sent, feed } = await voiceLoop(() => level);
  const heard = vi.fn();
  const utterance = loop.listenOnce(heard);
  feed(3);
  level = 0.5;
  await vi.advanceTimersByTimeAsync(250);
  expect(heard).toHaveBeenCalledOnce();
  expect(sent[0]).toHaveLength(3);
  feed(2);
  level = 0;
  await vi.advanceTimersByTimeAsync(1600);
  expect(await utterance).not.toBeNull();
  expect(sent[0]).toHaveLength(5);
  loop.stop();
});

it("청음이 말하는 동안 들어온 소리는 앞 소리로 모으지 않는다", async () => {
  vi.useFakeTimers();
  let level = 0;
  const { loop, sent, feed } = await voiceLoop(() => level);
  let speaking = true;
  loop.ignore = () => speaking;
  const utterance = loop.listenOnce();
  feed(4);
  level = 0.5;
  await vi.advanceTimersByTimeAsync(400);
  expect(sent).toHaveLength(0);
  speaking = false;
  await vi.advanceTimersByTimeAsync(250);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveLength(0);
  expect(loop.endUtterance()).toBe(true);
  expect(await utterance).not.toBeNull();
  loop.stop();
});

it("끼어들기로 들은 소리부터 다음 발화를 이어 보낸다", async () => {
  vi.useFakeTimers();
  let level = 0;
  const { loop, sent, feed } = await voiceLoop(() => level);
  const barged = vi.fn();
  const stop = loop.watchBargeIn(barged);
  feed(2);
  level = 0.5;
  await vi.advanceTimersByTimeAsync(350);
  expect(barged).toHaveBeenCalledOnce();
  stop();
  const next = loop.listenAfterBarge(2000);
  expect(sent[0]).toHaveLength(2);
  expect(loop.endUtterance()).toBe(true);
  expect(await next).not.toBeNull();
  loop.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("권한을 기다리는 중 멈추면 늦게 열린 마이크를 닫는다", async () => {
  let open: (stream: unknown) => void = () => {};
  const mic = microphone(() => 0);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise(resolve => { open = resolve; }) } });
  const { VoiceLoop } = await import("../../web/src/mic.ts");
  const loop = new VoiceLoop(() => ({ append: vi.fn(), commit: () => Promise.resolve(""), cancel: vi.fn() }));
  const start = loop.start();
  loop.stop();
  open(mic.stream);
  await expect(start).rejects.toThrow("stopped");
  expect(mic.stop).toHaveBeenCalledOnce();
});

it("마이크 목록에서 내장 마이크를 먼저, 휴대폰 마이크는 나중에 고른다", async () => {
  const { preferredMicrophone } = await import("../../web/src/mic.ts");
  expect(preferredMicrophone([{ id: "a", label: "iPhone 마이크" }, { id: "b", label: "MacBook Pro 마이크" }])).toBe("b");
  expect(preferredMicrophone([{ id: "a", label: "iPhone 마이크" }, { id: "c", label: "USB Audio" }])).toBe("c");
  expect(preferredMicrophone([{ id: "a", label: "iPhone 마이크" }])).toBe("a");
  expect(preferredMicrophone([])).toBeUndefined();
});
