// WebRTC media belongs to GPT-Live. Only authenticated sideband events can start local work.
import { createHash, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { REASONING_EFFORT_OVERRIDE } from "../core/llm.ts";
import { STACK } from "../core/model_stack.ts";
import { casefold, hasText, splitWhitespace, strip } from "../core/text.ts";
import { PLANNER_EXCHANGES, type DialogueExchange } from "../orchestrator/planner_dialogue.ts";
import { isProgressQuestion, isStopUtterance } from "../understanding/rules.ts";
import { VoiceProviderError } from "../voice/errors.ts";
import { connectSocket, withDeadline, type SocketConnect, type UpstreamSocket } from "../voice/live.ts";
import type { SttProvider } from "../voice/stt.ts";
import type { TtsProvider } from "../voice/tts.ts";
import { speechPace, speechSpeed, VOICE_PROFILE, type SpeechProfile } from "../core/voice_profile.ts";
import { liveClosure } from "../voice/recovery.ts";
import { SocketDisconnected, refuseForeignOrigin, socketEvents, type AccessWriter, type ServerSocket, type VoiceErrorBody } from "./live_audio.ts";
import { RequestConflict, type Lease, type RequestLedger } from "./recovery.ts";
import { TURN_TEXT_LIMIT, type HeaderList } from "./request_policy.ts";

// 링크 답변은 GPT Live의 짧은 맞장구가 있어도 이 간격까지 한 발화로 본다.
export const PAUSE_SPLIT_MS = 3000;
// "다음 페이지 멈춰"는 멈춤이 아니다. 멈춤 확인은 "멈춰"만 떼어 내는 짧은 간격을 쓴다.
export const STOP_SPLIT_MS = 1200;
export const WAIT_FOR_TEXT_S = 3;
export const WAIT_WHILE_TALKING_S = 10;
export const QUIET_S = 0.7;
// 이미 쓴 말 바로 뒤에 온 넘김은 그 말을 한 번 더 넘긴 것이다.
export const ABSORBED_MS = 1200;
export const MAX_WAITING_TURNS = 12;
export const EFFORT_WAIT_S = 1.0;
export const EFFORT_QUESTION = "sol_effort";
export const TASK_DIFFICULTY: Readonly<Record<string, string>> = { low: "easy", medium: "medium", high: "hard" };
export const MISSED = "Sorry, I didn't catch that. Could you say it again?";
export const BUSY = "I'm still working on your earlier requests. Please wait for those answers first.";
export const ABSORBED = "This speech was handled together with the previous request.";
export const LIVE_ACKS: ReadonlySet<string> = new Set(["네", "예", "알겠습니다", "네알겠습니다", "예알겠습니다", "yes", "ok", "okay", "好的", "はい"]);
const ACK_PUNCTUATION = /[.,，。!！]/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export function effortChoice(event: Record<string, unknown>): string | undefined {
  const decision = event.decision;
  const answers = isRecord(decision) ? decision.answers : undefined;
  if (!Array.isArray(answers)) return undefined;
  for (const answer of answers) {
    if (isRecord(answer) && answer.type === "choice" && answer.name === EFFORT_QUESTION) {
      const effort = answer.choice;
      return typeof effort === "string" && Object.hasOwn(TASK_DIFFICULTY, effort) ? effort : undefined;
    }
  }
  return undefined;
}

/** Python format(speed, "g") for the speeds a user can choose. */
function formatG(value: number): string {
  return String(Number(value.toPrecision(6)));
}
/** urllib.parse.quote(text, safe=""). */
function quoteAll(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export interface EdgeSource { readonly baseUrl?: string | undefined; readonly apiKey?: string | undefined; readonly edgeModel?: string | undefined }
export interface OfferSession {
  readonly lang: string;
  readonly state: string;
  recentVoiceDialogue(): ReadonlyArray<{ readonly role: string; readonly text: string }>;
}
export interface LiveSessionProvider {
  offer(sdp: string, session: OfferSession, speed: number): Promise<readonly [string, string]>;
  attach(liveId: string): Promise<UpstreamSocket>;
}

// 모델별 위임 표현과 정책 제목: https://developers.openai.com/api/docs/guides/live-prompting
function liveInstructions(model: string, session: OfferSession, speed: number, voiceInstructions: string): string {
  const [delegate, replyDirectly] = model === "gpt-live-1"
    ? ["Generate <|SpawnThinking|>", "Do not generate <|SpawnThinking|>"]
    : ["Delegate to the backend", "Do not delegate"];

  return `You are Cheongeum (청음), the AI voice assistant in the Cheongeum desktop app, powered by OpenAI's ${model}.
Help people use Korean public services by listening. The app supports speech and typing in Korean, English, Chinese, and Japanese.
Use the selected reply language (${session.lang}) until the app changes it. Keep official Korean names when languages are mixed.
${voiceInstructions} Speak at about ${formatG(speed)} times normal speed. Use short, plain sentences and name each item so the listener can follow without seeing it.
Use polite conversational Korean. Acknowledge frustration briefly in your answer when it helps.
The app state at the start of this call is ${session.state}.

Backchannel policy:
Listen silently and give the caller time to finish, including pauses to remember a name, give a choice, or correct a selection.

Interruption policy:
When the caller interrupts, stop speaking immediately and listen through the end of their turn.
Respond to their latest request. If they ask to stop or change an app task, pass that request to the app before reporting its outcome.

Delegation policy:
The backend is the Cheongeum app. It can inspect the connected Chrome tab, read pages aloud, follow links, operate controls, and guide users through forms and practice applications.
It can look up public services and benefits, check official sources, work with documents and profiles, report progress, handle permissions, change the reply language and other settings, and read the full startup guide.

${delegate} once the caller finishes a turn that needs any of the following:
- Any app capability above, including questions about the current page or an item's position, requests to open or show a site, and politely phrased actions.
- A current or user-specific fact, official dates, schedules, eligibility, requirements, or a question that needs careful research or reasoning.
- A progress check, a question about what the app did, or a correction or cancellation of work in progress.
- An answer to an app question or proposal, including a selection, confirmation, or refusal. Each such reply needs a fresh handoff. Send natural assent in the caller's own words.
Pass the whole goal with its targets, conditions, exclusions, and latest corrections. Use earlier dialogue to resolve references and carry forward relevant constraints.
Assume callers may be using the service for the first time. When they describe a need or ask where to start, hand it to the app in their own words. The app identifies the services, compares official sources and finds a practical first step. Include any source the caller specified.
A site name or result position can identify a selection. Let the app resolve ambiguous targets and distinguish a lookup now from research to save for later.
Delegate the user's request to act in Chrome immediately after they finish speaking. The app alone checks permission for each action and decides when to ask for approval. Earlier dialogue or app state cannot authorize an action.
Users handle sign-in, identity verification, and final submission on official sites. Never ask for or repeat passwords or identity numbers.

${replyDirectly} for greetings, ordinary questions you can answer, general questions about app capabilities and how to use them, or a simple repeat of a still-current result you already relayed.
If the caller alone can resolve a choice that changes the outcome, ask one plain question and briefly explain why it matters. If the app can check an uncertain answer, hand it off. Otherwise say what is uncertain.

Make the handoff silently. While the app works, listen for the caller. Omit acknowledgments, waiting messages, and unsolicited progress updates.
When the caller asks for progress, relay the app's status answer once. Relay a final answer, a failure, or a question or approval the caller must answer as soon as the app provides it.
Report that a page opened or a task finished only after the app confirms it. Preserve names, dates, numbers, conditions, and caveats in the result.
Relay the app's verified guidance, including its recommended first step. End a completed answer there. When the app needs an answer from the caller, relay its question and choices. When the app reads its own response, stay silent and let it finish.
Hand off the caller's follow-up if it refers to a response the app read itself.`;
}

export class LiveProvider implements LiveSessionProvider {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly model: string;
  readonly voice: string;
  readonly instructions: string;
  readonly #fetch: typeof fetch;
  readonly #connect: SocketConnect;

  constructor(stt: EdgeSource, { fetch: fetcher = fetch, connect = connectSocket, profile }: { fetch?: typeof fetch; connect?: SocketConnect; profile?: SpeechProfile | undefined } = {}) {
    this.url = (stt.baseUrl ?? "").replace(/\/+$/u, "") + "/live/sessions";
    this.headers = { Authorization: `Bearer ${stt.apiKey ?? ""}` };
    this.model = stt.edgeModel ?? "";
    this.voice = profile?.voice ?? VOICE_PROFILE.voice;
    this.instructions = profile?.instructions ?? VOICE_PROFILE.instructions;
    this.#fetch = fetcher;
    this.#connect = connect;
  }

  config(session: OfferSession, speed: number): Record<string, unknown> {
    const config: Record<string, unknown> = {
      model: this.model,
      audio: { output: { voice: this.voice } },
      delegation: {
        type: "decisions",
        decisions: {
          model: STACK.utility,
          questions: [{
            type: "choice",
            name: EFFORT_QUESTION,
            instructions:
              "Rate the work needed to fulfill the latest delegated request. "
              + "Use earlier dialogue to resolve references and apply the user's current constraints. "
              + "Choose low for a simple action or a straightforward lookup. "
              + "Choose medium for bounded work with dependent steps, options to compare, or conditions to apply. "
              + "Choose high for many dependent navigation or data entry steps, open-ended investigation, substantial synthesis across sources, "
              + "or constraints that are hard to reconcile. Spoken length and the need for approval "
              + "do not determine effort. The application handles actions and permission.",
            choices: Object.keys(TASK_DIFFICULTY).map(effort => ({ value: effort })),
          }],
        },
      },
      store: false,
      instructions: liveInstructions(this.model, session, speed, this.instructions),
    };
    const history = session.recentVoiceDialogue();
    if (history.length > 0) {
      config.input = history.map(message => ({ type: "message", role: message.role, content: [{
        type: message.role === "user" ? "input_text" : "output_text", text: message.text,
      }] }));
    }
    return config;
  }

  async offer(sdp: string, session: OfferSession, speed: number): Promise<readonly [string, string]> {
    const config = this.config(session, speed);
    const payload = { session: config, transport: { type: "webrtc", sdp } };
    const signal = AbortSignal.timeout(15_000);
    const post = async (body: unknown) => await this.#fetch(this.url, {
      method: "POST", headers: { ...this.headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
      redirect: "manual", signal,
    });
    let result = await post(payload);
    if (result.status === 400 || result.status === 403) {
      // Some projects cannot use native Decisions. Keep voice available on a rejected offer.
      await result.arrayBuffer();
      result = await post({ ...payload, session: { ...config, delegation: { type: "client" } } });
    }
    if (!result.ok) throw await VoiceProviderError.fromResponse(result);
    const body: unknown = await result.json();
    const session_ = isRecord(body) && isRecord(body.session) ? body.session : undefined;
    const transport = isRecord(body) && isRecord(body.transport) ? body.transport : undefined;
    if (typeof session_?.id !== "string" || typeof transport?.sdp !== "string") throw new TypeError("live session reply");
    return [session_.id, transport.sdp];
  }

  async attach(liveId: string): Promise<UpstreamSocket> {
    const url = this.url.replace("https://", "wss://") + "/" + quoteAll(liveId) + "/attach";
    return await this.#connect(url, { headers: this.headers, openTimeoutMs: 10_000, closeTimeoutMs: 1000 });
  }
}

export type Clock = () => number;
export const loopClock: Clock = () => performance.now() / 1000;

export interface Fragment {
  readonly start: number; readonly end: number; readonly text: string; readonly approval: string;
  readonly linkOffer: string | undefined; readonly receivedAt: number; readonly deliveredTurn: number;
  readonly sequence: number;
}
export interface OutputFragment {
  readonly start: number; readonly end: number; readonly ackPart: string | undefined; readonly deliveredTurn: number;
  readonly text: string | undefined; readonly sequence: number;
}
export interface SpeechMatch { readonly first: Fragment; readonly end: number; readonly text: string; readonly receivedAt: number }

const FRAGMENT_LIMIT = 400, OUTPUT_LIMIT = 80;
interface TimedExchange { readonly sequence: number; readonly exchange: DialogueExchange }
interface LiveExchange { readonly sequence: number; readonly exchange?: DialogueExchange }
const byStartEnd = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start === b.start ? a.end - b.end : a.start - b.start;
const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** Match a delegation offset to one unconsumed stretch of user speech. */
export class Transcript {
  fragments: Fragment[] = [];
  droppedThrough = -1;
  through = -1;
  output: OutputFragment[] = [];
  #droppedOutputThrough = -1;
  readonly #appSpeech = new Set<string>();
  deliveredTurns = 0;
  sequence = 0;
  incompleteLinkEnd = -1;
  updated = 0;
  readonly #clock: Clock;

  constructor(clock: Clock = loopClock) { this.#clock = clock; }

  #speechDigest(text: string): string {
    return createHash("sha256").update(splitWhitespace(casefold(text)).join("")).digest("base64");
  }

  rememberAppSpeech(text: string): void {
    const digest = this.#speechDigest(text);
    this.#appSpeech.delete(digest);
    this.#appSpeech.add(digest);
    if (this.#appSpeech.size > OUTPUT_LIMIT) this.#appSpeech.delete(this.#appSpeech.values().next().value!);
  }

  add(event: Record<string, unknown>, approval: string, linkOffer?: string): void {
    const start = event.start_ms, end = event.end_ms, delta = event.delta;
    if (!isInteger(start) || !isInteger(end) || end < start || typeof delta !== "string") return;
    if (end <= this.through || delta === "") return;
    if (event.type === "session.output_transcript.delta") {
      if (this.output.some(o => o.start === start && o.end === end && o.text === delta)) return;
      const key = splitWhitespace(casefold(delta)).join("").replace(ACK_PUNCTUATION, "");
      const part = [...LIVE_ACKS].some(ack => ack.includes(key)) ? key : undefined;
      const text = delta.length <= 6400 && event.delegation_id == null ? delta : undefined;
      this.output.push({ start, end, text, ackPart: part, deliveredTurn: this.deliveredTurns, sequence: this.sequence });
      if (this.output.length > OUTPUT_LIMIT) this.#droppedOutputThrough = Math.max(this.#droppedOutputThrough, this.output.shift()!.end);
      return;
    }
    if (this.fragments.some(f => f.start === start && f.end === end && f.text === delta)) return;
    if (this.fragments.length === FRAGMENT_LIMIT) this.droppedThrough = Math.max(this.droppedThrough, this.fragments[0]?.end ?? -1);
    // Keep one character past the limit so the complete group is rejected if a suffix was omitted.
    this.updated = this.#clock();
    this.fragments.push({ start, end, text: Array.from(delta).slice(0, TURN_TEXT_LIMIT + 1).join(""), approval, linkOffer,
      receivedAt: this.updated, deliveredTurn: this.deliveredTurns, sequence: this.sequence });
    if (this.fragments.length > FRAGMENT_LIMIT) this.fragments.shift();
  }

  read(offset: number, { consume = false, pauseMs = PAUSE_SPLIT_MS } = {}): readonly [string, string] {
    const match = this.match(offset, { pauseMs });
    if (match === undefined) return ["", ""];
    if (consume) this.consume(match);
    return [match.text, match.first.approval];
  }

  consume(match: SpeechMatch, { incompleteLink = false } = {}): void {
    this.through = match.end;
    this.fragments = this.fragments.filter(fragment => fragment.end > this.through);
    this.incompleteLinkEnd = incompleteLink ? match.end : -1;
  }

  /** Recover independent Live replies completed before this caller began speaking. */
  exchangesBefore(first: Fragment): LiveExchange[] {
    const inputs = this.fragments.filter(f => f.start < first.start).sort(byStartEnd);
    const output = [...this.output].sort(byStartEnd);
    const exchanges: LiveExchange[] = [];
    let group: Fragment[] = [];
    for (const next of [...inputs, first]) {
      const start = group[0], tail = group.at(-1);
      if (start !== undefined && tail !== undefined) {
        const reply = output.filter(o => o.end > tail.start && o.start < next.start && o.end >= tail.end);
        if (reply.length > 0 || next.start - tail.end > PAUSE_SPLIT_MS || next.deliveredTurn !== tail.deliveredTurn) {
          // A missing prefix, interleaved delivery or interruption makes list positions unreliable.
          if (reply.length > 0 && start.start > Math.max(this.droppedThrough, this.#droppedOutputThrough)
            && group.every(f => f.deliveredTurn === start.deliveredTurn && f.sequence === start.sequence && Array.from(f.text).length <= TURN_TEXT_LIMIT)
            && reply.every(o => o.text !== undefined && o.start >= tail.end && o.end <= next.start
              && o.deliveredTurn === start.deliveredTurn && o.sequence === start.sequence)) {
            const user = strip(group.map(f => f.text).join("")), assistant = strip(reply.map(o => o.text).join(""));
            if (user !== "" && assistant !== "" && !this.#appSpeech.has(this.#speechDigest(assistant)) && !this.#appSpeech.has(this.#speechDigest(user))) {
              exchanges.push({ sequence: start.sequence, exchange: { user, assistant } });
            }
          } else if (reply.length > 0 || start.start <= this.#droppedOutputThrough) {
            exchanges.push({ sequence: start.sequence });
          }
          group = [];
        }
      }
      group.push(next);
    }
    return exchanges;
  }

  match(offset: number, { pauseMs = PAUSE_SPLIT_MS, boundFirst, delegated = false }: { pauseMs?: number; boundFirst?: Fragment | undefined; delegated?: boolean } = {}): SpeechMatch | undefined {
    // Deltas may lag delegation and arrive in uneven chunks. Do not attach a
    // later utterance to a delegation whose own transcript is missing.
    const groups: Fragment[][] = [];
    let boundGroup: Fragment[] | undefined;
    let interrupted = false;
    let fragments = [...this.fragments].sort(byStartEnd);
    if (delegated && this.incompleteLinkEnd >= 0) {
      let lostEnd = Math.max(this.incompleteLinkEnd, this.droppedThrough);
      const index = fragments.findIndex(fragment => {
        if (fragment.start - lostEnd > pauseMs) return true;
        lostEnd = Math.max(lostEnd, fragment.end);
        return false;
      });
      fragments = index < 0 ? [] : fragments.slice(index);
    }
    for (const fragment of fragments) {
      const group = groups.at(-1);
      const previous = group?.at(-1);
      let split = previous === undefined || fragment.start - previous.end > pauseMs;
      if (previous !== undefined && !split) {
        const output = this.output.filter(o => previous.end <= o.end && o.end < fragment.start);
        if (output.length > 0 && boundFirst !== undefined && group === boundGroup && output.every(o => o.deliveredTurn === boundFirst.deliveredTurn)) {
          const parts = [...output].sort(byStartEnd).map(o => o.ackPart);
          const acknowledgment = !parts.includes(undefined) && LIVE_ACKS.has(parts.filter(p => p !== undefined).join(""));
          interrupted ||= !acknowledgment || output.some(o => o.start < previous.end)
            || this.output.some(o => o.start < fragment.start && fragment.start <= o.end);
        } else {
          split = output.length > 0 || (delegated && !hasText(previous.linkOffer) && !hasText(previous.approval)
            && this.output.some(o => previous.end <= o.start && o.start < fragment.start && fragment.start <= o.end));
        }
      }
      if (split) groups.push([]);
      const last = groups.at(-1);
      last?.push(fragment);
      if (fragment === boundFirst) boundGroup = last;
    }
    const match = boundFirst !== undefined ? boundGroup : [...groups].reverse().find(group => {
      const head = group[0], tail = group.at(-1);
      return head !== undefined && tail !== undefined && head.start <= offset + 200 && tail.end >= offset - 3500
        && !this.output.some(o => offset <= o.end && o.end < head.start);
    });
    const head = match?.[0], tail = match?.at(-1);
    if (match === undefined || head === undefined || tail === undefined) return undefined;
    if (offset - tail.end > 800 && this.output.some(o => tail.end < o.end && o.end < offset)) return undefined;
    const start = head.start;
    const missingPrefix = this.droppedThrough >= 0 && start <= this.droppedThrough + pauseMs
      && !this.output.some(o => this.droppedThrough <= o.end && o.end < start);
    let text = match.map(fragment => fragment.text).join("");
    // Partial/truncated text is never used to authorize an action.
    if (interrupted || missingPrefix || Array.from(text).length > TURN_TEXT_LIMIT) text = "";
    return { first: boundFirst ?? head, end: Math.max(...match.map(f => f.end)), text: strip(text), receivedAt: Math.max(...match.map(f => f.receivedAt)) };
  }
}

export interface TurnResultLike { readonly state: string; readonly speech: string; readonly [key: string]: unknown }
export interface EdgeSession extends OfferSession {
  readonly personal?: { speech(): { rate: number } };
  readonly generation: number;
  readonly consentStatus: string;
  readonly dialogue: { readonly authWaiting: boolean; readonly confirmation?: { readonly actionId?: string } | null | undefined };
  readonly linkOfferId?: string | null | undefined;
  readonly plannerTurns?: readonly { readonly id: string; readonly exchange: DialogueExchange }[] | undefined;
  readonly plannerDialogueGeneration?: number | undefined;
  plannerDialogue?: ((live?: readonly DialogueExchange[], preceding?: readonly DialogueExchange[]) => DialogueExchange[]) | undefined;
  handleTurn(text: string, options: { approvalId: string; fromVoice: true; linkOfferId?: string; difficulty?: string; plannerDialogue?: readonly DialogueExchange[] }): Promise<TurnResultLike>;
}
/** The browser side: it can only close the call. */
export interface EdgeSocket {
  sendJson(value: unknown): Promise<void>;
  receive(): Promise<unknown>;
}
export interface Sideband extends AsyncIterable<string> { send(text: string): Promise<void> }

export interface EdgeTiming {
  waitForTextS: number; waitWhileTalkingS: number; quietS: number; maxWaitingTurns: number; effortWaitS: number;
}
export type Sleep = (seconds: number, signal: AbortSignal) => Promise<void>;
export const realSleep: Sleep = (seconds, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Stopped()); return; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, seconds * 1000);
  const onAbort = () => { clearTimeout(timer); reject(new Stopped()); };
  signal.addEventListener("abort", onAbort, { once: true });
});

/** The monitor ended: the stand-in for asyncio's cancellation of its other loops. */
export class Stopped extends Error {
  constructor() { super("monitor stopped"); }
}

class Queue<T> {
  readonly #items: T[] = [];
  readonly #waiting: Array<(item: T) => void> = [];
  readonly #limit: number;
  constructor(limit = Infinity) { this.#limit = limit; }
  get full(): boolean { return this.#items.length >= this.#limit; }
  put(item: T): void {
    const waiter = this.#waiting.shift();
    if (waiter === undefined) this.#items.push(item);
    else waiter(item);
  }
  get(signal: AbortSignal): Promise<T> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (signal.aborted) return Promise.reject(new Stopped());
    return new Promise((resolve, reject) => {
      const take = (value: T) => { signal.removeEventListener("abort", onAbort); resolve(value); };
      const onAbort = () => { this.#waiting.splice(this.#waiting.indexOf(take), 1); reject(new Stopped()); };
      this.#waiting.push(take);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

class Rating {
  done = false;
  value: string | undefined;
  readonly #settled: Promise<void>;
  #resolve = () => {};
  constructor() { this.#settled = new Promise(resolve => { this.#resolve = resolve; }); }
  set(value: string | undefined): void { this.value = value; this.done = true; this.#resolve(); }
  /** asyncio.wait_for cancels the future on timeout, so a late decision is ignored. */
  async wait(seconds: number, sleep: Sleep, signal: AbortSignal): Promise<string | undefined> {
    const timer = new AbortController();
    const both = AbortSignal.any([signal, timer.signal]);
    try {
      await Promise.race([this.#settled, sleep(seconds, both).catch(() => {})]);
    } finally {
      timer.abort();
    }
    if (signal.aborted) throw new Stopped();
    const value = this.done ? this.value : undefined;
    this.done = true;
    return value;
  }
}

type Delegate = string | number;
type Job = readonly [delegate: Delegate, offset: number, rating: Rating | undefined, sequence: number];
interface DialogueSnapshot { readonly sequence: number; readonly exchanges: readonly DialogueExchange[] }
type WaitingTurn = readonly [delegate: Delegate, text: string, action: string, linkOffer: string | undefined, rating: Rating | undefined, dialogue: DialogueSnapshot | undefined];

export interface ConversationDeps<S extends EdgeSession> {
  readonly audio: { readonly stt: SttProvider; readonly tts: TtsProvider };
  readonly sessions: { readonly ledgers: ReadonlyMap<string, RequestLedger>; readonly leases: ReadonlyMap<string, Lease> };
  readonly accessWriter: AccessWriter<S>;
  readonly voiceError: VoiceErrorBody;
  readonly port: number | undefined;
}

export class VoiceEdge {
  readonly provider: (stt: EdgeSource, profile?: SpeechProfile) => LiveSessionProvider;
  readonly active = new Map<string, ServerSocket>();
  readonly work = new Set<Promise<unknown>>();
  readonly #clock: Clock;
  readonly #sleep: Sleep;
  readonly #timing: EdgeTiming;

  constructor({ provider = (stt, profile) => new LiveProvider(stt, { profile }), clock = loopClock, sleep = realSleep, timing = {} }: {
    provider?: (stt: EdgeSource, profile?: SpeechProfile) => LiveSessionProvider; clock?: Clock; sleep?: Sleep; timing?: Partial<EdgeTiming>;
  } = {}) {
    this.provider = provider;
    this.#clock = clock;
    this.#sleep = sleep;
    this.#timing = { waitForTextS: WAIT_FOR_TEXT_S, waitWhileTalkingS: WAIT_WHILE_TALKING_S, quietS: QUIET_S,
      maxWaitingTurns: MAX_WAITING_TURNS, effortWaitS: EFFORT_WAIT_S, ...timing };
  }

  /** Once handed off, a task belongs to the orchestrator even if audio disconnects. */
  turn(session: EdgeSession, text: string, action: string, current: () => void, { effort, linkOffer, dialogue }: {
    effort?: string | undefined; linkOffer?: string | undefined; dialogue?: readonly DialogueExchange[] | undefined;
  } = {}): Promise<TurnResultLike> {
    const dispatch = async () => {
      current();
      return await REASONING_EFFORT_OVERRIDE.run(effort !== undefined && effort !== "" ? [STACK.agent, effort] : null, async () => {
        const options: Parameters<EdgeSession["handleTurn"]>[1] = { approvalId: action, fromVoice: true };
        if (linkOffer !== undefined) options.linkOfferId = linkOffer;
        const difficulty = effort === undefined ? undefined : TASK_DIFFICULTY[effort];
        if (difficulty !== undefined) options.difficulty = difficulty;
        if (dialogue !== undefined) options.plannerDialogue = dialogue;
        return await session.handleTurn(text, options);
      });
    };
    const task = dispatch();
    this.work.add(task);
    task.then(() => this.work.delete(task), () => this.work.delete(task));
    return task;
  }

  register<S extends EdgeSession>(app: Hono, upgradeWebSocket: UpgradeWebSocket, deps: ConversationDeps<S>, headersOf: (c: Context) => HeaderList): void {
    app.get("/api/session/:sid/audio/conversation", refuseForeignOrigin(deps.port, headersOf),
      upgradeWebSocket(c => socketEvents(socket => this.conversation(socket, c.req.param("sid") ?? "", deps))));
  }

  /** After the origin check and accept. Mirrors the body of Python's conversation handler. */
  async conversation<S extends EdgeSession>(socket: ServerSocket, sid: string, deps: ConversationDeps<S>): Promise<void> {
    const { audio, sessions, accessWriter, voiceError } = deps;
    try {
      const message = await withDeadline(15_000, socket.receive());
      if (message.type === "disconnect") throw new SocketDisconnected();
      if (message.type !== "text") throw new TypeError("expected a text message");
      const raw = message.text;
      if (raw.length > 131072 || Array.from(raw).length > 65536) throw new RequestConflict();
      const hello: unknown = JSON.parse(raw);
      if (!isRecord(hello) || !("writer" in hello) || !("sdp" in hello)) throw new TypeError("hello");
      const writer = hello.writer, sdp = hello.sdp;
      if (typeof writer !== "string" || Array.from(writer).length > 128 || typeof sdp !== "string" || !sdp.startsWith("v=0")) throw new RequestConflict();
      const session = accessWriter(sid, writer);
      const stt = audio.stt;
      const previous = this.active.get(sid);
      if (session instanceof Response || stt.edgeModel === undefined || stt.edgeModel === "" || previous?.disconnected === false) throw new RequestConflict();
      const ledger = sessions.ledgers.get(sid);
      if (ledger === undefined) throw new RangeError(sid);
      const generation = session.generation;
      const current = () => {
        if (socket.disconnected) throw new SocketDisconnected();
        const lease = sessions.leases.get(sid);
        if (sessions.ledgers.get(sid) !== ledger || session.generation !== generation || session.consentStatus !== "granted"
          || session.dialogue.authWaiting || stt !== audio.stt || (lease !== undefined && (lease.waiting || lease.writer !== writer))) {
          throw new RequestConflict();
        }
      };
      current();
      this.active.set(sid, socket);
      // Bind speech to the decision presented before this microphone
      // opened. Delayed transcript packets must never approve a new card.
      let action = session.dialogue.confirmation?.actionId ?? "";
      if (("approvalId" in hello ? hello.approvalId : "") !== action) action = "";
      const provider = this.provider(stt, audio.tts.profile);
      const pace = speechSpeed(audio.tts.speed ?? VOICE_PROFILE.speed, speechPace(session.personal?.speech().rate));
      const [liveId, answer] = await provider.offer(sdp, session, pace);
      const upstream = await provider.attach(liveId);
      try {
        try {
          current();
          await socket.sendJson({ sdp: answer });
          await this.monitor(upstream, socket, session, current, action);
        } finally {
          await upstream.send(JSON.stringify({ type: "session.close", event_id: hex(12) })).catch(() => {});
        }
      } finally {
        await upstream.close();
      }
    } catch (error) {
      if (!(error instanceof SocketDisconnected)) await socket.sendJson(voiceError(error)).catch(() => {});
    } finally {
      if (this.active.get(sid) === socket) this.active.delete(sid);
      await socket.close().catch(() => {});
    }
  }

  async monitor(upstream: Sideband, socket: EdgeSocket, session: EdgeSession, current: () => void, action: string): Promise<void> {
    const clock = this.#clock, timing = this.#timing;
    const stop = new AbortController();
    const signal = stop.signal;
    const sleep = (seconds: number) => this.#sleep(seconds, signal);
    const transcript = new Transcript(clock);
    const jobs = new Queue<Job>();
    const turns = new Queue<WaitingTurn>(timing.maxWaitingTurns);
    const delegations = new Set<Delegate>();
    const pendingEfforts = new Map<Delegate, Rating>();
    const eventIds: unknown[] = [];
    let appIds = new Set(session.plannerTurns?.map(row => row.id));
    let appGeneration = session.plannerDialogueGeneration;
    let history: TimedExchange[] = (session.plannerDialogue?.() ?? []).map(exchange => ({ sequence: 0, exchange }));
    let privateBoundary = 0;
    const keepRecent = () => {
      history.sort((a, b) => a.sequence - b.sequence);
      history = history.slice(-(timing.maxWaitingTurns + PLANNER_EXCHANGES));
    };
    const observeApp = (delivery?: TurnResultLike) => {
      if (session.plannerDialogue === undefined) return;
      const generation = session.plannerDialogueGeneration;
      if (generation !== appGeneration || delivery?.localSpeechOnly === true) {
        privateBoundary = ++transcript.sequence;
        history = [];
        appIds.clear();
        appGeneration = generation;
      }
      const rows = session.plannerTurns;
      const fresh = rows === undefined
        ? (delivery !== undefined && delivery.localSpeechOnly !== true ? session.plannerDialogue().slice(-1) : [])
        : rows.filter(row => !appIds.has(row.id)).map(row => row.exchange);
      if (fresh.length > 0) {
        const sequence = ++transcript.sequence;
        history.push(...fresh.map(exchange => ({ sequence, exchange })));
        keepRecent();
      }
      if (rows !== undefined) appIds = new Set(rows.map(row => row.id));
    };
    const heardBefore = (match: SpeechMatch, sequence: number): DialogueSnapshot | undefined => {
      if (session.plannerDialogue === undefined) return undefined;
      const through = Math.min(match.first.sequence, sequence);
      for (const row of transcript.exchangesBefore(match.first).slice(-PLANNER_EXCHANGES)) {
        if (row.sequence < privateBoundary || row.sequence > through) continue;
        const exchange = row.exchange === undefined ? undefined : session.plannerDialogue([row.exchange], [])[0];
        // Older lists cannot stand in for a more recent exchange that could not be included.
        if (exchange === undefined) history = history.filter(item => item.sequence > row.sequence);
        else history.push({ sequence: row.sequence, exchange });
      }
      keepRecent();
      return { sequence: through, exchanges: session.plannerDialogue([], history.filter(row => row.sequence <= through).map(row => row.exchange)) };
    };
    let replyLanguage = session.lang;
    let deliveredLinks = session.linkOfferId ?? undefined;
    const alive = () => { if (signal.aborted) throw new Stopped(); };
    const append = async (kind: string, delegate: Delegate | null, content: string) => {
      alive();
      if (kind === "commentary") {
        transcript.sequence++;
        transcript.rememberAppSpeech(content);
      }
      await upstream.send(JSON.stringify({ type: `session.${kind}.append`, event_id: hex(12), delegation_id: delegate, content }));
    };

    const deliver = async (delegate: Delegate, result: TurnResultLike): Promise<boolean> => {
      alive();
      // Stop and sign-in handoff intentionally invalidate this Live session.
      if (result.state === "STOPPED" || result.state === "AUTH_HANDOFF") {
        await socket.sendJson({ result, exact: true });
        return true;
      }
      current();
      transcript.deliveredTurns += 1;
      observeApp(result);
      const language = "lang" in result ? result.lang : replyLanguage;
      if ((language === "ko" || language === "en" || language === "zh" || language === "ja") && language !== replyLanguage) {
        await append("instructions", null, `The application selected ${language}. Use it for subsequent speech.`);
        replyLanguage = language;
      }
      if (typeof result.speech !== "string") throw new TypeError("speech");
      const exact = result.researchDelivery === "outcome" || (isRecord(result.savedResearch) && result.savedResearch.reading === true) || Boolean(result.localSpeechOnly) || result.intentType === "READ_START_GUIDE" || result.semanticAction === "review-before-output"
        || Boolean(result.pendingConfirmation) || Buffer.byteLength(result.speech, "utf8") > 1100;
      await socket.sendJson({ result, exact });
      if (exact) {
        transcript.rememberAppSpeech(result.speech);
        await append("thinking", delegate, "The application is reading its response. Wait for the user.");
      }
      else await append("commentary", delegate, result.speech);
      deliveredLinks = session.linkOfferId ?? undefined;
      return false;
    };

    const events = async () => {
      for await (const raw of upstream) {
        if (signal.aborted) return;
        current();
        const event: unknown = JSON.parse(raw);
        if (!isRecord(event)) throw new TypeError("sideband event");
        const kind = event.type, eventId = event.event_id;
        const keyed = eventId !== undefined && eventId !== null && eventId !== "" && eventId !== 0 && eventId !== false;
        if (keyed && eventIds.includes(eventId)) continue;
        if (keyed) {
          eventIds.push(eventId);
          if (eventIds.length > 512) eventIds.shift();
        }
        if (kind === "session.input_transcript.delta" || kind === "session.output_transcript.delta") {
          observeApp();
          transcript.add(event, action, deliveredLinks);
        } else if (kind === "session.delegation.created") {
          const row = event.delegation;
          if (!isRecord(row) || !("id" in row) || !("target" in row) || !("offset_ms" in event)) throw new TypeError("delegation");
          const delegate = row.id;
          if (typeof delegate !== "string" && typeof delegate !== "number") throw new TypeError("delegation id");
          if ((row.target === "client" || row.target === "decisions") && !delegations.has(delegate)) {
            if (delegations.size >= 512) return;
            delegations.add(delegate);
            const rating = row.target === "decisions" ? new Rating() : undefined;
            if (rating !== undefined) pendingEfforts.set(delegate, rating);
            const offset = event.offset_ms;
            if (typeof offset !== "number") throw new TypeError("offset_ms");
            observeApp();
            jobs.put([delegate, offset, rating, transcript.sequence]); // 위의 넘김 512개가 한도
            await append("thinking", delegate, "");
          }
        } else if (kind === "decision.event") {
          const delegate = event.delegation_id, decision = event.event;
          if (typeof delegate === "string" && isRecord(decision) && decision.type === "decision.completed") {
            const rating = pendingEfforts.get(delegate);
            pendingEfforts.delete(delegate);
            if (rating !== undefined && !rating.done) rating.set(effortChoice(decision));
          }
        } else if (kind === "session.closed") {
          const fault = liveClosure(event.reason);
          if (fault !== undefined) throw fault;
          return;
        } else if (kind === "error") {
          throw VoiceProviderError.fromBody(event);
        }
      }
    };

    const resolver = async () => {
      // 넘김은 도착하는 대로 차례로 말에 맞춘다. 긴 턴이 도는 동안에도 멈춤과 진행 물음이 그 뒤에서 기다리지 않게.
      let matchedAction = action, linkOffer: string | undefined;
      for (;;) {
        const [delegate, offset, rating, sequence] = await jobs.get(signal);
        const started = clock();
        let boundFirst: Fragment | undefined;
        let match: SpeechMatch | undefined, text: string, urgent: boolean, quiet: boolean;
        for (;;) {
          match = transcript.match(offset, { boundFirst, delegated: true });
          if (boundFirst === undefined && match !== undefined && hasText(match.first.linkOffer) && match.text !== "") {
            // Keep a delayed offset provisional in case its own transcript arrives.
            // Check even a provisional match for a continuation after an acknowledgment.
            const first = match.first;
            if (offset <= match.end + 200) boundFirst = first;
            match = transcript.match(offset, { boundFirst: first, delegated: true });
          }
          text = match?.text ?? "";
          const now = clock();
          urgent = isStopUtterance(text) || isProgressQuestion(text);
          if (match !== undefined && hasText(match.first.linkOffer) && !urgent) quiet = now - match.receivedAt >= PAUSE_SPLIT_MS / 1000;
          else quiet = now - transcript.updated >= timing.quietS;
          if (text !== "" && quiet && now >= started + 0.35) break;
          if (now >= started + (text !== "" ? timing.waitWhileTalkingS : timing.waitForTextS)) break;
          await sleep(0.08);
        }
        current();
        const consumed = transcript.through;
        const dialogue = match === undefined ? undefined : heardBefore(match, sequence);
        if (match !== undefined) {
          matchedAction = match.first.approval;
          linkOffer = match.first.linkOffer;
          transcript.consume(match, { incompleteLink: linkOffer !== undefined && linkOffer !== "" && (text === "" || !quiet) });
        }
        if (text === "" && consumed >= Math.max(0, offset - ABSORBED_MS)) {
          await append("thinking", delegate, ABSORBED);
        } else if (text === "" || !quiet) {
          await append("commentary", delegate, MISSED);
        } else if (urgent) {
          const result = await this.turn(session, text, matchedAction, current);
          if (await deliver(delegate, result)) return;
        } else if (turns.full) {
          await append("commentary", delegate, BUSY);
        } else {
          turns.put([delegate, text, matchedAction, linkOffer, rating, dialogue]);
          continue;
        }
        pendingEfforts.delete(delegate);
      }
    };

    const worker = async () => {
      for (;;) {
        const [delegate, text, turnAction, linkOffer, rating, dialogue] = await turns.get(signal);
        let effort: string | undefined;
        if (rating !== undefined) {
          try {
            effort = await rating.wait(timing.effortWaitS, this.#sleep, signal);
          } finally {
            pendingEfforts.delete(delegate);
          }
        }
        observeApp();
        const exchanges = dialogue === undefined || dialogue.sequence >= privateBoundary ? dialogue?.exchanges : [];
        const result = await this.turn(session, text, turnAction, current, { effort, linkOffer, dialogue: exchanges });
        if (await deliver(delegate, result)) return;
      }
    };

    const guard = async () => {
      let lastChecked = 0;
      for (;;) {
        await sleep(0.2);
        current();
        if (transcript.fragments.length === 0 || transcript.updated === lastChecked || clock() - transcript.updated < 0.4) continue;
        lastChecked = transcript.updated;
        const offset = Math.max(...transcript.fragments.map(f => f.end));
        const [text, stopAction] = transcript.read(offset, { pauseMs: STOP_SPLIT_MS });
        if (text !== "" && isStopUtterance(text)) {
          transcript.read(offset, { consume: true, pauseMs: STOP_SPLIT_MS });
          const result = await this.turn(session, text, stopAction, current);
          alive();
          await socket.sendJson({ result, exact: true });
          return;
        }
      }
    };

    // The browser can close the call. It has no channel for submitting
    // transcripts, delegation IDs or synthesized instructions to the worker.
    const tasks = [events(), resolver(), worker(), guard(), socket.receive().then(() => {})];
    for (const task of tasks) task.catch(() => {});
    try {
      await Promise.race(tasks);
    } finally {
      stop.abort();
    }
  }
}
