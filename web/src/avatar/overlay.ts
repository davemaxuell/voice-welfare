// 아바타 창: 대화 창이 보낸 표시 상태를 그리고, 누른 버튼을 이름으로만 돌려보낸다(세션·마이크·재생은 대화 창이 맡는다).
// 데스크톱 앱의 시험(apps/desktop/test)이 이 창의 id로 확인하므로 React 없이 이 문서의 요소를 그대로 고친다.
import { z } from "zod";
import { timing } from "../perf.ts";
import type { Character } from "./character.ts";
import "./overlay.css";

const ChoiceSchema = z.object({ key: z.string(), label: z.string(), open: z.string().optional() });
const SnapshotSchema = z.object({
  contrast: z.boolean().optional(), connected: z.boolean().optional(), instance: z.string().optional(), revision: z.number().optional(),
  mode: z.string().optional(), capture: z.string().default("off"), speaking: z.boolean().default(false), busy: z.boolean().default(false),
  sleeping: z.boolean().optional(), introPose: z.string().nullish(), resting: z.boolean().optional(), lang: z.string().optional(),
  state: z.string().optional(), reading: z.boolean().optional(), status: z.string().optional(),
  message: z.object({ id: z.string(), text: z.string() }).nullish(), prompt: z.string().nullish(), site: z.string().nullish(),
  choiceSetId: z.string().nullish(), choices: z.array(ChoiceSchema).default([]), pending: z.boolean().optional(),
});
type Snap = z.infer<typeof SnapshotSchema>;
const PrefsSchema = z.object({ corner: z.string().optional(), still: z.boolean().optional(), maxWidth: z.number().optional(), maxHeight: z.number().optional() });
type Prefs = z.infer<typeof PrefsSchema>;
const VisibilitySchema = z.object({ visible: z.boolean(), id: z.unknown(), animate: z.boolean().optional() });

const maybeBridge = window.cheongeumOverlay;
if (maybeBridge === undefined) throw new Error("아바타 창 연결이 없습니다.");
const bridge = maybeBridge;
let loaded = timing?.mark("overlay-loaded");

function element<T extends Element>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`아바타 창에 #${id}가 없습니다.`);
  return el;
}
const $ = (id: string) => element(id, HTMLElement);
const button = (id: string) => element(id, HTMLButtonElement);

const OFFLINE: Snap = { connected: false, capture: "off", speaking: false, busy: false, choices: [], choiceSetId: null };
let snap: Snap = OFFLINE;
let order: { instance: string | undefined; revision: number } = { instance: undefined, revision: -1 };
let shownSet: string | null | undefined = null;
let receivedSnapshot = false;
let bubble: { kind: "choices" | "status" | "message"; key: string } | null = null;
let messageInstance: string | undefined;
const seenMessages = new Set<string>();
let readTimer: ReturnType<typeof setTimeout> | undefined;
let readUntil = 0;
let readingTime = 0;
let lang: string | undefined;
type ChromeKey = "talk" | "stop" | "hide" | "avatar" | "micOn" | "micOff" | "on" | "off" | "site" | "offline" | "title" | "connecting" | "hideTitle";
const chromeText = {
  ko: { connecting: "청음과 연결하는 중이에요.", hideTitle: "도우미 숨기기", talk: "말하기", stop: "멈춰", hide: "숨기기", avatar: "청음 대화 열기", micOn: "마이크 켜짐", micOff: "마이크 꺼짐", on: "켜짐", off: "꺼짐", site: "대상", offline: "대화 창과 연결이 끊겼어요. 저를 누르면 대화 창을 열어요.", title: "청음 도우미" },
  en: { connecting: "Connecting to Cheongeum.", hideTitle: "Hide assistant", talk: "Talk", stop: "Stop", hide: "Hide", avatar: "Open Cheongeum chat", micOn: "Mic on", micOff: "Mic off", on: "On", off: "Off", site: "Site", offline: "The chat is disconnected. Select Cheongeum to open it.", title: "Cheongeum assistant" },
  zh: { connecting: "正在连接青音。", hideTitle: "隐藏助手", talk: "说话", stop: "停止", hide: "隐藏", avatar: "打开青音对话", micOn: "麦克风已开", micOff: "麦克风已关", on: "已开", off: "已关", site: "网站", offline: "对话连接已断开。点击青音可打开对话。", title: "青音助手" },
  ja: { connecting: "チョンウムに接続しています。", hideTitle: "アシスタントを隠す", talk: "話す", stop: "停止", hide: "隠す", avatar: "チョンウムとの会話を開く", micOn: "マイクオン", micOff: "マイクオフ", on: "オン", off: "オフ", site: "対象", offline: "会話画面との接続が切れました。チョンウムを押すと会話画面が開きます。", title: "チョンウムアシスタント" },
} satisfies Record<"ko" | "en" | "zh" | "ja", Record<ChromeKey, string>>;
const choiceIcons = new Map([
  ["consent-yes", "yes"], ["approve", "yes"], ["auth-done", "yes"],
  ["consent-no", "no"], ["reject", "no"], ["auth-cancel", "no"],
  ["review", "review"], ["read-main", "read"],
]);

// 캐릭터: 움직이지 않는 아바타 설정이나 운영체제의 '애니메이션 줄이기'면 정지 그림. 3D를 못 쓰면 역시 정지 그림.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let prefs: Prefs = { still: false };
let character: Character | null = null;

// 자세: 모드·세션 상태 → 동작 이름(graphics/animations/index.html의 대응표). 말하는 동안은 언제나 'speaking'.
const MODE_POSES: Readonly<Partial<Record<string, string>>> = { "auth-handoff": "auth-handoff", choice: "confirmation", consent: "confirmation", working: "thinking", listening: "listening", problem: "try-again" };
const STATE_POSES: Readonly<Partial<Record<string, string>>> = {
  AWAITING_CONSENT: "confirmation", LISTENING: "listening",
  TRANSCRIBED: "thinking", INTENT_DETECTED: "thinking", OBSERVING: "screen-reading",
  PLANNING: "thinking", POLICY_CHECK: "thinking", EXECUTING: "thinking", VERIFYING: "thinking",
  WAITING_FOR_USER_CONFIRMATION: "confirmation", NEEDS_CLARIFICATION: "confirmation", AWAITING_FIELD_VALUE: "confirmation",
  AUTH_HANDOFF: "auth-handoff", VALIDATION_ERROR: "try-again", RECOVERING: "try-again",
  PAUSED: "stopped", DONE: "complete", MOCK_SUBMITTED: "complete",
};
function poseFor(s: Snap) {
  if (s.introPose != null && s.introPose.length > 0) return s.introPose;
  if (s.connected !== true || s.mode === "starting" || s.mode === "ended") return "ready";
  if (s.mode === "working" && s.state === "OBSERVING") return "screen-reading";
  return MODE_POSES[s.mode ?? ""] ?? STATE_POSES[s.state ?? ""] ?? (s.reading === true ? "screen-reading" : "ready");
}
const hasIntro = (s: Snap) => s.introPose != null && s.introPose.length > 0;
// 정지 그림이 따로 없는 동작은 가까운 그림으로
const POSTER: Readonly<Partial<Record<string, string>>> = { welcome: "ready" };
const sleeping = (s: Snap) => s.connected === true && (s.sleeping ?? (s.mode === "ready" && s.state === "STOPPED"));

function updatePoster(s: Snap) {
  if (sleeping(s)) return;
  const pose = s.speaking && !hasIntro(s) ? "speaking" : poseFor(s);
  const src = `/avatar/poses/${POSTER[pose] ?? pose}.webp`;
  const still = element("still", HTMLImageElement);
  if (still.getAttribute("src") !== src) still.src = src;
}

function showSurface(available: boolean) {
  $("figure").dataset.renderer = available ? "webgl" : "image";
  if (!available) {
    updatePoster(snap);
    Object.assign($("figure").dataset, { pose: "still", clip: "" });
  }
  $("character").hidden = !available;
  $("still").hidden = available;
  $("sleeping-still").hidden = available;
  measureVisibleFigure();
}

function measureVisibleFigure() {
  if (loaded === undefined || $("overlay").inert || document.hidden) return;
  const start = loaded;
  requestAnimationFrame(() => {
    if (loaded !== start || $("overlay").inert || document.hidden) return;
    const figure = $("figure");
    const visible = { opacityProperty: true, visibilityProperty: true };
    if (figure.dataset.renderer === "webgl") {
      if (character?.hasDrawnFrame !== true || !$("character").checkVisibility(visible)) {
        measureVisibleFigure();
        return;
      }
    } else {
      const poster = element(figure.dataset.sleeping === "true" ? "sleeping-still" : "still", HTMLImageElement);
      if (!poster.complete || poster.naturalWidth === 0) return;
      if (!poster.checkVisibility(visible)) {
        if ($("overlay").hasAttribute("data-presenting")) measureVisibleFigure();
        return;
      }
    }
    loaded = undefined;
    requestAnimationFrame(() => timing?.measure(start, "figure-visible"));
  });
}

function animate(prev: Snap, next: Snap) {
  const asleep = sleeping(next);
  $("overlay").dataset.pose = asleep ? "sleeping" : next.speaking && !hasIntro(next) ? "speaking" : poseFor(next);
  $("figure").dataset.sleeping = String(asleep);
  if ($("figure").dataset.renderer === "image") updatePoster(next);
  if (character === null) return;
  // The spoken stop acknowledgement can finish while the character already sleeps.
  if (asleep) { character.pose("sleeping", { interrupt: true }); return; }
  // 청음 소개: 줄이 바뀔 때마다 그 줄의 동작을 처음부터
  if (next.introPose != null && next.introPose.length > 0) {
    if (next.introPose !== prev.introPose) character.pose(next.introPose, { interrupt: true });
    return;
  }
  if (next.speaking) { character.speak(); return; }
  const pose = poseFor(next);
  if (sleeping(prev) || character.waking) { character.pose(pose, { interrupt: true }); return; }
  if (next.connected === true && prev.capture !== "on" && next.capture === "on") { character.cue("welcome", pose); return; }
  if (prev.mode === "listening" && next.mode === "working") { character.cue("voice-captured", pose); return; }
  // 말이 그치면(끝나거나 끊기면) 입을 닫고 듣는 쪽으로 돌아선다
  if (prev.speaking) { character.cue("your-turn", pose); return; }
  character.pose(pose);
}
let figureSetup = 0;

async function setupFigure() {
  const setup = ++figureSetup;
  const still = prefs.still === true || reducedMotion.matches;
  if (still) {
    character?.dispose();
    character = null;
  } else if (character === null) {
    try {
      const { createCharacter } = await import("./character.ts");
      if (setup !== figureSetup) return;
      // 새 캔버스에 그린다(이전 렌더러가 쓰던 WebGL 문맥을 다시 쓰지 않게)
      const old = element("character", HTMLCanvasElement);
      const canvas = document.createElement("canvas");
      canvas.id = old.id;
      canvas.setAttribute("aria-hidden", "true");
      canvas.hidden = old.hidden;
      old.replaceWith(canvas);
      const made = await createCharacter(canvas, (pose, clip) => {
        if (setup === figureSetup && (character === null || character.surfaceAvailable)) {
          Object.assign($("figure").dataset, { pose, clip });
          queueGeometry();
        }
      }, (available) => {
        if (setup === figureSetup) showSurface(available);
      });
      if (setup !== figureSetup) { made?.dispose(); return; }
      character = made;
    } catch {
      if (setup !== figureSetup) return;
      character = null;
    }
  }
  if (setup !== figureSetup) return;
  showSurface(character?.surfaceAvailable === true);
  animate(snap, snap);
}

function accept(raw: unknown): Snap | null {
  const parsed = SnapshotSchema.safeParse(raw);
  const next = parsed.success ? parsed.data : undefined;
  if (next === undefined || next.connected === false) {
    order = { instance: undefined, revision: -1 };
    return OFFLINE;
  }
  if (next.instance === order.instance && (next.revision ?? 0) <= order.revision) return null;
  order = { instance: next.instance, revision: next.revision ?? 0 };
  return next;
}

function render() {
  const live = snap.connected === true;
  const root = $("overlay");
  const active = document.activeElement;
  const focused = document.hasFocus() && active instanceof HTMLElement && root.contains(active) ? active : null;
  root.dataset.mode = live ? snap.mode ?? "" : "offline";
  root.dataset.speaking = String(snap.speaking);
  const resting = snap.resting === true;
  root.classList.toggle("resting", resting);
  root.classList.toggle("stopped", sleeping(snap));
  const language = (snap.lang !== undefined && snap.lang.length > 0 ? snap.lang : lang ?? "ko").toLowerCase().split("-")[0] ?? "ko";
  const locale = language === "en" || language === "zh" || language === "ja" ? language : "ko";
  const copy = chromeText[locale];
  if (lang !== language) {
    lang = language;
    document.documentElement.lang = locale;
    document.title = copy.title;
    for (const id of ["talk", "stop", "hide", "avatar"] as const) {
      $(id).setAttribute("aria-label", copy[id]);
      $(id).title = id === "hide" ? copy.hideTitle : copy[id];
    }
  }
  $("mic").dataset.capture = snap.capture;
  const micLabel = snap.capture === "on" ? copy.micOn : copy.micOff;
  setText($("mic-text"), micLabel);
  setText($("mic-short"), snap.capture === "on" ? copy.on : copy.off);
  $("mic").title = micLabel;
  const status = live ? snap.status ?? "" : receivedSnapshot ? copy.offline : copy.connecting;
  // 동의는 카드의 '동의하고 음성 대화 시작'으로만(말하기 버튼이 동의가 되지 않게)
  button("talk").disabled = !live || ["ended", "starting", "consent", "auth-handoff"].includes(snap.mode ?? "");
  $("stop").hidden = !live || !(snap.busy || snap.speaking || snap.capture === "on");
  root.classList.toggle("has-stop", $("stop").hidden === false);
  renderCard(status, copy);
  setText($("status"), bubble !== null ? $("card-prompt").textContent ?? "" : status);
  if (focused !== null && (!focused.isConnected || (focused instanceof HTMLButtonElement && focused.disabled) || focused.closest("[hidden], [inert]") !== null)) focusFirst();
  queueGeometry();
}

function setText(el: HTMLElement, value: string | undefined) {
  if (el.textContent !== value) el.textContent = value ?? "";
}

function pauseReading() {
  if (readTimer === undefined) return;
  clearTimeout(readTimer);
  readTimer = undefined;
  readingTime = Math.max(0, readUntil - performance.now());
}

function resumeReading() {
  if (bubble?.kind !== "message" || $("overlay").inert || readTimer !== undefined || $("card").matches(":hover, :focus-within")) return;
  readUntil = performance.now() + readingTime;
  readTimer = setTimeout(closeBubble, readingTime);
}

// Reverse the same timeline so a new request starts at the exact frame on screen.
function revealMotion(el: Element, frames: Keyframe[], duration: number, initiallyOpen: boolean) {
  let open = initiallyOpen;
  let animation: Animation | undefined;
  let settled: (() => void) | undefined;
  function finish() {
    const previous = animation;
    const callback = settled;
    animation = settled = undefined;
    if (previous !== undefined) previous.onfinish = null;
    callback?.();
    previous?.cancel();
  }
  function set(next: boolean, shouldAnimate: boolean, callback?: () => void) {
    const changed = next !== open;
    open = next;
    settled = callback;
    if (!shouldAnimate || prefs.still === true || reducedMotion.matches || (!changed && animation === undefined)) { finish(); return; }
    if (!changed) return;
    if (animation === undefined) {
      const run = el.animate(frames, { duration, easing: "cubic-bezier(.22,.72,.26,1)", fill: "both" });
      animation = run;
      run.pause();
      run.currentTime = open ? 0 : duration;
      run.onfinish = () => {
        if (animation === run && run.playState === "finished") finish();
      };
    }
    const time = Number(animation.currentTime);
    if (open ? time >= duration : time <= 0) { finish(); return; }
    animation.playbackRate = open ? 1 : -1.25;
    animation.play();
  }
  return { set, finish };
}

const bubbleElement = document.querySelector(".bubble");
if (bubbleElement === null) throw new Error("아바타 창에 말풍선이 없습니다.");
const bubbleMotion = revealMotion(bubbleElement, [
  { opacity: 0, transform: "translateY(5px) scale(.94)" },
  { opacity: 1, transform: "none" },
], 210, false);

function closeBubble() {
  if (bubble === null) return;
  bubble = null;
  pauseReading();
  const card = $("card");
  card.inert = true;
  bubbleMotion.set(false, true, () => {
    card.hidden = true;
    shownSet = null;
    $("choices").replaceChildren();
    delete $("choices").dataset.set;
    reportSize();
  });
}

function bubbleBody() {
  const body = $("card").querySelector(".bubble-body");
  return body instanceof HTMLElement ? body : undefined;
}

function showBubble(kind: "choices" | "status" | "message", key: string, prompt: string) {
  const changed = bubble?.kind !== kind || bubble.key !== key;
  const card = $("card");
  card.dataset.kind = kind;
  card.hidden = false;
  card.inert = false;
  setText($("card-prompt"), prompt);
  if (!changed) return;
  pauseReading();
  bubble = { kind, key };
  const body = bubbleBody();
  if (body !== undefined) {
    body.tabIndex = kind === "choices" ? -1 : 0;
    body.scrollTop = 0;
  }
  shownSet = null;
  delete $("choices").dataset.set;
  $("choices").replaceChildren();
  $("card-site").hidden = true;
  bubbleMotion.set(true, true);
  if (kind === "message") {
    readingTime = Math.min(30000, Math.max(8000, prompt.length * 110));
    resumeReading();
  }
}

function renderCard(status: string, copy: Readonly<Record<ChromeKey, string>>) {
  const message = snap.message;
  if (snap.connected === true && snap.instance !== messageInstance) {
    seenMessages.clear();
    messageInstance = snap.instance;
  }
  const choices = snap.choices;
  if (choices.length > 0) {
    if (message != null) seenMessages.add(message.id);
    showBubble("choices", JSON.stringify([snap.instance, snap.choiceSetId, lang]), snap.prompt ?? "");
    if (shownSet !== snap.choiceSetId) {
      shownSet = snap.choiceSetId;
      const setId = snap.choiceSetId ?? "";
      $("choices").dataset.set = setId;
      $("choices").replaceChildren(...choices.map((choice) => choiceButton(setId, choice)));
    }
    $("card-site").hidden = snap.site == null || snap.site.length === 0;
    setText($("card-site"), snap.site != null && snap.site.length > 0 ? `${copy.site}: ${snap.site}` : "");
    for (const b of $("choices").querySelectorAll("button")) b.disabled = b.dataset.open === undefined && (snap.pending === true || snap.busy);
    return;
  }
  if ((receivedSnapshot && snap.connected !== true) || ["problem", "auth-handoff", "ended"].includes(snap.mode ?? "")) {
    if (message != null) seenMessages.add(message.id);
    showBubble("status", status, status);
    return;
  }
  if (message != null && message.id.length > 0 && message.text.length > 0 && !sleeping(snap)) {
    const key = JSON.stringify([snap.instance, message.id]);
    if ((bubble?.kind === "message" && bubble.key === key) || !seenMessages.has(message.id)) {
      seenMessages.add(message.id);
      showBubble("message", key, message.text);
      return;
    }
  }
  if (message != null) seenMessages.add(message.id);
  closeBubble();
}

function choiceButton(choiceSetId: string, choice: z.infer<typeof ChoiceSchema>) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = choice.label;
  const iconName = choiceIcons.get(choice.key);
  const template = element("choice-icon", HTMLTemplateElement).content.firstElementChild;
  if (iconName !== undefined && template !== null) {
    const icon = template.cloneNode(true);
    if (icon instanceof Element) {
      icon.querySelector("use")?.setAttribute("href", `#i-${iconName}`);
      b.prepend(icon);
    }
  }
  b.dataset.key = choice.key;
  if (choice.open !== undefined) b.dataset.open = choice.open;
  b.addEventListener("click", () => {
    if ($("card").inert || !b.isConnected || b.disabled || shownSet !== choiceSetId) return;
    if (choice.open !== undefined) { bridge.open(choice.open); return; }
    bridge.choose(choiceSetId, choice.key);
    bridge.release();
  });
  return b;
}

let lastGeometry: string | undefined;
let geometryFrame: number | undefined;
function queueGeometry() {
  if (geometryFrame !== undefined) return;
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = undefined;
    reportSize();
  });
}

function reportSize() {
  const root = $("overlay");
  const box = root.getBoundingClientRect();
  const regions: { x: number; y: number; width: number; height: number }[] = [];
  function include(el: HTMLElement | null, xPadding: number, yPadding: number) {
    if (el === null) return;
    // Electron also clips painting to these hit rectangles. Use layout coordinates
    // so the native shape stays large enough throughout a visual scale or slide.
    let left = 0;
    let top = 0;
    for (let node: Element | null = el; node instanceof HTMLElement && node !== root; node = node.offsetParent) {
      left += node.offsetLeft;
      top += node.offsetTop;
    }
    const x = Math.max(0, left - xPadding);
    const y = Math.max(0, top - yPadding);
    regions.push({
      x, y,
      width: Math.min(Math.ceil(box.width), left + el.offsetWidth + xPadding) - x,
      height: Math.min(Math.ceil(box.height), top + el.offsetHeight + yPadding) - y,
    });
  }
  include($("avatar"), 5, 6);
  const panel = document.querySelector(".panel");
  include(panel instanceof HTMLElement ? panel : null, 5, 6);
  if ($("card").hidden === false) include($("card"), 6, 11);
  const width = Math.ceil(box.width), height = Math.ceil(box.height);
  const signature = JSON.stringify([width, height, regions]);
  if (lastGeometry === signature) return;
  lastGeometry = signature;
  bridge.resize(width, height, regions);
}

function focusFirst() {
  if ($("overlay").inert) return;
  const choice = bubble?.kind === "choices" ? $("choices").querySelector("button:enabled") : null;
  const target = choice instanceof HTMLElement ? choice : (button("talk").disabled ? $("avatar") : $("talk"));
  target.focus({ preventScroll: true });
}

$("avatar").addEventListener("click", () => bridge.open());
$("talk").addEventListener("click", () => bridge.talk());
$("stop").addEventListener("click", () => bridge.stop());
$("hide").addEventListener("click", () => bridge.hide());
$("card").addEventListener("pointerenter", pauseReading);
$("card").addEventListener("pointerleave", resumeReading);
$("card").addEventListener("focusin", pauseReading);
$("card").addEventListener("focusout", () => queueMicrotask(resumeReading));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (bubble?.kind === "message") closeBubble();
    bridge.release();
  }
});

// The window stays hidden until the first native visibility command.
const overlay = $("overlay");
const widgetMotion = revealMotion(overlay, [
  { "--companion-reveal": "0" }, { "--companion-reveal": "1" },
], 235, bridge.onVisibility === undefined);

function finishMotion() {
  bubbleMotion.finish();
  widgetMotion.finish();
}

bridge.onSnapshot((next) => {
  const accepted = accept(next);
  if (accepted === null) return;
  receivedSnapshot = true;
  const prev = snap;
  snap = accepted;
  if (snap.contrast !== undefined) overlay.classList.toggle("high-contrast", snap.contrast);
  animate(prev, snap);
  render();
});
bridge.onPrefs((raw) => {
  const parsed = PrefsSchema.safeParse(raw);
  if (!parsed.success) return;
  const next = parsed.data;
  const root = $("overlay");
  root.dataset.corner = next.corner;
  root.dataset.still = String(next.still === true);
  if (next.maxWidth !== undefined && next.maxWidth > 0) root.style.setProperty("--available-width", `${next.maxWidth}px`);
  if (next.maxHeight !== undefined && next.maxHeight > 0) root.style.setProperty("--available-height", `${next.maxHeight}px`);
  const changed = next.still !== prefs.still || figureSetup === 0;
  prefs = next;
  if (prefs.still === true) finishMotion();
  if (changed) void setupFigure();
  else character?.refreshResolution();
  reportSize();
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) finishMotion();
  void setupFigure();
});

if (bridge.onVisibility !== undefined) {
  overlay.dataset.concealed = "";
  overlay.inert = true;
  bridge.onVisibility((raw) => {
    const parsed = VisibilitySchema.safeParse(raw);
    if (!parsed.success) return;
    const { visible, id, animate: shouldAnimate } = parsed.data;
    delete overlay.dataset.concealed;
    overlay.dataset.presenting = "";
    overlay.inert = !visible;
    if (visible) resumeReading();
    else pauseReading();
    widgetMotion.set(visible, shouldAnimate === true, () => {
      delete overlay.dataset.presenting;
      overlay.toggleAttribute("data-concealed", !visible);
      if (!visible) bridge.visibilityDone(id);
    });
    if (visible) {
      measureVisibleFigure();
      reportSize();
      bridge.visibilityDone(id);
    }
  });
}

bridge.onFocus(focusFirst);
if (timing !== undefined) {
  document.addEventListener("visibilitychange", measureVisibleFigure);
  $("figure").addEventListener("load", measureVisibleFigure, true);
}
const sizeObserver = new ResizeObserver(reportSize);
sizeObserver.observe(overlay);
sizeObserver.observe($("card"));
render();
bridge.ready();
