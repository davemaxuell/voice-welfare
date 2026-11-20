// 첫 실행 설정. 키를 넣기 전(1단계)은 녹음해 둔 문장(setup-audio)을 틀고, 키가 된 뒤(2단계)는 청음 목소리로 말한다.
// 동의 전이라 마이크는 쓰지 않는다. 대답은 숫자·Enter·Esc·스페이스 키와 버튼으로만 받는다.
// 이 모듈은 단계와 키만 안다. 그리기는 FirstRun.tsx, 소리·서버는 deps가 맡는다.
import { LANGS, type Lang } from "../../src/core/turn.ts";
import type { Settings, SettingsInput } from "./api.ts";
import { TEXT } from "./first-run-text.ts";

const SPEEDS = [0.85, 1, 1.35, 1.6];
// 단계가 바뀐 직후의 키는 받지 않는다(같은 키를 두 번 눌러 다음 단계까지 답하지 않게)
export const SETTLE_MS = 250;

export type TextKey = keyof typeof TEXT.ko;
const TABLE: Readonly<Partial<Record<string, Readonly<Partial<Record<TextKey, string>>>>>> = TEXT;
/** setup-audio/manifest.json: 녹음 문장 이름 → 언어 → 화면 글 */
export type Manifest = Readonly<Partial<Record<string, Readonly<Partial<Record<string, string>>>>>>;

export interface FirstRunDeps {
  desktop?: { showSetup?(): void; setAutoStart?(on: boolean): void } | undefined;
  speak(text: string, lang: string, rate: number): Promise<unknown>;
  stopSpeaking(): void;
  onSaved(): Promise<unknown>;
  onConsentReady(): Promise<void>;
  loadManifest(): Promise<Manifest>;
  /** 녹음 파일 하나를 튼다. 끝나거나 실패하거나 멈추면 끝난다. */
  playClip(src: string): Promise<void>;
  pauseClip(): void;
  settings(): Promise<Partial<Settings>>;
  checkKey(key: string): Promise<string>;
  saveSettings(values: SettingsInput): Promise<unknown>;
  saveGuardian(contact: { name: string; phone: string }): Promise<unknown>;
  setTimer(fn: () => void, ms: number): void;
}

export type StepName = "language" | "who" | "key" | "pc" | "browser" | "autostart" | "guardian" | "handover" | "sound" | "speed";
type Act = () => void;
interface StepDef {
  title: string;
  text: string;
  clips?: string[];
  speak?: boolean;
  /** 키와 할 일. 순서대로 선택지 단추가 된다(labels와 같은 순서). */
  keys?: [string, Act][];
  labels?: string[];
  input?: "key";
  ready?: boolean;
  extra?: "guardian" | "speed";
}

export interface FirstRunChoice { label: string; kbd: string; act: Act }
export interface FirstRunView {
  open: boolean;
  dialogLang: string;
  step: StepName | null;
  /** 단계를 새로 그릴 때마다 늘어난다(초점과 화면 다시 만들기). */
  shown: number;
  title: string;
  text: string;
  keyForm?: { label: string; next: string; help?: { link: string; limit: string } };
  choices: FirstRunChoice[];
  ready?: FirstRunChoice;
  guardian?: { name: string; phone: string; save: string; skip: string };
  speed?: string;
  soundHelp?: string;
  back?: string;
  live: { text: string; seq: number };
  focus: { target: "step" | "key" | "guardian-name"; seq: number };
}

export function createFirstRun(deps: FirstRunDeps) {
  const state = {
    lang: "ko", helper: false, key: "", deviceUse: "personal" as "personal" | "shared", browser: "separate" as "separate" | "chrome",
    speed: 1.35, prefs: {} as Partial<Settings>,
  };
  let manifest: Manifest | null = null;
  let current: StepName | null = null;
  let history: (StepName | null)[] = [];
  let settling = false;
  let busy = false;
  let replays = 0;
  let open = false;
  let dialogLang = "ko";
  let shown = 0;
  let soundHelp = false;
  let live = { text: "", seq: 0 };
  let focus: FirstRunView["focus"] = { target: "step", seq: 0 };
  const listeners = new Set<() => void>();
  let view: FirstRunView = { open: false, dialogLang, step: null, shown, title: "", text: "", choices: [], live, focus };

  const t = (k: TextKey) => TABLE[state.lang]?.[k] ?? TEXT.ko[k];
  const clip = (id: string) => manifest?.[id]?.[id.startsWith("lang-") ? id.slice(5) : state.lang] ?? "";

  // ---------------------------------------------------------- 소리
  let clipToken = 0;
  function stopSound() {
    clipToken++;
    deps.pauseClip();
    deps.stopSpeaking();
  }
  async function playClips(ids: string[]) {
    stopSound();
    const token = clipToken;
    for (const id of ids) {
      if (token !== clipToken) return;
      await deps.playClip(`/setup-audio/${id.startsWith("lang-") ? id.slice(5) : state.lang}/${id}.mp3`);
    }
  }
  function say(text: string) {
    stopSound();
    return deps.speak(text, state.lang, state.speed).catch(() => undefined);
  }
  function announce(text: string) {
    live = { text, seq: live.seq + 1 };
    publish();
  }
  function focusOn(target: FirstRunView["focus"]["target"]) {
    focus = { target, seq: focus.seq + 1 };
    publish();
  }

  // 단계마다: 제목, 화면 글(녹음 문장과 같음), 틀 소리, 키 → 할 일
  const STEPS: Record<StepName, () => StepDef> = {
    language: () => ({
      title: TEXT.ko.language + " · Language",
      text: LANGS.map((l) => clip(`lang-${l}`)).join(" · "),
      clips: LANGS.map((l) => `lang-${l}`),
      keys: LANGS.map((l: Lang, i): [string, Act] => [String(i + 1), () => { state.lang = l; go("who"); }]),
      labels: LANGS.map((l) => clip(`lang-${l}`)),
    }),
    who: () => ({
      title: t("who"), text: clip("who"), clips: ["who"],
      keys: [["1", () => { state.helper = false; go("key"); }], ["2", () => { state.helper = true; go("key"); }]],
      labels: [t("self"), t("helper")],
    }),
    key: () => ({
      title: t("key"),
      text: [state.helper ? t("keyHelper") : clip("key-alone"), state.prefs.hasKey === true ? t("keyKeep") : ""].filter(part => part.length > 0).join(" "),
      clips: state.helper ? [] : ["key-alone"],
      input: "key",
    }),
    pc: () => ({
      title: t("pc"), text: clip("pc"), clips: ["pc"],
      keys: [["1", () => void afterPc("personal")], ["2", () => void afterPc("shared")]],
      labels: [t("personal"), t("shared")],
    }),
    browser: () => ({
      title: t("browser"), text: `${t("browserSay")} ${t("browserLater")}`,
      keys: [["1", () => { state.browser = "chrome"; void helperNext("browser"); }], ["2", () => { state.browser = "separate"; void helperNext("browser"); }]],
      labels: [t("chrome"), t("separate")],
    }),
    autostart: () => ({
      title: t("autostart"), text: t("autostartSay"),
      keys: [["1", () => { deps.desktop?.setAutoStart?.(true); void helperNext("autostart"); }], ["2", () => { deps.desktop?.setAutoStart?.(false); void helperNext("autostart"); }]],
      labels: [t("yes"), t("no")],
    }),
    guardian: () => ({ title: t("guardian"), text: t("guardianSay"), extra: "guardian" }),
    handover: () => ({
      title: t("handover"), text: clip("handover"), clips: ["handover"],
      keys: [["Enter", () => go("sound")]], labels: [], ready: true,
    }),
    // 2단계: 키가 됐으니 청음 목소리로 말한다. 아직 동의 전이라 마이크는 쓰지 않는다.
    sound: () => ({
      title: t("sound"), text: t("soundSay"), speak: true,
      keys: [["Enter", () => go("speed")], [" ", () => replaySound()]],
      labels: [t("heard"), t("replay")],
    }),
    speed: () => ({
      title: t("speed"), text: t("speedSay"), speak: true,
      keys: [["1", () => setSpeed(-1)], ["2", () => void finishStage2()], ["3", () => setSpeed(1)]],
      labels: [t("slower"), t("keep"), t("faster")],
      extra: "speed",
    }),
  };

  const choiceOf = (label: string, key: string, act: Act): FirstRunChoice => ({ label, kbd: key === " " ? "Space" : key, act: () => answer(act) });

  function publish() {
    const def = current === null ? undefined : STEPS[current]();
    view = {
      open, dialogLang, step: current, shown, title: def?.title ?? "", text: def?.text ?? "", live, focus,
      ...(def?.input === "key" ? { keyForm: {
        label: t("keyLabel"), next: t("next"),
        ...(state.helper ? { help: { link: t("keyHelp"), limit: t("keyLimit") } } : {}),
      } } : {}),
      choices: def?.labels !== undefined && def.labels.length > 0
        ? def.labels.flatMap((label, i) => {
          const entry = def.keys?.[i];
          return entry === undefined ? [] : [choiceOf(label, entry[0], entry[1])];
        }) : [],
      ...(def?.ready === true && def.keys?.[0] !== undefined ? { ready: choiceOf(t("ready"), "Enter", def.keys[0][1]) } : {}),
      ...(def?.extra === "guardian" ? { guardian: { name: t("guardianName"), phone: t("guardianPhone"), save: t("save"), skip: t("skip") } } : {}),
      ...(def?.extra === "speed" ? { speed: `${state.speed}×` } : {}),
      ...(soundHelp ? { soundHelp: t("soundHelp") } : {}),
      ...(history.length > 0 ? { back: t("back") } : {}),
    };
    for (const listener of listeners) listener();
  }

  function show(step: StepName | null) {
    current = step;
    if (step === null) { publish(); return; }
    const def = STEPS[step]();
    shown++;
    soundHelp = false;
    settling = true;
    deps.setTimer(() => { settling = false; }, SETTLE_MS);
    focus = { target: def.input === "key" ? "key" : def.extra === "guardian" ? "guardian-name" : "step", seq: focus.seq + 1 };
    announce(def.text);
    if (def.clips !== undefined && def.clips.length > 0) void playClips(def.clips);
    else if (def.speak === true) void say(def.text);
  }

  function go(step: StepName) {
    history.push(current);
    show(step);
  }

  function back() {
    if (busy || history.length === 0) return;
    show(history.pop() ?? null);
  }

  function answer(act: Act) {
    if (settling || busy) return;
    stopSound();
    act();
  }

  async function submitKey(value: string) {
    if (settling || busy) return;
    const key = value.trim();
    // '설정 다시 해줘': 저장된 키가 있으면 비워 두고 넘어가 그 키를 그대로 쓴다
    if (key.length === 0 && state.prefs.hasKey === true) { go("pc"); return; }
    if (key.length === 0) { announce(t("keyEmpty")); return; }
    busy = true;
    void playClips(["key-checking"]);
    announce(clip("key-checking"));
    let result: string;
    try {
      result = await deps.checkKey(key);
    } catch (e) {
      result = typeof e === "object" && e !== null && "code" in e && e.code === "INVALID_SETTINGS" ? "invalid" : "network";
    }
    busy = false;
    if (result === "ok") {
      state.key = key;
      go("pc");
      return;
    }
    void playClips([`key-${result}`]);
    announce(clip(`key-${result}`));
    focusOn("key");
  }

  async function afterPc(deviceUse: "personal" | "shared") {
    state.deviceUse = deviceUse;
    if (deviceUse !== "personal") state.browser = "separate";
    if (!state.helper) {
      // 혼자 설정하면 브라우저·자동 실행·보호자는 묻지 않는다(따로 쓰는 브라우저, 자동 실행 안 함). 나중에 설정에서 바꾼다.
      if (await save()) go("sound");
      return;
    }
    void helperNext("pc");
  }

  // 도와주는 분의 순서: 키 → 이 PC → 브라우저(개인 PC) → 자동 실행(데스크톱) → 저장 → 보호자(개인 PC) → 넘기기
  async function helperNext(after: "pc" | "browser" | "autostart") {
    const personal = state.deviceUse === "personal";
    if (after === "pc" && personal) { go("browser"); return; }
    if ((after === "pc" || after === "browser") && deps.desktop?.setAutoStart !== undefined) { go("autostart"); return; }
    if (!(await save())) return;
    go(personal ? "guardian" : "handover");
  }

  async function submitGuardian(name: string, phone: string) {
    if (settling || busy) return;
    busy = true;
    try {
      await deps.saveGuardian({ name, phone });
      busy = false;
      go("handover");
    } catch {
      busy = false;
      announce(t("guardianError"));
      focusOn("guardian-name");
    }
  }

  // 소리 확인: 스페이스로 다시 듣기. 세 번째부터는 스피커를 확인하라는 안내를 화면에 남긴다.
  function replaySound() {
    replays++;
    if (replays >= 3 && !soundHelp) {
      soundHelp = true;
      announce(t("soundHelp"));
    }
    void say(t("soundSay"));
  }

  function setSpeed(dir: number) {
    const near = SPEEDS.reduce((best, s, k) => (Math.abs(s - state.speed) < Math.abs((SPEEDS[best] ?? 0) - state.speed) ? k : best), 0);
    state.speed = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, near + dir))] ?? state.speed;
    announce(`${t("speed")} ${state.speed}×`);
    void say(t("speedSay"));
  }

  async function finishStage2() {
    if (await save()) await deps.onConsentReady();
  }

  async function save() {
    busy = true;
    try {
      await deps.saveSettings({
        apiKey: state.key, language: langOf(state.lang), region: state.prefs.region ?? "", speed: state.speed,
        deviceUse: state.deviceUse, browser: state.browser,
        rememberService: state.deviceUse === "personal" && state.prefs.rememberService === true,
      });
      state.key = "";
      await deps.onSaved();
      return true;
    } catch (e) {
      announce(`${t("saveError")} ${e instanceof Error ? e.message : ""}`.trim());
      return false;
    } finally {
      busy = false;
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => view,
    get open() { return open; },
    /** 초점이 대화 상자 밖(body)에 있어도 키를 받는다. 처리했으면 true(기본 동작을 막는다). */
    key(key: string, typing: boolean) {
      if (!open || current === null) return false;
      if (key === "Escape") {
        if (!settling) back();
        return true;
      }
      if (typing) return false;
      const act = STEPS[current]().keys?.find(([k]) => k === key)?.[1];
      if (act === undefined) return false;
      answer(act);
      return true;
    },
    back,
    submitKey,
    submitGuardian,
    skipGuardian: () => answer(() => go("handover")),
    /** stage 1 = 언어부터, 2 = 소리 확인부터(1단계를 저장한 뒤 앱을 닫았다 연 경우) */
    async start(stage: 1 | 2 = 1) {
      manifest ??= await deps.loadManifest().catch(() => ({}));
      try {
        state.prefs = await deps.settings();
      } catch {
        state.prefs = {};
      }
      state.lang = state.prefs.language ?? "ko";
      state.speed = state.prefs.speed !== undefined && state.prefs.speed !== 0 && Number.isFinite(state.prefs.speed) ? state.prefs.speed : 1.35;
      state.deviceUse = state.prefs.deviceUse === "shared" ? "shared" : "personal";
      state.browser = state.prefs.browser ?? "separate";
      history = [];
      replays = 0;
      deps.desktop?.showSetup?.();
      open = true;
      dialogLang = state.lang;
      show(stage === 2 ? "sound" : "language");
    },
    finish() {
      stopSound();
      open = false;
      show(null);
    },
  };
}
export type FirstRun = ReturnType<typeof createFirstRun>;

function langOf(lang: string): Lang {
  return LANGS.find(l => l === lang) ?? "ko";
}
