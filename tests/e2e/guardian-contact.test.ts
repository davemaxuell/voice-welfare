import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { guardianSender, MESSAGE } from "../../src/personal/guardian.ts";
import { Seal } from "../../src/personal/seal.ts";
import { makeApp } from "../../src/server/app.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { SettingsInput, SettingsStore } from "../../src/server/settings.ts";
import { fakeFetch, testRuntimeEnv } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
const setup = "보호자 김하늘 전화번호 공일공 일이삼사 오육칠팔 등록해줘";
const contact = "보호자한테 연락해줘";

it("test_guardian_endpoint_saves_on_personal_pc_and_refuses_on_shared", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cheongeum-guardian-test-"));
  const sealFactory = () => new Seal({ key: Buffer.alloc(32, 101) });
  const settings = new SettingsStore(join(directory, "preferences.json"), sealFactory);
  const service = new AgentRuntime(loadConfig(testRuntimeEnv({ CHEONGEUM_DATA_DIR: join(directory, "data") })),
    undefined, undefined, fetch, settings);
  service.sealFactory = sealFactory;
  const app = makeApp(service);
  const save = (phone: string) => app.request("/api/personal/guardian", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "홍길동", phone }) });
  try {
    settings.save(SettingsInput.parse({ apiKey: "sk-test", deviceUse: "shared" }));
    const refused = await save("010-1122-3344");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "NOT_PERSONAL" });
    settings.save(SettingsInput.parse({ deviceUse: "personal" }));
    const bad = await save("02-123-4567");
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("02-123-4567");
    const saved = await save("010-1122-3344");
    expect(await saved.json()).toEqual({ saved: true });
    expect(service.personalStore()?.guardian()).toEqual({ name: "홍길동", phone: "01011223344" });
  } finally {
    await app.sessions.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
afterEach(async () => { vi.unstubAllGlobals(); await runtime.closeSessions(); });
afterAll(runtime.close);

async function register(session: SessionOrchestrator) {
  const before = session.personal.guardian();
  const prompt = await session.handleTurn(setup);
  expect(prompt.speech).toContain("동의");
  expect(prompt.speech).toContain("김하늘");
  expect(session.personal.guardian()).toEqual(before);
  await session.handleTurn("네");
  expect(session.personal.guardian()).toEqual({ name: "김하늘", phone: "01012345678" });
  expect(session.personal.vault()).toEqual({});
}

it("test_guardian_setup_preview_and_remove", async () => {
  const { session } = await runtime.createBrowserSession();
  await register(session);
  const prompt = await session.handleTurn(contact);
  for (const word of [MESSAGE, "5678", "모의"]) expect(prompt.speech).toContain(word);
  expect((await session.handleTurn("네")).speech).toContain("실제 발송은 하지 않았어요");
  expect((await session.handleTurn("네")).speech).not.toContain("모의 문자 내용");
  await session.handleTurn("보호자 연락처 지워줘");
  await session.handleTurn("네");
  expect(session.personal.guardian()).toBeUndefined();
  expect(JSON.stringify(session.exportHistory())).not.toMatch(/김하늘|01012345678/u);
});

it("test_guardian_waits_for_consent_and_stop", async () => {
  const { session } = await runtime.createBrowserSession({ requireConsent: true });
  expect((await session.handleTurn(setup)).semanticAction).toBe("consent");
  expect(session.dialogue.vaultConfirm).toBeUndefined();
  await session.consentTo(true);
  await register(session);
  await session.handleTurn(contact);
  await session.handleTurn("멈춰");
  expect((await session.handleTurn("네")).state).toBe("STOPPED");
  expect(session.dialogue.vaultConfirm).toBeUndefined();
});

it.each(["contact", "screen", "time"])("test_changed_or_expired_guardian_request_requires_fresh_yes", async change => {
  let now = 0;
  const { session, page } = await runtime.createBrowserSession({ clock: () => now });
  session.personal.setGuardian({ name: "김하늘", phone: "01012345678" });
  await session.handleTurn(contact);
  if (change === "contact") session.personal.setGuardian({ name: "박구름", phone: "01098765432" });
  if (change === "screen") await page.evaluate(() => { document.title = "새로운 페이지"; });
  if (change === "time") now = 120;
  const prompt = await session.handleTurn("네");
  expect(prompt.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(prompt.speech).not.toContain("실제 발송은 하지");
  if (change === "contact") expect(prompt.speech).toContain("박구름");
  expect((await session.handleTurn("네")).speech).toContain("모의 문자 내용");
});

it("test_queued_yes_cannot_approve_a_new_prompt", async () => {
  const { session } = await runtime.createBrowserSession();
  await register(session);
  let observed = () => {}, release = () => {};
  const started = new Promise<void>(resolve => { observed = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const observe = session.web.observe.bind(session.web);
  vi.spyOn(session.web, "observe").mockImplementationOnce(async ctx => {
    observed();
    await wait;
    return observe(ctx);
  });
  const asking = session.handleTurn(contact);
  await started;
  const early = session.handleTurn("네");
  release();
  await asking;
  expect((await early).state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect((await session.handleTurn("네")).speech).toContain("실제 발송은 하지");
});

it("test_sms_mode_requires_fresh_unambiguous_confirmation", async () => {
  const sender = guardianSender({ GUARDIAN_SMS_PROVIDER: "solapi", SOLAPI_API_KEY: "demo",
    SOLAPI_API_SECRET: "test", SOLAPI_SENDER_NUMBER: "0212345678" });
  const { session } = await runtime.createBrowserSession({ guardianSender: sender });
  const transport = fakeFetch(() => Response.json({ failedMessageList: [], groupInfo: { count: { registeredSuccess: 1 } } }));
  vi.stubGlobal("fetch", transport);
  await register(session);
  const prompt = await session.handleTurn(contact);
  expect(prompt.speech).toContain(MESSAGE);
  expect(prompt.speech).not.toContain("모의");
  await session.handleTurn("응, 보내지 마");
  await session.handleTurn("네");
  expect(transport.calls).toHaveLength(0);
  await session.handleTurn(contact);
  expect((await session.handleTurn("보내줘")).speech).toContain("접수됐어요");
  await session.handleTurn("네");
  expect(transport.calls).toHaveLength(1);
});
