// 서버와 주고받는 모든 요청. 응답은 여기서 zod로 검증해 화면이 쓰는 모양으로만 넘긴다(Python server/app.py의 계약).
import { z } from "zod";
import { LangSchema, SessionStateSchema, type Lang } from "../../src/core/turn.ts";
import type { LiveAudio } from "./mic.ts";

const text = z.string();
const opt = <T extends z.ZodType>(schema: T) => schema.nullish().transform(value => value ?? undefined);

export const AuthHandoffSchema = z.object({
  id: text, taskId: text, kind: z.enum(["login", "verification", "captcha"]),
  status: z.enum(["waiting", "completed", "cancelled", "expired", "interrupted", "blocked"]), site: text,
});
export type AuthHandoff = z.infer<typeof AuthHandoffSchema>;
const SourceSchema = z.object({ title: text, url: text, lastCheckedAt: text, note: opt(text) });
export type Source = z.infer<typeof SourceSchema>;
export const APPROVAL_KINDS = ["field-entry", "click", "file-transfer", "visual-navigation", "practice-submission", "public-research", "vault-save", "vault-clear"] as const;
export type ApprovalKind = typeof APPROVAL_KINDS[number];
const PendingSchema = z.object({
  actionId: text, kind: opt(z.enum(APPROVAL_KINDS)), purpose: text, site: text, description: opt(text),
  values: z.array(z.object({ label: text, value: text })),
});
export type PendingConfirmation = z.infer<typeof PendingSchema>;
const FieldSchema = z.object({
  label: text, type: text, visible: z.boolean(), required: z.boolean(), filled: z.boolean(),
  sensitive: z.boolean(), invalid: z.boolean(), value: opt(text),
});
export type ObservedField = z.infer<typeof FieldSchema>;
const ObservationSchema = z.object({
  title: text, fields: z.array(FieldSchema),
  step: opt(z.object({ index: z.number(), total: z.number(), name: text })),
});
const ExecutedSchema = z.object({
  action: z.object({ id: text, reason: text }),
  policy: z.object({ allowed: z.boolean(), reason: text }),
  result: opt(z.object({ ok: z.boolean(), errorCode: opt(text) })),
});
export type ExecutedAction = z.infer<typeof ExecutedSchema>;
const AnswerCardSchema = z.object({
  answer: text, serviceName: text, grounded: z.boolean(), source: SourceSchema,
  dataKind: z.enum(["live", "stored", "private-program"]), dataOrigin: text, dataDate: opt(text), nextAction: text,
});
export type AnswerCard = z.infer<typeof AnswerCardSchema>;
export const INTRO_POSES = ["welcome", "listening", "screen-reading", "confirmation", "auth-handoff", "stopped", "complete"] as const;
export type IntroPose = typeof INTRO_POSES[number];
const SpeechPrefsSchema = z.object({ rate: z.number().optional(), voice: z.string().nullish() });

export const TurnSchema = z.object({
  sessionId: text, turnId: text, userUtterance: text, intentType: text, state: SessionStateSchema,
  stopGeneration: opt(z.number().int().nonnegative()), semanticAction: text, speech: text,
  localSpeechOnly: opt(z.literal(true)), lang: LangSchema.default("ko"), actions: z.array(ExecutedSchema).default([]),
  observation: opt(ObservationSchema), verification: opt(z.object({ fieldValueMatches: opt(z.boolean()), receipt: opt(text) })),
  pendingConfirmation: opt(PendingSchema), authHandoff: opt(AuthHandoffSchema), answerCard: opt(AnswerCardSchema),
  accessMode: opt(z.enum(["full", "read-only", "none"])), sources: z.array(SourceSchema).default([]), speechPrefs: opt(SpeechPrefsSchema),
  offeredChoices: opt(z.array(z.object({ key: text, label: text }))), publicSuggestions: opt(z.array(text)),
  introScript: opt(z.array(z.object({ text, pose: z.enum(INTRO_POSES), ask: opt(z.boolean()) }))),
});
export type Turn = z.infer<typeof TurnSchema>;

const HealthSchema = z.object({
  llmRoles: z.record(text, z.string().nullable()).optional(),
  stt: z.object({ provider: text, supported: z.boolean(), liveModel: opt(text) }),
  tts: z.object({ provider: text, supported: z.boolean() }),
  voiceEdge: opt(text), practiceMode: opt(z.boolean()), voiceSpeed: opt(z.number()),
  setupRequired: opt(z.boolean()), firstRun: opt(text), settingsAvailable: opt(z.boolean()),
  workspaceAvailable: opt(z.boolean()), recoveryAvailable: opt(z.boolean()),
});
export type Health = z.infer<typeof HealthSchema>;
const DEVICE_USES = ["unidentified", "personal", "shared"] as const;
const BROWSERS = ["separate", "chrome"] as const;
export const SettingsSchema = z.object({
  language: LangSchema, region: text, speed: z.number(), rememberService: z.boolean(),
  deviceUse: z.enum(DEVICE_USES), browser: z.enum(BROWSERS), sharedDevice: z.boolean(), hasKey: z.boolean(),
  loadError: z.boolean(), regions: z.array(text), browserFallback: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;
export interface SettingsInput {
  apiKey: string; language: Lang; region: string; speed: number;
  deviceUse: typeof DEVICE_USES[number]; rememberService: boolean; browser: typeof BROWSERS[number];
}
const CredentialsSchema = z.object({ token: opt(text), writer: opt(text) });
const SessionSchema = CredentialsSchema.extend({
  sessionId: text, state: SessionStateSchema, consentRequired: z.boolean(), firstStartupGuide: opt(z.boolean()),
  speechPrefs: opt(SpeechPrefsSchema), lang: opt(LangSchema), stopGeneration: opt(z.number()),
});
export type Session = z.infer<typeof SessionSchema>;
const RecoveredSchema = CredentialsSchema.extend({ sessionId: text, state: opt(SessionStateSchema), stopGeneration: opt(z.number()) });
const CheckpointSchema = z.object({
  state: SessionStateSchema, lang: opt(LangSchema), consent: z.enum(["pending", "granted", "declined"]),
  stopGeneration: opt(z.number()), approvalKind: opt(text), progressSeq: opt(z.number()), step: opt(z.number()),
  authHandoff: opt(AuthHandoffSchema),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;
const ProgressSchema = z.object({
  running: z.boolean(), seq: z.number(), spoken: z.boolean(), latest: z.string().nullish(),
  activity: z.string().nullish(), activitySpoken: z.boolean().optional(), activitySeq: z.number().optional(),
});
const JobSchema = z.object({
  id: text, prompt: text, state: text,
  result: opt(z.object({ text: opt(text), sources: opt(z.array(z.object({ url: text, title: text }))) })),
});
const NoteSchema = z.object({ id: text, body: text });
export type Note = z.infer<typeof NoteSchema>;
export const WorkspaceSchema = z.object({ jobs: z.array(JobSchema), notes: z.array(NoteSchema) });
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** 서버가 돌려준 오류: code는 서버의 오류 이름(error), status는 HTTP 상태. */
export class ApiError extends Error {
  code: string | undefined;
  status: number | undefined;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const errorCode = (error: unknown) => error instanceof ApiError ? error.code : undefined;
export const errorStatus = (error: unknown) => error instanceof ApiError ? error.status : undefined;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

let writer: string | undefined;
let requestSeq = 0;

function headers(values: Record<string, string> = {}): Record<string, string> {
  return { ...(writer !== undefined && writer.length > 0 ? { "X-Cheongeum-Writer": writer } : {}), ...values };
}

async function fetchOnceRetried(path: string, init: RequestInit) {
  try {
    return await fetch(path, init);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return fetch(path, init);
  }
}

async function failure(res: Response): Promise<never> {
  const body = z.object({ message: z.string().optional(), error: z.string().optional() })
    .catch({}).parse(await res.json().catch(() => ({})));
  throw new ApiError(body.message ?? `요청 실패 (${res.status})`, body.error, res.status);
}

interface CallInit { method?: string; body?: BodyInit | undefined; headers?: Record<string, string>; signal?: AbortSignal }
async function call<T>(schema: z.ZodType<T>, path: string, init: CallInit = {}, retry = false): Promise<T> {
  const opts = { ...init, headers: headers({ ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers }) };
  if (retry && path !== "/api/session/recover") opts.headers["X-Cheongeum-Request"] = String(++requestSeq);
  const res = await (retry ? fetchOnceRetried(path, opts) : fetch(path, opts));
  return res.ok ? schema.parse(await res.json()) : failure(res);
}
const post = (body?: unknown): CallInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

const ReceiptSchema = z.object({ receipt: z.string().optional(), message: z.string().optional(), error: z.string().optional() });

// The renderer only receives a one-use receipt. Transcript text stays on the local server.
function liveAudio(sessionId: string): LiveAudio {
  const url = new URL(`/api/session/${encodeURIComponent(sessionId)}/audio/live`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  const pending: ArrayBuffer[] = [];
  let committed = false;
  let cancelled = false;
  let resolve: (receipt: string) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const receipt = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  receipt.catch(() => {}); // The recording may be cancelled before anyone requests its result.
  const lost = () => reject(new Error("실시간 받아쓰기 연결이 끊겼어요. 다시 말씀해 주세요."));
  socket.onopen = () => {
    if (cancelled) { socket.close(); return; }
    socket.send(JSON.stringify({ writer: writer ?? "" }));
    for (const frame of pending) socket.send(frame);
    pending.length = 0;
    if (committed) socket.send("commit");
  };
  socket.onmessage = ({ data }: MessageEvent<unknown>) => {
    try {
      const msg = ReceiptSchema.parse(JSON.parse(String(data)));
      if (msg.receipt !== undefined && msg.receipt.length > 0) resolve(msg.receipt);
      else reject(new ApiError(msg.message ?? "", msg.error));
    } catch { lost(); }
  };
  socket.onerror = lost;
  socket.onclose = () => { pending.length = 0; lost(); };
  return {
    append(frame) {
      if (committed || cancelled) return;
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      else if (socket.readyState === WebSocket.CONNECTING) pending.push(frame);
    },
    commit() {
      if (!committed && !cancelled && socket.readyState === WebSocket.OPEN) socket.send("commit");
      committed = true;
      return receipt;
    },
    cancel() {
      cancelled = true;
      pending.length = 0;
      socket.close();
    },
  };
}

async function audioBody(audio: LiveAudio) {
  return { type: "application/json", body: JSON.stringify({ receipt: await audio.commit() }) };
}

const sid = (id: string) => encodeURIComponent(id);
const ok = z.object({ ok: z.boolean() });
const saved = z.object({ saved: z.boolean() });

export const api = {
  parseTurn: (raw: unknown) => TurnSchema.parse(raw),
  workspace: (id: string, path = "", method = "GET", data?: unknown) => call(z.unknown(), `/api/session/${sid(id)}/workspace${path}`,
    { method, body: data !== undefined ? JSON.stringify(data) : undefined }),
  recording: (id: string, file: Blob, type: string, signal: AbortSignal) => call(z.object({ text: z.string() }), `/api/audio/recording?sessionId=${sid(id)}`, {
    method: "POST", headers: { "Content-Type": type }, body: file, signal,
  }),
  liveAudio,
  /** 실시간 음성 대화(WebRTC)의 제안·결과를 주고받는 연결. */
  conversationSocket: (id: string) => {
    const url = new URL(`/api/session/${sid(id)}/audio/conversation`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url);
  },
  voiceOffer: (socket: WebSocket, sdp: string, approvalId = "") => socket.send(JSON.stringify({ writer: writer ?? "", sdp, approvalId })),
  health: () => call(HealthSchema, "/api/health"),
  settings: () => call(SettingsSchema, "/api/settings"),
  saveSettings: (values: SettingsInput) => call(saved, "/api/settings", post(values)),
  saveGuardian: (contact: { name: string; phone: string }) => call(saved, "/api/personal/guardian", post(contact)),
  checkKey: (apiKey: string) => call(z.object({ result: z.string() }), "/api/settings/check-key", post({ apiKey })),
  writer: (key: string | undefined) => { writer = key; requestSeq = 0; },
  recover: (token: string) => call(RecoveredSchema, "/api/session/recover", post({ token, attempt: crypto.randomUUID() }), true),
  resume: (id: string) => call(CheckpointSchema, `/api/session/${id}/resume`, post(), true),
  wake: (id: string, stopGeneration: number) => call(z.object({ state: SessionStateSchema }), `/api/session/${id}/wake`, post({ stopGeneration }), true),
  heartbeat: (id: string) => call(ok, `/api/session/${id}/heartbeat`),
  end: (id: string) => call(z.unknown(), `/api/session/${id}`, { method: "DELETE" }),
  detach: (id: string) => {
    void fetch(`/api/session/${id}/detach`, { method: "POST", headers: headers(), keepalive: true }).catch(() => undefined);
  },
  /** 녹음을 보내 받아쓰기+턴 처리를 한 번에. 받아쓴 원문은 돌아오지 않는다. */
  async audioTurn(sessionId: string, audio: LiveAudio, actionId = "") {
    const clip = await audioBody(audio);
    const res = await fetchOnceRetried(`/api/audio/turn?sessionId=${sid(sessionId)}`, {
      method: "POST",
      headers: headers({ "Content-Type": clip.type, "X-Cheongeum-Action": actionId,
        "X-Cheongeum-Request": String(++requestSeq) }),
      body: clip.body,
    });
    return res.ok ? TurnSchema.parse(await res.json()) : failure(res);
  },
  /** 일하는 동안 들은 말을 보낸다. 멈춤 말이면 멈추고, 진행 상황 물음이면 바로 답하고(result), 그 밖의 말은 버린다. */
  async audioStop(sessionId: string, audio: LiveAudio) {
    const clip = await audioBody(audio);
    const res = await fetch(`/api/audio/stop?sessionId=${sid(sessionId)}`, {
      method: "POST",
      headers: headers({ "Content-Type": clip.type }),
      body: clip.body,
    });
    return res.ok ? z.object({ stopped: z.boolean(), result: opt(TurnSchema) }).parse(await res.json()) : failure(res);
  },
  /** rate: 말 빠르기 설정(speechPrefs.rate). 서버 음성도 이 빠르기로 합성한다. */
  async speak(chunk: string, lang: Lang, rate: number) {
    const res = await fetch("/api/audio/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: chunk, lang, rate }) });
    return res.ok ? res.blob() : failure(res);
  },
  createSession: (recoverable = false) => call(SessionSchema, "/api/session", post(recoverable ? { recovery: true } : { attached: true })),
  turn: (sessionId: string, message: string, actionId = "") => call(TurnSchema, "/api/turn", post({ sessionId, text: message, actionId, clientPlatform: "pc" }), true),
  confirm: (sessionId: string, approve: boolean, actionId: string | undefined) => call(TurnSchema, `/api/session/${sessionId}/confirm`, post({ approve, actionId }), true),
  /** 서버가 제안한 선택지 고르기: { turnId, key, handoffId? }. 지난 제안이면 409 CHOICE_EXPIRED. */
  choice: (sessionId: string, body: { turnId: string; key: string; handoffId?: string }) => call(TurnSchema, `/api/session/${sessionId}/choice`, post(body), true),
  reminders: (sessionId: string) => call(z.object({ text: z.string().nullish() }), `/api/session/${sessionId}/reminders`),
  progress: (sessionId: string) => call(ProgressSchema, `/api/session/${sessionId}/progress`),
  language: (sessionId: string, lang: Lang) => call(TurnSchema, `/api/session/${sessionId}/language`, post({ lang })),
  cancel: (sessionId: string) => call(TurnSchema, `/api/session/${sessionId}/cancel`, post()),
  /** 페이지를 떠날 때 호출. keepalive라서 탭이 닫혀도 요청이 전송된다. */
  close: (sessionId: string) => {
    void fetch(`/api/session/${sessionId}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
  },
  consent: (sessionId: string, granted: boolean) => call(TurnSchema, `/api/session/${sessionId}/consent`, post({ granted })),
};
