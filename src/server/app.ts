import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, webStatic } from "../core/assets.ts";
import { strip } from "../core/text.ts";
import { LangSchema, LANGS } from "../core/turn.ts";
import type { SessionOrchestrator } from "../orchestrator/session.ts";
import { redactText, detectSensitive } from "../safety/privacy.ts";
import { isStopUtterance, isProgressQuestion } from "../understanding/rules.ts";
import { VoiceNotSupportedError } from "../voice/errors.ts";
import type { SttProvider } from "../voice/stt.ts";
import type { TtsProvider } from "../voice/tts.ts";
import type { AgentRuntime } from "./runtime.ts";

export const MAX_SESSIONS = 3;
export const JSON_LIMIT = 16 * 1024;
export const AUDIO_LIMIT = 10 * 1024 * 1024;
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'";

export type HttpSession = Pick<
  SessionOrchestrator,
  | "id"
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
  | "cancel"
  | "close"
>;
export interface HttpRuntime<S extends HttpSession = HttpSession> {
  createSession(): Promise<S>;
  llmRoles(): Record<string, string>;
  intentProvider: { name: string };
  welfareProvider: Pick<AgentRuntime["welfareProvider"], "mode" | "listServices">;
  events: Pick<AgentRuntime["events"], "all">;
  scanner?: Pick<AgentRuntime["scanner"], "scan">;
  stt: SttProvider;
  tts: TtsProvider;
}

export class Sessions<S extends HttpSession = HttpSession> {
  private readonly items = new Map<string, S>();
  private pending = Promise.resolve();
  private closed = false;
  get(id: string) {
    return this.items.get(id);
  }
  get size() {
    return this.items.size;
  }

  create(build: () => Promise<S>): Promise<S> {
    const operation = this.pending.then(async () => {
      if (this.closed) throw new Error("Session store is closed");
      if (this.items.size >= MAX_SESSIONS) {
        const oldest = this.items.values().next().value;
        if (oldest !== undefined) {
          this.items.delete(oldest.id);
          await oldest.close().catch(() => {});
        }
      }
      const session = await build();
      this.items.set(session.id, session);
      return session;
    });
    this.pending = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  async remove(id: string) {
    const session = this.items.get(id);
    if (session === undefined) return false;
    this.items.delete(id);
    await session.close();
    return true;
  }
  async close() {
    this.closed = true;
    await this.pending;
    const sessions = Array.from(this.items.values());
    this.items.clear();
    await Promise.allSettled(sessions.map((s) => s.close()));
  }
}

function error(status: number, code: string, message: string) {
  return Response.json({ error: code, message }, { status });
}
const noSession = () => error(404, "SESSION_NOT_FOUND", "세션이 없습니다. 새 세션을 시작하세요.");
const missingTurnSession = () => error(404, "SESSION_NOT_FOUND", "세션이 없습니다.");
function voiceError(e: unknown) {
  if (e instanceof VoiceNotSupportedError) return error(501, "NOT_SUPPORTED", e.message);
  return error(502, "VOICE_PROVIDER", "음성 서비스 호출에 실패했습니다. 잠시 후 다시 시도하거나 텍스트로 입력하세요.");
}

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

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await limitedBytes(request, JSON_LIMIT);
  if (bytes === undefined || bytes.length === 0) return {};
  try {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
  options: { stt?: SttProvider; tts?: TtsProvider; web?: boolean; csp?: boolean } = {},
) {
  const app = new Hono();
  const sessions = new Sessions<S>();
  const stt = options.stt ?? runtime.stt;
  const tts = options.tts ?? runtime.tts;
  const byId = (c: Context) => sessions.get(c.req.param("sid") ?? "");
  async function transcribe(request: Request, language = "ko") {
    if (!stt.supported)
      throw new VoiceNotSupportedError(
        "서버 STT가 설정되지 않았습니다. 브라우저 음성 인식이나 텍스트 입력을 사용하세요.",
      );
    const mimeType = request.headers.get("content-type") ?? "audio/webm";
    if (!mimeType.startsWith("audio/") && !mimeType.startsWith("application/octet-stream")) return "";
    const audio = await limitedBytes(request, AUDIO_LIMIT);
    return audio === undefined || audio.length < 200
      ? ""
      : (await stt.transcribe(audio, { language, mimeType, signal: request.signal })).text;
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
      c.header("Content-Security-Policy", CSP);
    });
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "HEAD") return next();
    return fallback(c);
  });
  app.onError((exception) => {
    // Exception messages may contain a spoken value.
    console.error("[server] error", exception.constructor.name);
    return error(500, "INTERNAL", "서버 오류가 발생했습니다. 모의 사이트와 브라우저가 실행 중인지 확인하세요.");
  });
  app.get("/api/health", () =>
    Response.json({
      ok: true,
      llmProvider: runtime.intentProvider.name,
      llmRoles: runtime.llmRoles(),
      welfareData: runtime.welfareProvider.mode,
      stt: {
        provider: stt.name,
        supported: stt.supported,
        localLanguages: stt.supported ? (stt.localLanguages ?? (stt.name.startsWith("local(") ? LANGS : [])) : [],
      },
      tts: { provider: tts.name, supported: tts.supported },
      mockOnly: true,
    }),
  );
  app.post("/api/session", async () => {
    const s = await sessions.create(() => runtime.createSession());
    return Response.json({
      sessionId: s.id,
      state: s.state,
      llmProvider: runtime.intentProvider.name,
      mockOnly: true,
      consentRequired: s.consentStatus !== "granted",
      speechPrefs: s.snapshot().speechPrefs,
    });
  });
  app.post("/api/turn", async (c) => {
    const body = await jsonBody(c.req.raw);
    const text = validText(body.text, 500);
    if (
      typeof body.sessionId !== "string" ||
      body.sessionId.length === 0 ||
      text === undefined ||
      (body.clientPlatform !== undefined && body.clientPlatform !== "pc")
    ) {
      return error(400, "BAD_REQUEST", "sessionId와 text(1~500자)가 필요합니다.");
    }
    const s = sessions.get(body.sessionId);
    return s === undefined ? missingTurnSession() : Response.json(await s.handleTurn(text));
  });
  app.get("/api/session/:sid/state", (c) => {
    const s = byId(c);
    return s === undefined ? noSession() : Response.json(s.snapshot());
  });
  app.post("/api/session/:sid/confirm", async (c) => {
    const { approve } = await jsonBody(c.req.raw);
    if (typeof approve !== "boolean") return error(400, "BAD_REQUEST", "approve(boolean)가 필요합니다.");
    const s = byId(c);
    return s === undefined ? noSession() : Response.json(await s.confirm(approve));
  });
  app.post("/api/session/:sid/consent", async (c) => {
    const { granted } = await jsonBody(c.req.raw);
    if (typeof granted !== "boolean") return error(400, "BAD_REQUEST", "granted(boolean)가 필요합니다.");
    const s = byId(c);
    return s === undefined ? noSession() : Response.json(await s.consentTo(granted));
  });
  app.get("/api/session/:sid/reminders", (c) => {
    const s = byId(c);
    return s === undefined
      ? noSession()
      : Response.json({ text: s.consentStatus === "granted" ? (s.reminders() ?? null) : null });
  });
  app.get("/api/session/:sid/progress", (c) => {
    const s = byId(c);
    return s === undefined ? noSession() : Response.json(s.progress.snapshot());
  });
  app.post("/api/session/:sid/language", async (c) => {
    const lang = LangSchema.safeParse((await jsonBody(c.req.raw)).lang).data;
    if (lang === undefined) return error(400, "BAD_REQUEST", "lang은 ko, en, zh, ja 중 하나입니다.");
    const s = byId(c);
    return s === undefined ? noSession() : Response.json(await s.setLanguage(lang));
  });
  app.post("/api/session/:sid/cancel", async (c) => {
    const s = byId(c);
    return s === undefined ? noSession() : Response.json(await s.cancel());
  });
  app.delete("/api/session/:sid", async (c) =>
    (await sessions.remove(c.req.param("sid"))) ? Response.json({ ok: true }) : noSession(),
  );

  async function voiceTurn(c: Context, busy: boolean) {
    const session = sessions.get(c.req.queries("sessionId")?.at(-1) ?? "");
    if (session === undefined) return missingTurnSession();
    if (session.consentStatus !== "granted") return error(403, "CONSENT_REQUIRED", "먼저 시작 안내에 동의해 주세요.");
    let text: string;
    try {
      text = await transcribe(c.req.raw, session.lang);
    } catch (e) {
      return voiceError(e);
    }
    const utterance = Array.from(text).slice(0, 500).join("");
    if (busy) {
      const spans = (await runtime.scanner?.scan([text]))?.[0];
      const safe = redactText(text, spans);
      if (isStopUtterance(safe)) return Response.json({ stopped: true, result: await session.handleTurn(utterance) });
      if (isProgressQuestion(safe))
        return Response.json({ stopped: false, result: await session.handleTurn(utterance) });
      return Response.json({ stopped: false });
    }
    if (text.length === 0) return error(422, "EMPTY_TRANSCRIPT", "말씀을 알아듣지 못했습니다. 다시 말씀해 주세요.");
    return Response.json(await session.handleTurn(utterance));
  }
  app.post("/api/audio/turn", (c) => voiceTurn(c, false));
  app.post("/api/audio/stop", (c) => voiceTurn(c, true));
  app.post("/api/audio/transcribe", async (c) => {
    try {
      const text = await transcribe(c.req.raw);
      const spans = (await runtime.scanner?.scan([text]))?.[0];
      return Response.json({
        text: redactText(text, spans),
        secretDetected: detectSensitive(text, spans).hasSecretValue,
        provider: stt.name,
      });
    } catch (e) {
      return voiceError(e);
    }
  });
  app.post("/api/audio/speak", async (c) => {
    const body = await jsonBody(c.req.raw);
    const text = validText(body.text, 1000);
    const lang = LangSchema.safeParse(body.lang ?? "ko").data;
    if (text === undefined || lang === undefined) return error(400, "BAD_REQUEST", "text(1~1000자)가 필요합니다.");
    try {
      const out = await tts.synthesize(text, { language: lang, signal: c.req.raw.signal });
      return new Response(Uint8Array.from(out.audio), { headers: { "content-type": out.mimeType } });
    } catch (e) {
      return voiceError(e);
    }
  });
  app.get("/api/events", () => Response.json({ events: runtime.events.all() }));
  app.get("/api/welfare/services", async (c) =>
    Response.json({
      mode: runtime.welfareProvider.mode,
      services: await runtime.welfareProvider.listServices(c.req.queries("q")?.at(-1) ?? ""),
    }),
  );
  if (options.web === true) {
    const built = join(REPO_ROOT, "dist/web");
    const root = existsSync(join(built, "index.html")) ? built : webStatic;
    const files = staticFiles(root);
    app.use("*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) return next();
      return files(c, next);
    });
  }
  app.notFound(fallback);
  return Object.assign(app, { sessions });
}
