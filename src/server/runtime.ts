import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { openControllerWindow } from "./controller_window.ts";
import { WebExecutionAgent } from "../agents/web/agent.ts";
import { closeLaunchedBrowser, launchBrowser, launchChromeProfile, PlaywrightExecutionAdapter } from "../agents/web/browser/index.ts";
import { browserDriver } from "../agents/web/browser/stagehand_browser.ts";
import { DownloadStore } from "../agents/web/downloads.ts";
import { createMockWelfareProfile, fieldVocabulary } from "../agents/web/profile.ts";
import { WelfareInformationAgent } from "../agents/welfare/agent.ts";
import { OpenData } from "../agents/welfare/open_data/index.ts";
import type { OrchestratorDeps } from "../orchestrator/session.ts";
import { createWelfareDataProvider } from "../agents/welfare/data/index.ts";
import { REPO_ROOT } from "../core/assets.ts";
import { InMemoryEventLog } from "../core/events.ts";
import { ModelConnections, OPENAI_BASE_URL, createStructuredLlm, createVisionLlm, overlayLlm, type LlmConfig } from "../core/llm.ts";
import { EmbeddingService, ModerationService, STACK } from "../core/model_stack.ts";
import { guardianSender } from "../personal/guardian.ts";
import type { SettingsStore } from "./settings.ts";
import { TavilySearch } from "./public_search.ts";
import { safeInput } from "./workflows.ts";
import { omitAbsent } from "../core/schema.ts";
import { strip, textOr } from "../core/text.ts";
import { parseUrl } from "../core/url.ts";
import { SessionOrchestrator, withContext } from "../orchestrator/session.ts";
import { ActionLog } from "../personal/action_log.ts";
import { Seal } from "../personal/seal.ts";
import { PersonalStore } from "../personal/store.ts";
import { PolicyGuard } from "../safety/guard.ts";
import { PiiModel, PiiScanner } from "../safety/pii_model.ts";
import { createIntentProvider } from "../understanding/llm_planner.ts";
import { createVoiceProviders, VOICE_DEFAULTS, type VoiceConfig } from "../voice/config.ts";
import type { SttProvider } from "../voice/stt.ts";
import type { TtsProvider } from "../voice/tts.ts";

type Env = Record<string, string | undefined>;
function blank(value: string | undefined) {
  const cleaned = strip(value ?? "");
  return cleaned.length === 0 ? undefined : cleaned;
}
function decimal(value: string | undefined) {
  const text = blank(value);
  if (text === undefined) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}
function localPath(root: string, value: string | undefined) {
  const path = blank(value);
  if (path === undefined) return undefined;
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(root, path);
}

const endpoint = (value: string | undefined) => (value ?? OPENAI_BASE_URL).replace(/\/+$/u, "");

export function loadConfig(env: Env = process.env) {
  const headless = env.HEADLESS === "true" || env.HEADLESS === "1";
  const root = blank(env.CHEONGEUM_DESKTOP_RUNTIME) ?? REPO_ROOT;
  const speed = decimal(env.TTS_SPEED);
  const openaiKey = blank(env.OPENAI_API_KEY);
  const voiceKey = blank(env.VOICE_API_KEY) ?? openaiKey;
  const llmKey = blank(env.LLM_API_KEY);
  const voiceUrl = blank(env.VOICE_BASE_URL);
  const llmUrl = blank(env.LLM_BASE_URL);
  const officialVoice = endpoint(voiceUrl) === OPENAI_BASE_URL;
  const officialOrigin = endpoint(llmUrl) === OPENAI_BASE_URL;
  const canUseOpenai = officialOrigin && (openaiKey !== undefined || llmKey !== undefined || (voiceKey !== undefined && officialVoice));
  const provider = textOr(env.LLM_PROVIDER, canUseOpenai ? "openai" : "mock");
  const officialLlm = provider === "openai" && officialOrigin;
  const llm: LlmConfig = omitAbsent({
    provider, baseUrl: llmUrl, model: blank(env.LLM_MODEL) ?? (officialLlm ? STACK.agent : undefined),
    apiKey: llmKey ?? (officialLlm ? openaiKey ?? (officialVoice ? voiceKey : undefined) : undefined),
    reasoningEffort: blank(env.LLM_REASONING_EFFORT),
  });
  function role(name: string, model: string, effort: string): LlmConfig {
    const entry = (key: string) => blank(env["LLM_" + name + "_" + key]);
    const cfg = overlayLlm(llm, { provider: entry("PROVIDER"), model: entry("MODEL"), baseUrl: entry("BASE_URL"),
      apiKey: entry("API_KEY"), reasoningEffort: entry("REASONING_EFFORT") });
    if (cfg.provider !== llm.provider && entry("BASE_URL") === undefined) delete cfg.baseUrl;
    if ((cfg.provider !== llm.provider || endpoint(cfg.baseUrl) !== endpoint(llm.baseUrl)) && entry("API_KEY") === undefined) delete cfg.apiKey;
    if (cfg.provider === "openai" && endpoint(cfg.baseUrl) === OPENAI_BASE_URL) {
      const override = entry("MODEL") ?? (["GOAL", "UNDERSTAND", "FILE"].includes(name) ? blank(env.LLM_MODEL) : undefined);
      if (override === undefined || override === model) return { ...cfg, model, reasoningEffort: entry("REASONING_EFFORT") ?? effort };
    }
    return cfg;
  }
  const voice: VoiceConfig = {
    ...VOICE_DEFAULTS, apiKey: blank(env.VOICE_API_KEY) ?? (officialVoice ? openaiKey ?? (officialLlm ? llm.apiKey : undefined) : undefined),
    baseUrl: voiceUrl ?? VOICE_DEFAULTS.baseUrl, sttModel: blank(env.STT_MODEL) ?? VOICE_DEFAULTS.sttModel,
    liveModel: blank(env.VOICE_LIVE_MODEL) ?? VOICE_DEFAULTS.liveModel,
    ttsSpeed: speed !== undefined && speed > 0 ? Math.min(4, Math.max(0.25, speed)) : VOICE_DEFAULTS.ttsSpeed,
  };
  const pilotProfile = env.PILOT_PROFILE === "shared" || env.PILOT_PROFILE === "personal" ? env.PILOT_PROFILE : "unidentified";
  const detail = strip(env.LLM_VISION_DETAIL ?? "").toLowerCase();
  const threshold = decimal(env.PII_THRESHOLD);
  const extraAllowedOrigins = (env.EXTRA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(strip)
    .filter((v) => v.length > 0)
    .map((v) => parseUrl(v).origin);
  return omitAbsent({
    mockSiteUrl: textOr(env.MOCK_SITE_URL, "http://localhost:5174"),
    extraAllowedOrigins,
    headless,
    slowMoMs: Math.trunc(decimal(env.BROWSER_SLOWMO_MS) ?? 0),
    requireConsent: env.REQUIRE_CONSENT === "true",
    directActions: env.REQUIRE_ACTION_CONFIRMATION !== "true",
    practiceMode: env.PRACTICE_MODE !== "false",
    pilotProfile,
    dataDir: pilotProfile === "personal" ? blank(env.CHEONGEUM_DATA_DIR) : undefined,
    personalDataDir: blank(env.CHEONGEUM_DATA_DIR),
    browserDriver: browserDriver(env.BROWSER_DRIVER ?? "stagehand"),
    browserMode: pilotProfile === "personal" && env.BROWSER_MODE === "chrome" ? ("chrome" as const) : ("chromium" as const),
    chromeProfileDir: blank(env.CHROME_PROFILE_DIR) ?? join(homedir(), ".cheongeum", "chrome-profile"),
    readOnlyWeb: env.READ_ONLY_WEB !== "false",
    readOnlyClicks:
      strip(env.READ_ONLY_CLICKS ?? "").toLowerCase() === "any" ? ("any" as const) : ("safe" as const),
    guardianSender: guardianSender(env),
    publicPlanning: (env.PUBLIC_SERVICE_ROUTER ?? "true").toLowerCase() !== "false",
    tavilyApiKey: blank(env.TAVILY_API_KEY),
    datasetsDir: localPath(root, env.DATASETS_DIR),
    searchUrlTemplate: blank(env.WEB_SEARCH_URL),
    visualCursor:
      env.VISUAL_CURSOR === undefined || env.VISUAL_CURSOR === "" ? !headless : env.VISUAL_CURSOR === "true",
    llm,
    llmUnderstand: role("UNDERSTAND", STACK.agent, "low"), llmGoal: role("GOAL", STACK.agent, "low"),
    llmWeb: role("WEB", STACK.utility, "none"), llmFile: role("FILE", STACK.agent, "low"),
    llmVision: role("VISION", STACK.vision, "low"), llmRecovery: role("RECOVERY", STACK.recovery, "medium"),
    visionDetail: detail === "low" || detail === "auto" ? detail : "high",
    voice,
    welfareApiKey: env.WELFARE_DATA_MODE === "official-api" ? blank(env.WELFARE_API_KEY) : undefined,
    welfareApiBaseUrl: blank(env.WELFARE_API_BASE_URL),
    piiModel: localPath(root, env.PII_MODEL),
    piiThreshold: threshold === undefined || threshold === 0 ? 0.5 : threshold,
  });
}
export type RuntimeConfig = ReturnType<typeof loadConfig>;

export class AgentRuntime {
  setAvatarVisible?: (visible: boolean, signal: AbortSignal) => Promise<boolean>;
  readonly config: RuntimeConfig;
  readonly profile;
  readonly welfareProvider;
  readonly openData;
  readonly events = new InMemoryEventLog();
  scanner: PiiScanner;
  readonly connections: ModelConnections;
  readonly fetcher: typeof fetch;
  readonly settings?: SettingsStore;
  services: ReturnType<AgentRuntime["configure"]>;
  get stt() { return this.services.stt; }
  get tts() { return this.services.tts; }
  get intentProvider() { return this.services.intentProvider; }
  get answerLlm() { return this.services.webLlm; }
  get understandLlm() { return this.services.understandLlm; }
  get goalLlm() { return this.services.goalLlm; }
  get embedding() { return this.services.embedding; }
  get moderation() { return this.services.moderation; }

  private readonly pii?: PiiModel;
  private personal?: PersonalStore;
  private actionLog?: ActionLog;
  private seal?: Seal;
  private browser?: Promise<Browser>;
  private workerBrowser?: Promise<Browser>;
  private controllerBrowser?: Promise<Browser>;
  private controller?: ReturnType<typeof openControllerWindow>;
  private chrome?: Promise<BrowserContext>;
  private closed = false;
  browserFallback = false;
  sealFactory = () => new Seal();

  static async create(config: RuntimeConfig, fetcher: typeof fetch = fetch, settings?: SettingsStore) {
    const runtime = new AgentRuntime(config, undefined, undefined, fetcher, settings);
    if (runtime.pii !== undefined) {
      try { await runtime.pii.load(); }
      catch { runtime.scanner = new PiiScanner(); process.stderr.write("[privacy] 개인정보 모델 오류 → 규칙만 사용\n"); }
    }
    return runtime;
  }
  constructor(config: RuntimeConfig, stt?: SttProvider, tts?: TtsProvider, fetcher: typeof fetch = fetch, settings?: SettingsStore) {
    this.config = config;
    this.settings = settings;
    this.fetcher = fetcher;
    this.connections = new ModelConnections(fetcher);
    this.profile = createMockWelfareProfile(config.mockSiteUrl);
    this.openData = OpenData.load(config.datasetsDir);
    this.welfareProvider = createWelfareDataProvider({ apiKey: config.welfareApiKey, apiBaseUrl: config.welfareApiBaseUrl, fetchImpl: fetcher });
    if (config.piiModel !== undefined && PiiModel.available(config.piiModel)) this.pii = new PiiModel(config.piiModel, config.piiThreshold);
    this.scanner = new PiiScanner(this.pii);
    this.services = this.configure();
    if (stt !== undefined) this.services.stt = stt;
    if (tts !== undefined) this.services.tts = tts;
  }
  private configure() {
    const cfg = this.config;
    const settings = this.settings?.completed === true ? this.settings : undefined;
    const key = blank(settings?.key);
    function withKey(role: LlmConfig, model: string, effort: string): LlmConfig {
      if (key === undefined) return role;
      if (role.provider === "openai" && endpoint(role.baseUrl) === OPENAI_BASE_URL) {
        return { ...role, apiKey: key, model: role.model ?? model };
      }
      if (createStructuredLlm(role) !== undefined) return role;
      return { provider: "openai", apiKey: key, model, reasoningEffort: effort };
    }
    let voice = { ...cfg.voice };
    if (settings !== undefined) {
      if (key !== undefined) voice = { ...(endpoint(voice.baseUrl) === OPENAI_BASE_URL ? voice : VOICE_DEFAULTS), apiKey: key };
      voice.ttsSpeed = settings.preferences.speed;
    }
    const [stt, tts] = createVoiceProviders(voice, this.fetcher);
    const llm = withKey(cfg.llm, STACK.agent, "low");
    const understand = withKey(cfg.llmUnderstand, STACK.agent, "low");
    const file = withKey(cfg.llmFile, STACK.agent, "low");
    const pool = this.connections;
    const officialKey = key ?? (llm.provider === "openai" && endpoint(llm.baseUrl) === OPENAI_BASE_URL ? llm.apiKey : undefined)
      ?? (endpoint(voice.baseUrl) === OPENAI_BASE_URL ? voice.apiKey : undefined);
    return {
      stt, tts, llm, voice,
      intentProvider: createIntentProvider(understand, fieldVocabulary(this.profile), this.fetcher),
      understandLlm: createStructuredLlm(understand, { pool }),
      goalLlm: createStructuredLlm(withKey(cfg.llmGoal, STACK.agent, "low"), { pool }),
      webLlm: createStructuredLlm(withKey(cfg.llmWeb, STACK.utility, "none"), { pool }),
      fileLlm: file.provider?.toLowerCase() === "openai" ? createStructuredLlm({ ...file, timeoutMs: 120000 }, { pool }) : undefined,
      visionLlm: createVisionLlm(withKey(cfg.llmVision, STACK.vision, "low"), { detail: cfg.visionDetail, pool }),
      recoveryLlm: createStructuredLlm(withKey(cfg.llmRecovery, STACK.recovery, "medium"), { pool }),
      embedding: officialKey === undefined ? undefined : new EmbeddingService(officialKey, STACK.embedding, pool),
      moderation: officialKey === undefined ? undefined : new ModerationService(officialKey, STACK.moderation, pool),
    };
  }
  refreshServices() { this.services = this.configure(); }
  get allowedOrigins() { return [this.profile.origin, ...this.config.extraAllowedOrigins]; }
  llmRoles() {
    const base = createStructuredLlm(this.services.llm)?.name;
    const { fileLlm, visionLlm, recoveryLlm } = this.services;
    return {
      default: base ?? "rules", understand: this.understandLlm?.name ?? this.intentProvider.name,
      goal: this.goalLlm?.name ?? base ?? this.intentProvider.name, web: this.answerLlm?.name ?? base ?? this.intentProvider.name,
      file: fileLlm?.name ?? "local-text", vision: visionLlm?.name ?? "disabled", recovery: recoveryLlm?.name ?? "disabled",
      embeddings: this.embedding?.model ?? "disabled", moderation: this.moderation?.model ?? "disabled",
    };
  }
  sessionModels() {
    const { intentProvider, fileLlm, visionLlm, recoveryLlm, webLlm } = this.services;
    const search = this.config.tavilyApiKey === undefined ? undefined
      : new TavilySearch(this.config.tavilyApiKey, webLlm, this.connections, { scan: texts => this.scanner.scan(texts) });
    return { intentProvider, llm: this.understandLlm ?? webLlm, goalLlm: this.goalLlm ?? webLlm,
      webLlm, fileLlm, visionLlm, recoveryLlm, quietSearch: search === undefined ? undefined :
        (async (task, lang, signal, requestedSteps) => (await search.search(task, lang, signal, requestedSteps)) ?? {}) satisfies NonNullable<OrchestratorDeps["quietSearch"]>,
      browsePublicSources: this.config.readOnlyWeb && (this.goalLlm ?? webLlm) !== undefined ? this.browsePublicSources : undefined,
      findPortal: search === undefined ? undefined :
        ((query, signal) => search.portals(query, signal)) satisfies NonNullable<OrchestratorDeps["findPortal"]> };
  }
  private readonly browsePublicSources: NonNullable<OrchestratorDeps["browsePublicSources"]> = async (task, ctx, maxSteps, requestedSteps) => {
    const [spans] = await this.scanner.scan([task.goal]);
    if (safeInput(task.goal, 1600, spans) === undefined || ctx.signal.aborted || ctx.isStopped()) return undefined;
    const worker = await this.createSession({ background: true }).catch(() => undefined);
    if (worker === undefined) return undefined;
    try {
      if (ctx.signal.aborted || ctx.isStopped()) return undefined;
      return await worker.browse.runGoal(task.goal, withContext(ctx, { publicLookup: true }), {
        publicTask: task, maxSteps, requestedSteps,
      });
    } finally {
      await worker.close();
    }
  };
  personalEnabled() {
    return this.config.pilotProfile === "personal" || (this.config.pilotProfile !== "shared" && this.settings?.completed === true
      && this.settings.preferences.deviceUse === "personal");
  }
  getSeal() { return this.seal ??= this.sealFactory(); }
  personalStore() {
    if (!this.personalEnabled()) { this.personal = undefined; return undefined; }
    const folder = this.config.dataDir ?? this.config.personalDataDir;
    return this.personal ??= folder === undefined ? new PersonalStore() : new PersonalStore(join(folder, "personal.json"), this.getSeal());
  }
  browserMode() {
    const chosen = this.config.browserMode === "chrome" || (this.settings?.completed === true && this.settings.preferences.browser === "chrome");
    return chosen && this.personalEnabled() ? "chrome" : "chromium";
  }
  private getBrowser(background = false) {
    const slot = background && !this.config.headless ? "workerBrowser" : "browser";
    const opening = this[slot] ??= launchBrowser(background || this.config.headless, background ? 0 : this.config.slowMoMs, this.config.browserDriver)
      .then(browser => {
        browser.once("disconnected", () => { if (this[slot] === opening) this[slot] = undefined; });
        return browser;
      }).catch((error: unknown) => {
        if (this[slot] === opening) this[slot] = undefined;
        throw error;
      });
    return opening;
  }
  async showController(url: string) {
    const getVisible = () => {
      if (!this.config.headless) return this.getBrowser();
      return this.controllerBrowser ??= launchBrowser(false, 0, this.config.browserDriver).then(browser => {
        browser.once("disconnected", () => { this.controllerBrowser = undefined; });
        return browser;
      }).catch((error: unknown) => { this.controllerBrowser = undefined; throw error; });
    };
    const opening = this.controller ??= getVisible().then(browser => openControllerWindow(browser, url));
    try {
      const page = await opening;
      page.once("close", () => { if (this.controller === opening) this.controller = undefined; });
      await page.bringToFront();
    } catch (error) { if (this.controller === opening) this.controller = undefined; throw error; }
  }
  openChrome() {
    this.chrome ??= launchChromeProfile(this.config.chromeProfileDir, this.config.slowMoMs, this.config.browserDriver)
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
  async createSession({ background = false } = {}): Promise<SessionOrchestrator> {
    if (this.closed) throw new Error("Runtime is closed");
    const cfg = this.config;
    const personal = background ? undefined : this.personalStore();
    if (!background && this.actionLog === undefined) this.actionLog = cfg.dataDir === undefined ? new ActionLog()
      : new ActionLog(join(cfg.dataDir, "actions.sealed"), this.getSeal());
    const downloads = background ? undefined : new DownloadStore(cfg.dataDir === undefined ? undefined : join(cfg.dataDir, "downloads"));
    const shared = !background && this.browserMode() === "chrome";
    const allowedOrigins = background ? [] : this.allowedOrigins;
    const readOnlyWeb = background || cfg.readOnlyWeb;
    const source = async () => {
      if (shared) {
        try {
          const context = await this.openChrome();
          this.browserFallback = false;
          return context;
        } catch { this.browserFallback = true; }
      }
      return await this.getBrowser(background);
    };
    let session: SessionOrchestrator | undefined;
    const adapter = new PlaywrightExecutionAdapter({ browserSource: source, driver: cfg.browserDriver,
      protectedTab: page => session?.dialogue.authHandoff?.browser === page && session.dialogue.authWaiting,
      allowedOrigins, readOnlyWeb, visualCursor: cfg.visualCursor && !background, downloads });
    try {
      if (background || cfg.practiceMode || (cfg.headless && this.browserMode() !== "chrome")) await adapter.start();
      if (this.closed) throw new Error("Runtime is closed");
      const profile = this.profile;
      const guard = new PolicyGuard({
        allowedOrigins,
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
          "capture",
        ],
        allowedFieldIds: background ? [] : profile.fields.filter(f => f.sensitivity !== "secret").map(f => f.fieldId),
        secretFieldIds: background ? [] : profile.fields.filter(f => f.sensitivity === "secret").map(f => f.fieldId),
        maxActionsPerTurn: 32, defaultActionsPerTurn: 12, publicLookupOnly: background, directActions: cfg.directActions && !background,
        safeButtons: [profile.buttons.next, profile.buttons.prev, ...profile.buttons.dismissDialog],
        readOnlyWeb, readOnlyClicks: background ? "safe" : cfg.readOnlyClicks,
      });
      const settings = background ? undefined : this.settings;
      const remember = settings !== undefined && cfg.pilotProfile !== "shared";
      const sessionOptions = {
        ...this.sessionModels(),
        // 맡겨 둔 조사는 사용자에게 사진 전송 동의를 물을 수 없으니 화면 사진을 보내지 않는다.
        ...(background ? { visionLlm: undefined } : {}),
        web: new WebExecutionAgent(adapter, guard, profile, background ? undefined : this.actionLog),
        welfare: new WelfareInformationAgent(this.welfareProvider, this.answerLlm, { shelf: this.openData.programs, links: this.openData.links }),
        places: this.openData.places,
        events: background ? new InMemoryEventLog() : this.events,
        requireConsent: cfg.requireConsent && !background, practiceMode: cfg.practiceMode && !background,
        publicPlanning: cfg.publicPlanning,
        setAvatarVisible: background ? undefined : this.setAvatarVisible,
        initialRegion: settings?.preferences.region ?? "", initialLanguage: settings?.preferences.language ?? "ko",
        initialService: remember ? settings.lastService : undefined, rememberService: remember ? settings.rememberService.bind(settings) : undefined,
        firstRunStep: settings?.completed === true && settings.firstRun !== "done" ? settings.firstRun : undefined,
        firstRunProgress: settings?.setFirstRun.bind(settings), personal,
        routeDevice: () => !background && this.personalEnabled() && !(settings?.completed === true && settings.preferences.deviceUse === "shared"),
        guardianSender: background ? null : cfg.guardianSender ?? null, actionLog: !background && cfg.pilotProfile === "personal" ? this.actionLog : undefined,
        scanner: this.scanner, searchUrlTemplate: cfg.searchUrlTemplate,
        downloads,
        sharedBrowser: shared && !this.browserFallback,
      };
      session = new SessionOrchestrator(sessionOptions);
      if (!background && !cfg.requireConsent) await session.prepare();
      return session;
    } catch (e) {
      await adapter.close();
      throw e;
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([
      this.chrome?.then(closeLaunchedBrowser),
      this.browser?.then(closeLaunchedBrowser),
      this.pii?.close(),
      this.workerBrowser?.then(closeLaunchedBrowser),
      this.controllerBrowser?.then(closeLaunchedBrowser),
      this.connections.close(),
    ]);
  }
}
