import type { Browser } from "playwright";
import { z } from "zod";
import { WelfareInformationAgent } from "../../src/agents/welfare/agent.ts";
import { FixtureWelfareDataProvider } from "../../src/agents/welfare/data/index.ts";
import { WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { launchBrowser, PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";
import { DownloadStore } from "../../src/agents/web/downloads.ts";
import { createMockWelfareProfile, fieldVocabulary } from "../../src/agents/web/profile.ts";
import { InMemoryEventLog } from "../../src/core/events.ts";
import { SpeechPrefsSchema } from "../../src/core/turn.ts";
import { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { ActionLog } from "../../src/personal/action_log.ts";
import { PersonalStore } from "../../src/personal/store.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { FakeLlm } from "../helpers.ts";
import type { OpenTranscript, TranscriptSession } from "./transcripts.ts";

export interface SessionOptions {
  mockSiteUrl?: string;
  searchUrlTemplate?: string;
  navigationTimeoutMs?: number;
  readOnlyWeb?: boolean;
  readOnlyClicks?: "safe" | "any";
  requireConsent?: boolean;
  practiceMode?: boolean;
  personal?: PersonalStore;
  actionLog?: ActionLog;
  today?: () => string;
  clock?: () => number;
}

export function createTestRuntime(defaults: SessionOptions = {}) {
  let browser: Promise<Browser> | undefined;
  const sessions = new Set<SessionOrchestrator>();
  async function createBrowserSession(overrides: SessionOptions = {}) {
    const opts = { ...defaults, ...overrides };
    browser ??= launchBrowser(process.env.HEADED !== "1", process.env.HEADED === "1" ? 200 : 0);
    const profile = createMockWelfareProfile(opts.mockSiteUrl ?? "http://localhost:5174");
    const allowedOrigins = [profile.origin];
    const readOnlyWeb = opts.readOnlyWeb ?? true;
    const downloads = new DownloadStore();
    const adapter = new PlaywrightExecutionAdapter({ browser: await browser, allowedOrigins, readOnlyWeb, downloads,
      navigationTimeoutMs: opts.navigationTimeoutMs });
    try {
      await adapter.start();
      const guard = new PolicyGuard({ allowedOrigins, readOnlyWeb, readOnlyClicks: opts.readOnlyClicks ?? "safe",
        allowedActionTypes: ["navigate", "back", "click", "fill", "press", "select", "check", "read", "focus", "scroll"],
        allowedFieldIds: profile.fields.filter(f => f.sensitivity !== "secret").map(f => f.fieldId),
        secretFieldIds: profile.fields.filter(f => f.sensitivity === "secret").map(f => f.fieldId),
        safeButtons: [profile.buttons.next, profile.buttons.prev, ...profile.buttons.dismissDialog], maxActionsPerTurn: 12 });
      const session = new SessionOrchestrator({
        web: new WebExecutionAgent(adapter, guard, profile, opts.actionLog),
        welfare: new WelfareInformationAgent(FixtureWelfareDataProvider.fromFile()),
        intentProvider: new RuleBasedIntentProvider(fieldVocabulary(profile)), events: new InMemoryEventLog(),
        requireConsent: opts.requireConsent ?? false, practiceMode: opts.practiceMode ?? true,
        searchUrlTemplate: opts.searchUrlTemplate ?? "http://127.0.0.1:5174/external.html?q={q}",
        personal: opts.personal, downloads, actionLog: opts.actionLog, today: opts.today, clock: opts.clock,
      });
      if (opts.requireConsent !== true) await session.prepare();
      sessions.add(session);
      const page = adapter.page;
      if (page === undefined) throw new Error("Browser session started without a page");
      return { session, adapter, page, async close() {
        if (sessions.delete(session)) await session.close();
      } };
    } catch (error) {
      await adapter.close();
      throw error;
    }
  }
  async function closeSessions() {
    for (const session of sessions) { sessions.delete(session); await session.close(); }
  }
  async function close() {
    try { await closeSessions(); } finally { await (await browser)?.close(); browser = undefined; }
  }
  return { createBrowserSession, closeSessions, close };
}

const InitialPersonal = z.object({
  vault: z.partialRecord(z.enum(["name", "address", "phone", "email", "birth"]), z.string()),
  applications: z.array(z.object({
    id: z.string(), service: z.string(), appliedAt: z.string(), receiptNo: z.string().optional(),
    dueDate: z.string().optional(), dueNote: z.string().optional(), done: z.boolean().optional(),
  })),
  speech: SpeechPrefsSchema,
  allowedSites: z.array(z.string()),
});

export function openBrowserTranscript(runtime: ReturnType<typeof createTestRuntime>): OpenTranscript {
  return async header => {
    const initial = InitialPersonal.parse(header.initialPersonal);
    const personal = new PersonalStore();
    personal.saveVault(initial.vault);
    personal.saveSpeech(initial.speech);
    for (const { id: _id, ...application } of initial.applications) personal.addApplication(application);
    for (const origin of initial.allowedSites) personal.allowSite(origin);
    const day = header.calendarDay;
    const actionLog = header.actionLogEnabled ? new ActionLog(undefined, undefined, () => new Date(day + "T03:00:00Z")) : undefined;
    const { session, close } = await runtime.createBrowserSession({ ...header.config, personal, actionLog, today: () => day });
    const dialogue = session.dialogue;
    let before = actionLog?.recent(10_000).length ?? 0;
    const transcript: TranscriptSession = {
      bindModels(roles, generate) {
        const model = new FakeLlm(generate);
        session.deps.llm = roles.includes("default") ? model : undefined;
        session.deps.goalLlm = roles.includes("goal") ? model : undefined;
        session.deps.webLlm = roles.includes("web") ? model : undefined;
        session.deps.welfare.llm = roles.includes("welfare") ? model : undefined;
      },
      async dispatch(call) {
        before = actionLog?.recent(10_000).length ?? 0;
        switch (call.method) {
          case "handle_turn": return session.handleTurn(call.args[0]);
          case "confirm": return session.confirm(call.args[0]);
          case "cancel": return session.cancel();
          case "consent_to": return session.consentTo(call.args[0]);
          case "set_language": return session.setLanguage(call.args[0]);
        }
      },
      inspect() {
        const clarification = dialogue.clarification;
        return {
          slots: { approval: dialogue.approval, awaiting: dialogue.awaiting,
            clarification: clarification === undefined ? undefined : { value: clarification.value,
              candidates: clarification.candidates.map(({ fieldId }) => ({ fieldId })) },
            profile_question: dialogue.profileQuestion, vault_confirm: dialogue.vaultConfirm,
            guided: dialogue.guided, auth_resume: dialogue.authResume },
          personal: { vault: personal.vault(), speech: personal.speech(), applications: personal.applications(), allowedSites: personal.allowedSites() },
          actionLog: (actionLog?.recent(10_000) ?? []).slice(before).map(({ prev: _prev, hash: _hash, day: _day, at: _at, ...row }) => row),
        };
      },
      close,
    };
    return transcript;
  };
}
