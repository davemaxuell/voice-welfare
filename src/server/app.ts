import { Hono, type Context } from "hono";
import { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { upgradeWebSocket } from "@hono/node-server";
import { ChoiceKeySchema } from "../core/choices.ts";
import { LiveAudio, TranscriptTooLong, turnTranscript, refuseForeignOrigin } from "./live_audio.ts";
import { Presentation } from "./presentation.ts";
import { VoiceEdge } from "./voice_edge.ts";
import { Sessions as RecoverySessions, RequestConflict } from "./recovery.ts";
import { Workflows, registerWorkflows } from "./workflows.ts";
import { serveStatic } from "@hono/node-server/serve-static";
import { webStatic } from "../core/assets.ts";
import { strip } from "../core/text.ts";
import { LangSchema } from "../core/turn.ts";
import { CTPV } from "../core/region.ts";
import { OPENAI_BASE_URL } from "../core/llm.ts";
import { isMobile } from "../personal/store.ts";
import { SettingsInput } from "./settings.ts";
import { checkOpenaiKey } from "./key_check.ts";
import type { SessionOrchestrator } from "../orchestrator/session.ts";
import { redactText, detectSensitive } from "../safety/privacy.ts";
import { isStopUtterance, isProgressQuestion } from "../understanding/rules.ts";
import { VoiceNotSupportedError, VoiceProviderError } from "../voice/errors.ts";
import { HandshakeRejected, SocketClosed } from "../voice/live.ts";
import { speechPace, VOICE_PROFILE } from "../core/voice_profile.ts";
import { VoiceFault, voiceFault } from "../voice/recovery.ts";
export { speechPace } from "../core/voice_profile.ts";
import type { SttProvider } from "../voice/stt.ts";
import type { TtsProvider } from "../voice/tts.ts";
import type { AgentRuntime } from "./runtime.ts";
import { AUDIO_LIMIT, JSON_LIMIT, rawHeaderList, requestRefusal, type HeaderList } from "./request_policy.ts";

export const MAX_SESSIONS = 3;
export { JSON_LIMIT, AUDIO_LIMIT };
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'";
export const AVATAR_CSP = CSP.replace("img-src 'self' data:", "img-src 'self' data: blob:").replace("connect-src 'self'", "connect-src 'self' blob:");

function incoming(c: Context): IncomingMessage | undefined {
  const env: unknown = c.env;
  return typeof env === "object" && env !== null && "incoming" in env && env.incoming instanceof IncomingMessage ? env.incoming : undefined;
}

function requestHeaders(c: Context): HeaderList {
  const req = incoming(c);
  if (req !== undefined) return rawHeaderList(req.rawHeaders);
  // Fetch-only callers have an absolute request URL but no implicit Host field.
  const url = new URL(c.req.url);
  return { getAll(name) {
    const value = c.req.raw.headers.get(name) ?? (name === "host" ? url.host : null);
    return value === null ? [] : [value];
  } };
}

export type HttpSession = Pick<
  SessionOrchestrator,
  | "id" | "dialogue" | "firstRun" | "generation" | "linkOfferId" | "missedSpeechHint" | "recentVoiceDialogue" | "choose" | "wake"
  | "detachForRecovery" | "resumeForRecovery" | "stageSettings" | "researchPublic" | "deps"
  | "state"
  | "consentStatus"
  | "lang"
  | "handleTurn"
  | "confirm"
  | "consentTo"
  | "reminders"
  | "setLanguage"
  | "snapshot"
  | "progress"
  | "researchReceipts" | "acknowledgeResearch"
  | "cancel"
  | "close"
>;
export interface HttpRuntime<S extends HttpSession = HttpSession> {
  createSession(options?: { background?: boolean }): Promise<S>;
  readonly sessionModels?: AgentRuntime["sessionModels"];
  readonly embedding?: AgentRuntime["embedding"];
  readonly moderation?: AgentRuntime["moderation"];
  readonly openData?: { readonly statuses: readonly unknown[] };
  readonly config?: AgentRuntime["config"];
  readonly settings?: AgentRuntime["settings"];
  readonly browserFallback?: boolean;
  readonly fetcher?: typeof fetch;
  readonly personalStore?: AgentRuntime["personalStore"];
  readonly refreshServices?: AgentRuntime["refreshServices"];
  llmRoles(): Record<string, string>;
  intentProvider: { name: string };
  welfareProvider: Pick<AgentRuntime["welfareProvider"], "mode" | "listServices">;
  events: Pick<AgentRuntime["events"], "all">;
  scanner?: Pick<AgentRuntime["scanner"], "scan">;
  stt: SttProvider;
  tts: TtsProvider;
}

export class Sessions<S extends HttpSession> extends RecoverySessions<S> {
  closed = false;
  async close() {
    this.closed = true;
    await this.creating.run(async () => {
      const active = this.values();
      this.clear();
      await Promise.allSettled(active.map(session => session.close()));
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(status: number, code: string, message: string) {
  return Response.json({ error: code, message }, { status });
}
const noSession = () => error(404, "SESSION_NOT_FOUND", "세션이 없습니다. 새 세션을 시작하세요.");
function voiceFailure(e: unknown): [number, string, string] {
  if (e instanceof TranscriptTooLong) return [422, "TRANSCRIPT_TOO_LONG", "말씀이 길어서 실행하지 않았어요. 요청을 나눠서 말씀해 주세요."];
  if (e instanceof RequestConflict) return [409, "REQUEST_CONFLICT", "이 녹음은 끝났거나 작업이 바뀌었어요. 다시 말씀해 주세요."];
  if (e instanceof VoiceNotSupportedError) return [501, "NOT_SUPPORTED", e.message];
  if (e instanceof VoiceFault) return [e.retryable ? 503 : 422, e.code, "실시간 음성 대화가 종료됐어요."];
  if (e instanceof HandshakeRejected) return voiceFailure(new VoiceProviderError(e.status));
  if (e instanceof SocketClosed) return [503, "VOICE_CONNECTION", "실시간 음성 연결이 끊겼어요."];
  if (e instanceof Error && e.name === "TimeoutError") return [504, "VOICE_TIMEOUT", "음성 서비스 응답 시간이 초과됐어요."];
  if (e instanceof VoiceProviderError) {
    if (e.status === 408 || e.status === 504) return [504, "VOICE_TIMEOUT", "음성 서비스 응답 시간이 초과됐어요."];
    if (e.providerCode === "session_expired") return [503, "VOICE_SESSION_EXPIRED", "실시간 음성 연결이 만료됐어요."];
    if (e.providerCode === "insufficient_quota") return [429, "VOICE_QUOTA", "음성 API 잔액을 확인해 주세요."];
    if (e.status === 401 || e.status === 403) return [502, "VOICE_KEY", "음성 API 인증에 실패했어요. 이용 설정에서 키와 사용 권한을 확인해 주세요."];
    if (e.status === 429) return [429, "VOICE_LIMIT", "음성 API 사용 한도에 도달했어요. API 잔액이나 요청 한도를 확인해 주세요."];
    if (e.status === 404) return [502, "VOICE_MODEL", "설정한 음성 모델을 이용할 수 없어요. API 키의 모델 권한을 확인해 주세요."];
  }
  return [502, "VOICE_PROVIDER", "음성 서비스 호출에 실패했습니다. 잠시 후 다시 시도하거나 텍스트로 입력하세요."];
}
function voiceFailureBody(e: unknown) {
  const [status, code, message] = voiceFailure(e);
  const provider = e instanceof VoiceProviderError ? e : undefined;
  if (!(e instanceof RequestConflict) && !(e instanceof TranscriptTooLong)) {
    console.warn("[voice]", { code, upstreamStatus: provider?.status ?? (e instanceof HandshakeRejected ? e.status : undefined),
      upstreamCode: provider?.providerCode, socketCode: e instanceof SocketClosed ? e.code : undefined, cause: voiceFault(e).code });
  }
  return { status, error: code, message, retryAfterMs: provider?.retryAfterMs };
}
const voiceError = (e: unknown) => {
  const body = voiceFailureBody(e);
  return Response.json(body, { status: body.status });
};

async function limitedBytes(request: Request, max: number): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      count += result.value.byteLength;
      if (count > max) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, count);
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const bytes = await limitedBytes(request, JSON_LIMIT);
  if (bytes === undefined) return undefined;
  if (bytes.length === 0) return {};
  try {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(raw) ? raw : undefined;
  } catch { return undefined; }
}

function validText(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  const text = strip(value);
  return text.length > 0 && Array.from(text).length <= max ? text : undefined;
}

export function staticFiles(root: string) {
  return serveStatic({
    root,
    onFound(path, c) {
      if (path.endsWith(".js") || path.endsWith(".mjs")) c.header("Content-Type", "text/javascript");
      if (path.endsWith(".css")) c.header("Content-Type", "text/css");
    },
  });
}

export function makeApp<S extends HttpSession>(
  runtime: HttpRuntime<S>,
  options: { stt?: SttProvider; tts?: TtsProvider; web?: boolean; csp?: boolean; port?: number; workflowDsn?: string; voiceEdge?: VoiceEdge } = {},
) {
  const app = new Hono();
  const presentation = new Presentation();
  const sessions = new Sessions<S>();
  const audio = {
    get stt() { return options.stt ?? runtime.stt; },
    get tts() { return options.tts ?? runtime.tts; },
  };
  const workflows = new Workflows({
    get settings() { return runtime.settings; }, get config() { return runtime.config ?? {}; },
    get embedding() { return runtime.embedding; }, get moderation() { return runtime.moderation; },
    scan: texts => runtime.scanner?.scan(texts) ?? Promise.resolve(texts.map(() => [])), createSession: opts => runtime.createSession(opts),
  }, options.workflowDsn);
  const recoveryAvailable = () => runtime.config?.pilotProfile !== "shared" &&
    !(runtime.settings?.completed === true && runtime.settings.preferences.deviceUse === "shared") &&
    (runtime.config?.pilotProfile === "personal" || workflows.personal);
  const live = new LiveAudio();
  const writerRequired = () => error(409, "SESSION_WRITER_REQUIRED", "이 탭에서 작업을 제어할 수 없어요.");
  const accessWriter = (sid: string, writer: string, recovery = false): S | Response => {
    const s = sessions.get(sid);
    if (s === undefined) return noSession();
    const lease = sessions.leases.get(sid);
    if (lease !== undefined) {
      const given = Buffer.from(writer), held = Buffer.from(lease.writer ?? "");
      if (held.length === 0 || held.length !== given.length || !timingSafeEqual(held, given)) return writerRequired();
      if (lease.waiting && !recovery) return error(409, "RECOVERY_CONFIRMATION_REQUIRED", "이전 작업을 이어 할지 먼저 선택해 주세요.");
      sessions.keepAlive(sid, lease);
    } else if (sessions.ephemeral.has(sid)) sessions.keepEphemeral(sid);
    return s;
  };
  const access = (sid: string, c: Context, recovery = false) => accessWriter(sid, c.req.header("x-cheongeum-writer") ?? "", recovery);
  const byId = (c: Context, recovery = false) => access(c.req.param("sid") ?? "", c, recovery);
  function inputAction(s: S, supplied: string | undefined) {
    if (supplied !== undefined) return supplied;
    const shown = s.dialogue.confirmation;
    return shown?.kind === "vault-save" || shown?.kind === "vault-clear" ? "" : shown?.actionId ?? "";
  }
  async function once(s: S, c: Context, payload: Uint8Array, work: () => Promise<Response>): Promise<Response> {
    const ledger = sessions.ledgers.get(s.id), generation = s.generation;
    try {
      if (ledger === undefined) throw new RequestConflict();
      const response = await ledger.once(c.req.header("x-cheongeum-request"), payload, async () => {
        if (sessions.ledgers.get(s.id) !== ledger || s.generation !== generation) throw new RequestConflict();
        return await work();
      });
      if (!(response instanceof Response)) throw new Error("Invalid cached response");
      return response.clone();
    } catch (e) {
      if (e instanceof RequestConflict) return error(409, "REQUEST_CONFLICT", "이 요청은 이미 만료됐거나 내용이 바뀌었어요.");
      throw e;
    }
  }
  async function transcribe(request: Request, language: string, bytes: Uint8Array | undefined, sid: string) {
    const stt = audio.stt;
    if (!stt.supported) throw new VoiceNotSupportedError("음성 입력을 사용하려면 이용 설정에서 OpenAI API 키를 등록해 주세요.");
    const mimeType = request.headers.get("content-type") ?? "";
    if (mimeType.split(";")[0]?.trim() === "application/json" && sid !== "") {
      const raw = bytes ?? await limitedBytes(request, JSON_LIMIT);
      let obj: unknown;
      try { obj = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
      catch { throw new RequestConflict(); }
      const session = sessions.get(sid), ledger = sessions.ledgers.get(sid);
      if (!isRecord(obj) || Object.keys(obj).length !== 1 || !("receipt" in obj) || session === undefined || ledger === undefined) throw new RequestConflict();
      return live.take(obj.receipt, sid, ledger, session.generation);
    }
    const data = bytes ?? await limitedBytes(request, AUDIO_LIMIT);
    return data === undefined || data.length < 200 ? "" : (await stt.transcribe(data, { language, mimeType, signal: request.signal })).text;
  }

  function allowedMethods(path: string) {
    const parts = (path.endsWith("/") ? path.slice(0, -1) : path).slice(1).split("/");
    return app.routes
      .filter((route) => {
        if (!route.path.startsWith("/api/") || route.method === "ALL") return false;
        const pattern = route.path.slice(1).split("/");
        return (
          pattern.length === parts.length &&
          pattern.every((segment, i) => segment.startsWith(":") || segment === parts[i])
        );
      })
      .map((route) => route.method);
  }
  const missingRoute = () => Response.json({ detail: "Not Found" }, { status: 404 });
  const methodError = (allow: string) =>
    Response.json({ detail: "Method Not Allowed" }, { status: 405, headers: { allow } });
  function fallback(c: Context) {
    if (options.web === true) {
      return c.req.method === "GET" || c.req.method === "HEAD" ? missingRoute() : methodError("GET, HEAD");
    }
    const path = c.req.path;
    const allowed = allowedMethods(path);
    if (allowed.length > 0 && path.endsWith("/")) {
      const url = new URL(c.req.url);
      url.pathname = path.slice(0, -1);
      return Response.redirect(url, 307);
    }
    return allowed.length > 0 ? methodError(allowed.join(", ")) : missingRoute();
  }
  if (options.csp === true)
    app.use("*", async (c, next) => {
      await next();
      c.header("Content-Security-Policy", c.req.path.startsWith("/avatar/") ? AVATAR_CSP : CSP);
    });
  app.use("/api/*", async (c, next) => {
    const request = c.req.raw;
    const path = c.req.path;
    const denied = requestRefusal({
      method: request.method, path, scheme: new URL(request.url).protocol === "https:" ? "https" : "http", headers: requestHeaders(c),
    }, options.port ?? incoming(c)?.socket.localPort);
    if (denied !== undefined) {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return c.body(null, 403);
      return error(denied[0], denied[1], "로컬 API 요청 형식을 확인해 주세요.");
    }
    if ((request.method === "DELETE" || request.method === "POST")
        && (request.method === "DELETE" || !request.headers.has("content-type") || /\/(cancel|detach|resume)$/u.test(path))) {
      if (await limitedBytes(request, 0) === undefined) return error(415, "UNEXPECTED_BODY", "이 요청은 본문을 받지 않습니다.");
    }
    if (request.method === "HEAD") return fallback(c);
    await next();
    c.header("Cache-Control", "no-store");
    return undefined;
  });
  app.onError((exception) => {
    // Exception messages may contain a spoken value.
    console.error("[server] error", exception.constructor.name);
    return error(500, "INTERNAL", "서버 오류가 발생했습니다. 모의 사이트와 브라우저가 실행 중인지 확인하세요.");
  });
  const mockOnly = () => runtime.config?.readOnlyWeb === false && runtime.config.extraAllowedOrigins.length === 0;
  const submissionScope = () => runtime.config?.directActions === true && !mockOnly() ? "user-requested" : "practice-only";
  app.get("/api/health", () => {
    const { stt, tts } = audio;
    return Response.json({
      ok: true, llmProvider: runtime.intentProvider.name, llmRoles: runtime.llmRoles(), welfareData: runtime.welfareProvider.mode,
      datasets: runtime.openData?.statuses ?? [], workspaceAvailable: workflows.personal, directActions: runtime.config?.directActions === true,
      stt: { provider: stt.name, supported: stt.supported, localLanguages: [], liveModel: stt.live?.model ?? null },
      tts: { provider: tts.name, supported: tts.supported }, voiceEdge: stt.edgeModel ?? null, mockOnly: mockOnly(),
      submissionScope: submissionScope(), practiceMode: runtime.config?.practiceMode ?? true,
      voiceSpeed: tts.speed ?? runtime.settings?.preferences.speed ?? runtime.config?.voice.ttsSpeed,
      setupRequired: runtime.settings !== undefined && !runtime.settings.completed, settingsAvailable: runtime.settings !== undefined,
      firstRun: runtime.settings?.firstRun ?? "done", recoveryAvailable: recoveryAvailable(),
    });
  });
  const noSettings = () => error(404, "NO_SETTINGS", "이 실행 환경에는 이용 설정이 없습니다.");
  app.get("/api/settings", () => {
    const store = runtime.settings;
    return store === undefined ? noSettings() : Response.json({ ...store.preferences, sharedDevice: runtime.config?.pilotProfile === "shared",
      hasKey: audio.stt.supported, loadError: store.loadError, regions: [...new Set(Object.values(CTPV))], browserFallback: runtime.browserFallback ?? false });
  });
  app.post("/api/settings/check-key", async c => {
    const key = SettingsInput.safeParse({ apiKey: (await jsonBody(c.req.raw))?.apiKey }).data?.apiKey;
    if (key === undefined || key === "") return error(400, "INVALID_SETTINGS", "API 키를 확인해 주세요.");
    return Response.json({ result: await checkOpenaiKey(key, runtime.config?.voice.baseUrl ?? OPENAI_BASE_URL, { fetch: runtime.fetcher }) });
  });
  app.post("/api/settings", async c => {
    const store = runtime.settings;
    if (store === undefined) return noSettings();
    const values = SettingsInput.safeParse(await jsonBody(c.req.raw)).data;
    if (values === undefined) return error(400, "INVALID_SETTINGS", "API 키, 언어, 시·도와 속도를 확인해 주세요.");
    if (values.apiKey === "" && !audio.stt.supported) return error(400, "KEY_REQUIRED", "OpenAI API 키를 입력해 주세요.");
    if (runtime.config?.pilotProfile === "shared") { values.deviceUse = "shared"; values.rememberService = false; }
    const previous = store.preferences;
    try { store.save(values); }
    catch { return error(503, "SETTINGS_STORAGE", "이 PC에 설정을 저장할 수 없어요. 계정의 자격 증명 저장소와 폴더 권한을 확인해 주세요."); }
    runtime.refreshServices?.();
    await workflows.reconfigure();
    for (const s of sessions.values()) {
      workflows.bind(s);
      s.stageSettings(runtime.sessionModels?.() ?? {}, { language: values.language === previous.language ? undefined : values.language,
        region: values.region === previous.region ? undefined : values.region });
    }
    return Response.json({ saved: true });
  });
  app.post("/api/personal/guardian", async c => {
    const store = runtime.personalStore?.();
    if (store === undefined) return error(409, "NOT_PERSONAL", "개인 PC로 설정했을 때만 보호자 연락처를 저장할 수 있어요.");
    const body = await jsonBody(c.req.raw) ?? {};
    const name = validText(body.name, 20);
    const phone = typeof body.phone === "string" ? body.phone.replace(/[^\p{Nd}]/gu, "") : "";
    if (name === undefined || !isMobile(phone)) return error(400, "INVALID_GUARDIAN", "보호자 이름과 휴대전화 번호를 확인해 주세요.");
    store.setGuardian({ name, phone });
    return Response.json({ saved: true });
  });
  app.post("/api/session", async c => {
    if (runtime.settings !== undefined && !runtime.settings.completed) return error(409, "SETUP_REQUIRED", "먼저 청음 이용 설정을 저장해 주세요.");
    const body = await jsonBody(c.req.raw);
    if (body === undefined || Object.entries(body).some(([key, value]) => !["recovery", "attached"].includes(key) || typeof value !== "boolean")) {
      return error(400, "BAD_REQUEST", "세션 설정을 확인해 주세요.");
    }
    if (body.recovery === true && !recoveryAvailable()) {
      return error(403, "RECOVERY_UNAVAILABLE", "확인된 개인 프로필에서만 작업 복구를 켤 수 있어요.");
    }
    return await sessions.creating.run(async () => {
      if (sessions.closed) throw new Error("Session store is closed");
      if (sessions.size >= MAX_SESSIONS) return error(409, "SESSION_LIMIT", "열린 세션이 세 개예요. 사용 중인 탭에서 먼저 이용을 종료해 주세요.");
      const s = await runtime.createSession();
      workflows.bind(s);
      sessions.add(s);
      const lease = body.recovery === true ? sessions.enable(s.id) : undefined;
      if (body.attached === true && lease === undefined) sessions.keepEphemeral(s.id);
      return Response.json({
        sessionId: s.id, state: s.state, llmProvider: runtime.intentProvider.name, mockOnly: mockOnly(), submissionScope: submissionScope(),
        consentRequired: s.consentStatus !== "granted", speechPrefs: s.snapshot().speechPrefs, lang: s.lang,
        firstRunPrompt: s.consentStatus === "granted" ? s.firstRun.offer({ reviewNames: !s.deps.web.guard.directActions }) : undefined,
        firstStartupGuide: s.consentStatus === "pending" ? runtime.settings?.claimStartupGuide() ?? null : null, ...lease?.credentials(),
      });
    });
  });
  app.post("/api/session/recover", async c => {
    if (!recoveryAvailable()) return noSession();
    const { token, attempt } = await jsonBody(c.req.raw) ?? {};
    if (typeof token !== "string" || token.length !== 43 || /[^\x00-\x7f]/u.test(token) ||
        typeof attempt !== "string" || attempt.length !== 36 || /[^\x00-\x7f]/u.test(attempt)) return error(400, "BAD_REQUEST", "복구 정보를 확인해 주세요.");
    try {
      const recovered = sessions.recover(token, attempt);
      if (recovered === undefined) return noSession();
      const [sid, lease] = recovered;
      return Response.json({ sessionId: sid, checkpoint: lease.checkpoint, ...lease.credentials() });
    } catch (e) {
      if (e instanceof RequestConflict) return error(409, "SESSION_WRITER_ACTIVE", "이전 연결에서 작업을 제어하고 있어요.");
      throw e;
    }
  });
  app.post("/api/session/:sid/resume", async c => {
    const s = byId(c, true);
    if (s instanceof Response) return s;
    const lease = sessions.leases.get(s.id);
    const notWaiting = () => error(409, "RECOVERY_NOT_WAITING", "연결할 작업이 없어요.");
    if (lease === undefined) return notWaiting();
    const writer = lease.writer;
    return await once(s, c, Buffer.from("resume"), async () => {
      if (!lease.waiting) return notWaiting();
      const result = await s.resumeForRecovery(isRecord(lease.checkpoint) ? lease.checkpoint : {});
      if (sessions.leases.get(s.id) !== lease || lease.writer !== writer) return writerRequired();
      if ("interrupted" in result && result.interrupted === true) {
        sessions.remove(s.id); await s.close();
        return error(410, "BROWSER_INTERRUPTED", "이전 브라우저가 닫혔어요. 새 작업을 시작해 주세요.");
      }
      lease.waiting = false; lease.checkpoint = undefined; lease.previous = undefined;
      return Response.json(result);
    });
  });
  app.get("/api/session/:sid/heartbeat", c => {
    const s = byId(c, true);
    return s instanceof Response ? s : Response.json({ ok: true });
  });
  app.post("/api/session/:sid/detach", c => {
    const s = byId(c, true);
    if (s instanceof Response) return s;
    sessions.detach(s.id);
    return Response.json({ ok: true });
  });
  app.post("/api/turn", async c => {
    const body = await jsonBody(c.req.raw) ?? {};
    const text = validText(body.text, 500);
    if (typeof body.sessionId !== "string" || body.sessionId.length === 0 || text === undefined || (body.clientPlatform !== undefined && body.clientPlatform !== "pc")) {
      return error(400, "BAD_REQUEST", "sessionId와 text(1~500자)가 필요합니다.");
    }
    const s = access(body.sessionId, c);
    if (s instanceof Response) return s;
    const supplied = body.actionId;
    if (supplied != null && typeof supplied !== "string") return error(400, "BAD_REQUEST", "actionId는 문자열이어야 합니다.");
    if (isStopUtterance(redactText(text))) return Response.json(await s.handleTurn(text));
    const action = inputAction(s, supplied ?? undefined);
    return await once(s, c, Buffer.from(JSON.stringify(["turn", text, supplied ?? null])), async () => Response.json(await s.handleTurn(text, { approvalId: action })));
  });
  app.get("/api/session/:sid/state", c => { const s = byId(c); return s instanceof Response ? s : Response.json(s.snapshot()); });
  app.get("/api/session/:sid/research-outcomes", c => {
    const s = byId(c);
    return s instanceof Response ? s : c.json(s.researchReceipts());
  });
  app.delete("/api/session/:sid/research-outcomes/:turnId", c => {
    const s = byId(c);
    if (s instanceof Response) return s;
    s.acknowledgeResearch(c.req.param("turnId"));
    return c.json({ok: true});
  });
  app.post("/api/session/:sid/wake", async c => {
    const generation = (await jsonBody(c.req.raw))?.stopGeneration;
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) return error(400, "BAD_REQUEST", "멈춤 요청 번호를 확인해 주세요.");
    const s = byId(c);
    if (s instanceof Response) return s;
    const stale = () => error(409, "STALE_STOP", "다시 멈췄어요. 시작하려면 다시 눌러 주세요.");
    if (generation !== s.generation) return stale();
    const result = await once(s, c, Buffer.from("wake:" + generation), async () =>
      (await s.wake(generation)) === undefined ? stale() : Response.json({ state: s.state }));
    return generation === s.generation ? result : stale();
  });
  app.post("/api/session/:sid/confirm", async c => {
    const { approve, actionId = "" } = await jsonBody(c.req.raw) ?? {};
    if (typeof approve !== "boolean") return error(400, "BAD_REQUEST", "approve(boolean)가 필요합니다.");
    const s = byId(c);
    if (s instanceof Response) return s;
    if (typeof actionId !== "string") return error(400, "BAD_REQUEST", "actionId는 문자열이어야 합니다.");
    return await once(s, c, Buffer.from(JSON.stringify(["confirm", approve, actionId])), async () => Response.json(await s.confirm(approve, actionId)));
  });
  app.post("/api/session/:sid/choice", async c => {
    const { turnId, key, handoffId } = await jsonBody(c.req.raw) ?? {};
    const choice = ChoiceKeySchema.safeParse(key).data;
    if (typeof turnId !== "string" || turnId === "" || choice === undefined || (handoffId != null && typeof handoffId !== "string")) {
      return error(400, "BAD_REQUEST", "turnId와 key가 필요합니다.");
    }
    const s = byId(c);
    if (s instanceof Response) return s;
    return await once(s, c, Buffer.from(JSON.stringify(["choice", turnId, choice, handoffId ?? null])), async () => {
      const result = await s.choose(turnId, choice, handoffId);
      return result === undefined ? error(409, "CHOICE_EXPIRED", "선택지가 바뀌었어요. 지금 안내를 다시 확인해 주세요.") : Response.json(result);
    });
  });
  app.post("/api/session/:sid/consent", async c => {
    const granted = (await jsonBody(c.req.raw))?.granted;
    if (typeof granted !== "boolean") return error(400, "BAD_REQUEST", "granted(boolean)가 필요합니다.");
    const s = byId(c);
    return s instanceof Response ? s : Response.json(await s.consentTo(granted));
  });
  app.get("/api/session/:sid/reminders", c => {
    const s = byId(c);
    return s instanceof Response ? s : Response.json({ text: s.consentStatus === "granted" ? s.reminders() ?? null : null });
  });
  app.get("/api/session/:sid/progress", c => { const s = byId(c); return s instanceof Response ? s : Response.json(s.progress.snapshot()); });
  app.post("/api/session/:sid/language", async c => {
    const lang = LangSchema.safeParse((await jsonBody(c.req.raw))?.lang).data;
    if (lang === undefined) return error(400, "BAD_REQUEST", "lang은 ko, en, zh, ja 중 하나입니다.");
    const s = byId(c);
    return s instanceof Response ? s : Response.json(await s.setLanguage(lang));
  });
  app.post("/api/session/:sid/cancel", async c => {
    const s = byId(c, true);
    if (s instanceof Response) return s;
    const result = await s.cancel();
    const lease = sessions.leases.get(s.id);
    if (lease?.waiting === true) {
      lease.checkpoint = s.detachForRecovery();
      return Response.json({ ...result, stopGeneration: s.generation });
    }
    return Response.json(result);
  });
  app.delete("/api/session/:sid", async c => {
    const s = byId(c, true);
    if (s instanceof Response) return s;
    sessions.remove(s.id); await s.close();
    return Response.json({ ok: true });
  });

  const sessionId = (c: Context) => c.req.queries("sessionId")?.at(-1) ?? "";
  const consentRequired = () => error(403, "CONSENT_REQUIRED", "먼저 시작 안내에 동의해 주세요.");
  app.post("/api/audio/turn", async c => {
    const sid = sessionId(c);
    const s = access(sid, c);
    if (s instanceof Response) return s;
    if (s.consentStatus !== "granted") return consentRequired();
    const req = c.req.raw;
    const supplied = c.req.header("x-cheongeum-action");
    const action = inputAction(s, supplied);
    const mimeType = req.headers.get("content-type") ?? "";
    const bytes = await limitedBytes(req, mimeType.split(";")[0]?.trim() === "application/json" ? JSON_LIMIT : AUDIO_LIMIT);
    if (bytes === undefined) return error(413, "BODY_TOO_LARGE", "녹음 길이를 줄여 주세요.");
    const current = access(sid, c);
    if (current instanceof Response) return current;
    const ledger = sessions.ledgers.get(sid), generation = s.generation;
    const payload = Buffer.concat([Buffer.from(JSON.stringify(["audio", mimeType, supplied ?? null])), Buffer.of(0), bytes]);
    return await once(s, c, payload, async () => {
      let text: string;
      try { text = turnTranscript(await transcribe(req, s.lang, bytes, sid)); }
      catch (e) { return voiceError(e); }
      if (sessions.ledgers.get(sid) !== ledger) return writerRequired();
      if (text === "") return error(422, "EMPTY_TRANSCRIPT", s.missedSpeechHint());
      if (s.generation !== generation && !isStopUtterance(redactText(text))) return error(409, "REQUEST_CONFLICT", "멈춤 전에 시작한 음성 요청을 취소했어요.");
      return Response.json(await s.handleTurn(text, { approvalId: action, fromVoice: true }));
    });
  });
  app.post("/api/audio/stop", async c => {
    const sid = sessionId(c), s = access(sid, c);
    if (s instanceof Response) return s;
    if (s.consentStatus !== "granted") return consentRequired();
    const ledger = sessions.ledgers.get(sid);
    let text: string;
    try { text = await transcribe(c.req.raw, s.lang, undefined, sid); }
    catch (e) { return voiceError(e); }
    if (sessions.ledgers.get(sid) !== ledger) return writerRequired();
    const safe = redactText(text, (await runtime.scanner?.scan([text]))?.[0]);
    if (isStopUtterance(safe)) return Response.json({ stopped: true, result: await s.handleTurn(turnTranscript(text)) });
    if (isProgressQuestion(safe)) return Response.json({ stopped: false, result: await s.handleTurn(strip(safe)) });
    return Response.json({ stopped: false });
  });
  async function recording(c: Context) {
    const sid = sessionId(c), s = access(sid, c);
    if (s instanceof Response) return s;
    const permitted = () => s.consentStatus === "granted" && s.state !== "AUTH_HANDOFF" && s.state !== "STOPPED";
    if (!permitted()) return error(403, "CONSENT_REQUIRED", "녹음 파일을 보내려면 대화를 시작하고 동의해 주세요.");
    const ledger = sessions.ledgers.get(sid), generation = s.generation;
    const current = () => sessions.ledgers.get(sid) === ledger && s.generation === generation && permitted();
    const cancelled = () => error(409, "REQUEST_CONFLICT", "녹음 요청이 취소되었습니다.");
    const bytes = await limitedBytes(c.req.raw, AUDIO_LIMIT);
    if (bytes === undefined) return error(413, "BODY_TOO_LARGE", "10 MiB 이하인 녹음 파일을 선택해 주세요.");
    if (!current()) return cancelled();
    try {
      const text = await transcribe(c.req.raw, s.lang, bytes, "");
      if (!current()) return cancelled();
      if (text === "") return error(422, "EMPTY_TRANSCRIPT", s.missedSpeechHint());
      const spans = (await runtime.scanner?.scan([text]))?.[0];
      if (!current()) return cancelled();
      return Response.json({ text: redactText(text, spans), secretDetected: detectSensitive(text, spans).hasSecretValue, provider: audio.stt.name });
    } catch (e) { return voiceError(e); }
  }
  app.post("/api/audio/transcribe", recording);
  app.post("/api/audio/recording", recording);
  const socketDeps = { audio, sessions, accessWriter, port: options.port, voiceError: voiceFailureBody };
  app.get("/api/presentation", refuseForeignOrigin(options.port, requestHeaders), upgradeWebSocket(() => presentation.connect()));
  live.register(app, upgradeWebSocket, socketDeps, requestHeaders);
  (options.voiceEdge ?? new VoiceEdge()).register(app, upgradeWebSocket, socketDeps, requestHeaders);
  registerWorkflows(app, workflows, access, c => jsonBody(c.req.raw));
  app.post("/api/audio/speak", async (c) => {
    const body = await jsonBody(c.req.raw) ?? {};
    const text = validText(body.text, 1000);
    const lang = LangSchema.safeParse(body.lang ?? "ko").data;
    if (text === undefined || lang === undefined) return error(400, "BAD_REQUEST", "text(1~1000자)가 필요합니다.");
    try {
      const pace = typeof body.absoluteSpeed === "number" && body.absoluteSpeed >= 0.5 && body.absoluteSpeed <= 2
        ? body.absoluteSpeed / (audio.tts.speed ?? VOICE_PROFILE.speed) : speechPace(body.rate);
      const out = await audio.tts.synthesize(text, { language: lang, pace, signal: c.req.raw.signal });
      return new Response(Uint8Array.from(out.audio), { headers: { "content-type": out.mimeType } });
    } catch (e) {
      return voiceError(e);
    }
  });
  app.get("/api/events", () => Response.json({ events: [...runtime.events.all(), ...workflows.events.all()] }));
  app.get("/api/welfare/services", async (c) =>
    Response.json({
      mode: runtime.welfareProvider.mode,
      services: await runtime.welfareProvider.listServices(c.req.queries("q")?.at(-1) ?? ""),
    }),
  );
  if (options.web === true) {
    const files = staticFiles(webStatic);
    app.use("*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) return next();
      return files(c, next);
    });
  }
  app.notFound(fallback);
  return Object.assign(app, { sessions, workflows, presentation });
}
