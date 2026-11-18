import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { WebExecutionAgent } from "../agents/web/agent.ts";
import { launchBrowser, launchChromeProfile, PlaywrightExecutionAdapter } from "../agents/web/browser/index.ts";
import { DownloadStore } from "../agents/web/downloads.ts";
import { createMockWelfareProfile, fieldVocabulary } from "../agents/web/profile.ts";
import { WelfareInformationAgent } from "../agents/welfare/agent.ts";
import { createWelfareDataProvider } from "../agents/welfare/data/index.ts";
import { REPO_ROOT } from "../core/assets.ts";
import { InMemoryEventLog } from "../core/events.ts";
import { createStructuredLlm, overlayLlm, type LlmConfig } from "../core/llm.ts";
import { omitAbsent } from "../core/schema.ts";
import { strip } from "../core/text.ts";
import { parseUrl } from "../core/url.ts";
import { SessionOrchestrator } from "../orchestrator/session.ts";
import { ActionLog } from "../personal/action_log.ts";
import { Seal } from "../personal/seal.ts";
import { PersonalStore } from "../personal/store.ts";
import { PolicyGuard } from "../safety/guard.ts";
import { PiiModel, PiiScanner } from "../safety/pii_model.ts";
import { createIntentProvider } from "../understanding/llm_planner.ts";
import { createVoiceProviders, type VoiceConfig } from "../voice/config.ts";
import type { SttProvider } from "../voice/stt.ts";
import type { TtsProvider } from "../voice/tts.ts";

type Env = Record<string, string | undefined>;
function blank(value: string | undefined) {
  const cleaned = strip(value ?? "");
  return cleaned.length === 0 ? undefined : cleaned;
}
function fallback(value: string | undefined, defaultValue: string) {
  return value === undefined || value.length === 0 ? defaultValue : value;
}
function decimal(value: string | undefined) {
  const text = blank(value);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}
function localPath(value: string | undefined) {
  const path = blank(value);
  if (path === undefined) return undefined;
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(REPO_ROOT, path);
}

export function loadConfig(env: Env = process.env) {
  const headless = env.HEADLESS === "true" || env.HEADLESS === "1";
  const speed = decimal(env.TTS_SPEED);
  const llm: LlmConfig = omitAbsent({
    provider: fallback(env.LLM_PROVIDER, "mock"),
    model: blank(env.LLM_MODEL),
    baseUrl: blank(env.LLM_BASE_URL),
    apiKey: blank(env.LLM_API_KEY),
    reasoningEffort: blank(env.LLM_REASONING_EFFORT),
  });
  const role = (name: string) => {
    const entry = (key: string) => blank(env["LLM_" + name + "_" + key]);
    return overlayLlm(llm, {
      provider: entry("PROVIDER"),
      model: entry("MODEL"),
      baseUrl: entry("BASE_URL"),
      apiKey: entry("API_KEY"),
      reasoningEffort: entry("REASONING_EFFORT"),
    });
  };
  const voice: VoiceConfig = omitAbsent({
    stt: fallback(env.STT_PROVIDER, "mock"),
    tts: fallback(env.TTS_PROVIDER, "mock"),
    apiKey: blank(env.VOICE_API_KEY) ?? blank(env.LLM_API_KEY),
    baseUrl: blank(env.VOICE_BASE_URL),
    sttBaseUrl: blank(env.STT_BASE_URL),
    sttModel: blank(env.STT_MODEL),
    sttLocalModel: localPath(env.STT_LOCAL_MODEL),
    sttLocalThreads: Math.trunc(decimal(env.STT_LOCAL_THREADS) ?? 0),
    sttLocalBeam: Math.trunc(decimal(env.STT_LOCAL_BEAM) ?? 1),
    sttLocalPrompt: env.STT_LOCAL_PROMPT === "true" || env.STT_LOCAL_PROMPT === "1",
    ttsModel: blank(env.TTS_MODEL),
    ttsVoice: blank(env.TTS_VOICE),
    ttsInstructions: blank(env.TTS_INSTRUCTIONS),
    ttsSpeed: speed !== undefined && speed > 0 ? Math.min(4, Math.max(0.25, speed)) : undefined,
  });
  const threshold = decimal(env.PII_THRESHOLD);
  const extraAllowedOrigins = (env.EXTRA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(strip)
    .filter((v) => v.length > 0)
    .map((v) => parseUrl(v).origin);
  return omitAbsent({
    mockSiteUrl: fallback(env.MOCK_SITE_URL, "http://localhost:5174"),
    extraAllowedOrigins,
    headless,
    slowMoMs: Math.trunc(decimal(env.BROWSER_SLOWMO_MS) ?? 0),
    requireConsent: env.REQUIRE_CONSENT !== "false",
    practiceMode: env.PRACTICE_MODE !== "false",
    dataDir: blank(env.CHEONGEUM_DATA_DIR),
    browserMode: env.BROWSER_MODE === "chrome" ? ("chrome" as const) : ("chromium" as const),
    chromeProfileDir: blank(env.CHROME_PROFILE_DIR) ?? join(homedir(), ".cheongeum", "chrome-profile"),
    readOnlyWeb: env.READ_ONLY_WEB !== "false",
    readOnlyClicks:
      strip(fallback(env.READ_ONLY_CLICKS, "any")).toLowerCase() === "any" ? ("any" as const) : ("safe" as const),
    searchUrlTemplate: blank(env.WEB_SEARCH_URL),
    visualCursor:
      env.VISUAL_CURSOR === undefined || env.VISUAL_CURSOR === "" ? !headless : env.VISUAL_CURSOR === "true",
    llm,
    llmUnderstand: role("UNDERSTAND"),
    llmGoal: role("GOAL"),
    llmWeb: role("WEB"),
    voice,
    welfareApiKey: env.WELFARE_DATA_MODE === "official-api" ? blank(env.WELFARE_API_KEY) : undefined,
    welfareApiBaseUrl: blank(env.WELFARE_API_BASE_URL),
    piiModel: localPath(env.PII_MODEL),
    piiThreshold: threshold === undefined || threshold === 0 ? 0.5 : threshold,
  });
}
export type RuntimeConfig = ReturnType<typeof loadConfig>;

export class AgentRuntime {
  readonly config: RuntimeConfig;
  readonly profile;
  readonly welfareProvider;
  readonly intentProvider;
  readonly answerLlm;
  readonly understandLlm;
  readonly goalLlm;
  readonly events = new InMemoryEventLog();
  readonly scanner: PiiScanner;
  readonly stt: SttProvider;
  readonly tts: TtsProvider;
  private readonly pii?: PiiModel;
  private personal?: PersonalStore;
  private actionLog?: ActionLog;
  private browser?: Promise<Browser>;
  private chrome?: Promise<BrowserContext>;
  private closed = false;

  static async create(config: RuntimeConfig, fetcher: typeof fetch = fetch) {
    const [stt, tts] = await createVoiceProviders(config.voice, fetcher);
    return new AgentRuntime(config, stt, tts, fetcher);
  }
  constructor(config: RuntimeConfig, stt: SttProvider, tts: TtsProvider, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.stt = stt;
    this.tts = tts;
    this.profile = createMockWelfareProfile(config.mockSiteUrl);
    this.welfareProvider = createWelfareDataProvider({
      apiKey: config.welfareApiKey,
      apiBaseUrl: config.welfareApiBaseUrl,
      fetchImpl: fetcher,
    });
    this.intentProvider = createIntentProvider(config.llmUnderstand, fieldVocabulary(this.profile), fetcher);
    this.answerLlm = createStructuredLlm(config.llmWeb, fetcher);
    this.understandLlm = createStructuredLlm(config.llmUnderstand, fetcher);
    this.goalLlm = createStructuredLlm(config.llmGoal, fetcher);
    if (config.piiModel !== undefined && PiiModel.available(config.piiModel))
      this.pii = new PiiModel(config.piiModel, config.piiThreshold);
    this.scanner = new PiiScanner(this.pii);
  }
  get allowedOrigins() {
    return [this.profile.origin, ...this.config.extraAllowedOrigins];
  }
  llmRoles() {
    const base = createStructuredLlm(this.config.llm)?.name;
    return {
      default: base ?? "rules",
      understand: this.understandLlm?.name ?? this.intentProvider.name,
      goal: this.goalLlm?.name ?? base ?? this.intentProvider.name,
      web: this.answerLlm?.name ?? base ?? this.intentProvider.name,
    };
  }
  private getBrowser() {
    this.browser ??= launchBrowser(this.config.headless, this.config.slowMoMs)
      .then((b) => {
        b.once("disconnected", () => {
          this.browser = undefined;
        });
        return b;
      })
      .catch((err: unknown) => {
        this.browser = undefined;
        throw err;
      });
    return this.browser;
  }
  private getChrome() {
    this.chrome ??= launchChromeProfile(this.config.chromeProfileDir, this.config.slowMoMs)
      .then((c) => {
        c.once("close", () => {
          this.chrome = undefined;
        });
        return c;
      })
      .catch((err: unknown) => {
        this.chrome = undefined;
        throw err;
      });
    return this.chrome;
  }
  async createSession(): Promise<SessionOrchestrator> {
    if (this.closed) throw new Error("Runtime is closed");
    const cfg = this.config;
    if (this.personal === undefined) {
      if (cfg.dataDir === undefined) this.personal = new PersonalStore();
      else {
        const seal = new Seal();
        this.actionLog = new ActionLog(join(cfg.dataDir, "actions.sealed"), seal);
        this.personal = new PersonalStore(join(cfg.dataDir, "personal.json"), seal);
      }
    }
    const downloads = new DownloadStore(cfg.dataDir === undefined ? undefined : join(cfg.dataDir, "downloads"));
    const shared = cfg.browserMode === "chrome";
    const adapter = new PlaywrightExecutionAdapter({
      ...(shared ? { context: await this.getChrome() } : { browser: await this.getBrowser() }),
      allowedOrigins: this.allowedOrigins,
      readOnlyWeb: cfg.readOnlyWeb,
      visualCursor: cfg.visualCursor,
      downloads,
    });
    try {
      await adapter.start();
      if (this.closed) throw new Error("Runtime is closed");
      const profile = this.profile;
      const guard = new PolicyGuard({
        allowedOrigins: this.allowedOrigins,
        allowedActionTypes: [
          "navigate",
          "back",
          "click",
          "fill",
          "press",
          "select",
          "check",
          "read",
          "focus",
          "scroll",
        ],
        allowedFieldIds: profile.fields.filter((f) => f.sensitivity !== "secret").map((f) => f.fieldId),
        secretFieldIds: profile.fields.filter((f) => f.sensitivity === "secret").map((f) => f.fieldId),
        maxActionsPerTurn: 12,
        safeButtons: [profile.buttons.next, profile.buttons.prev, ...profile.buttons.dismissDialog],
        readOnlyWeb: cfg.readOnlyWeb,
        readOnlyClicks: cfg.readOnlyClicks,
      });
      const session = new SessionOrchestrator({
        intentProvider: this.intentProvider,
        web: new WebExecutionAgent(adapter, guard, profile, this.actionLog),
        welfare: new WelfareInformationAgent(this.welfareProvider, this.answerLlm),
        events: this.events,
        requireConsent: cfg.requireConsent,
        practiceMode: cfg.practiceMode,
        personal: this.personal,
        actionLog: this.actionLog,
        llm: this.understandLlm ?? this.answerLlm,
        goalLlm: this.goalLlm ?? this.answerLlm,
        webLlm: this.answerLlm,
        scanner: this.scanner,
        searchUrlTemplate: cfg.searchUrlTemplate,
        downloads,
        sharedBrowser: shared,
      });
      if (!cfg.requireConsent) await session.prepare();
      return session;
    } catch (e) {
      await adapter.close();
      throw e;
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([
      this.chrome?.then((c) => c.close()),
      this.browser?.then((b) => b.close()),
      this.pii?.close(),
      this.stt.close?.(),
    ]);
  }
}
