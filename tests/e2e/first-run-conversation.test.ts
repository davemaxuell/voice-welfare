import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { INTRO_POSES } from "../../src/core/turn.ts";
import { LINES } from "../../src/orchestrator/first_run_text.ts";
import type { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { Seal } from "../../src/personal/seal.ts";
import { PersonalStore } from "../../src/personal/store.ts";
import { SettingsInput, SettingsStore } from "../../src/server/settings.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cheongeum-onboarding-")); });
afterEach(async () => { await runtime.closeSessions(); rmSync(directory, { recursive: true, force: true }); });
afterAll(runtime.close);

function setup(device: "shared" | "personal" = "personal", step = "stage2") {
  const seal = new Seal({ key: Buffer.alloc(32, 42) });
  const path = join(directory, "preferences.json");
  const settings = new SettingsStore(path, () => seal);
  settings.save(SettingsInput.parse({ apiKey: "sk-test", deviceUse: device }));
  settings.setFirstRun(step);
  const personal = device === "personal" ? new PersonalStore(join(directory, "personal.json"), seal) : undefined;
  function open() {
    const current = new SettingsStore(path, () => seal);
    return runtime.createBrowserSession({ personal, requireConsent: true, firstRunStep: current.firstRun,
      firstRunProgress: value => current.setFirstRun(value) });
  }
  return { open, personal, savedStep: () => new SettingsStore(path, () => seal).firstRun };
}

async function toStop(session: SessionOrchestrator) {
  await session.consentTo(true);
  await session.handleTurn("안녕하세요");
  await session.handleTurn("홍길동이라고 불러 줘");
  return session.handleTurn("네");
}

it("test_consent_greets_by_saved_call_name", async () => {
  const personal = new PersonalStore();
  personal.setCallName("홍길동");
  const { session } = await runtime.createBrowserSession({ personal });
  expect((await session.consentTo(true)).speech).toMatch(/^홍길동님, 반가워요\./u);
});

it("test_consent_without_a_name_keeps_the_usual_greeting", async () => {
  const { session } = await runtime.createBrowserSession();
  expect((await session.consentTo(true)).speech).toMatch(/^동의해 주셔서 감사합니다\./u);
});

it("test_vault_read_includes_call_name", async () => {
  const personal = new PersonalStore();
  personal.setCallName("홍길동");
  const { session } = await runtime.createBrowserSession({ personal });
  expect((await session.handleTurn("내 정보 알려줘")).speech).toContain("부르는 이름 홍길동님");
});

it("test_name_kept_only_for_the_session_without_a_personal_store", async () => {
  const { session } = await runtime.createBrowserSession();
  expect(session.deps.personal).toBeUndefined();
  expect(session.rememberCallName("홍길동")).toBe(false);
  expect(session.callName).toBe("홍길동");
  expect((await runtime.createBrowserSession()).session.callName).toBeUndefined();
});

it("test_consent_on_first_run_starts_the_mic_check", async () => {
  const profile = setup();
  const { session } = await profile.open();
  expect((await session.consentTo(true)).speech.endsWith(LINES.mic.ko)).toBe(true);
  expect(session.dialogue.firstRun).toBe("mic");
  expect(profile.savedStep()).toBe("mic");
});

it("test_name_saved_on_personal_pc_after_yes", async () => {
  const profile = setup();
  const { session } = await profile.open();
  await session.consentTo(true);
  const heard = await session.handleTurn("안녕하세요");
  expect(heard.speech).toContain("'안녕하세요'라고 들었어요");
  expect(heard.speech).toContain(LINES.name.ko);
  const asked = await session.handleTurn("홍길동이라고 불러 줘");
  expect(asked.speech).toContain("홍길동님이라고 부를게요");
  expect(profile.personal?.callName()).toBeUndefined();
  const done = await session.handleTurn("네");
  expect(done.speech).toContain(LINES["stop-practice"].ko);
  expect(done.speech).not.toContain(LINES["name-shared"].ko);
  expect(profile.personal?.callName()).toBe("홍길동");
  expect(profile.savedStep()).toBe("stop");
});

it("test_name_on_shared_pc_is_session_only_and_not_greeted_next_time", async () => {
  const profile = setup("shared");
  const { session } = await profile.open();
  expect((await toStop(session)).speech).toContain(LINES["name-shared"].ko);
  expect(session.callName).toBe("홍길동");
  expect((await (await profile.open()).session.consentTo(true)).speech).not.toContain("홍길동");
});

it("test_stop_on_the_stop_step_praises_then_yes_plays_the_intro", async () => {
  const profile = setup();
  const { session } = await profile.open();
  await toStop(session);
  expect((await session.handleTurn("멈춰")).speech).toBe(LINES["stop-praise"].ko);
  expect(session.dialogue.firstRun).toBe("intro");
  const intro = (await session.handleTurn("네")).introScript;
  expect(intro?.slice(0, 7).map(line => line.pose)).toEqual(INTRO_POSES);
  expect(intro?.[0]?.text).toMatch(/^홍길동님, 반가워요!/u);
  expect(intro?.at(-1)).toMatchObject({ text: LINES["practice-offer"].ko, ask: true });
  expect(session.dialogue.firstRun).toBe("practice");
  expect(profile.savedStep()).toBe("practice");
});

it("test_another_command_ends_the_guide_and_runs_it", async () => {
  const profile = setup();
  const { session, page } = await profile.open();
  await page.route("https://www.bokjiro.go.kr/**", route => route.fulfill({ contentType: "text/html", body: "<title>복지로</title><main>복지로</main>" }));
  await session.consentTo(true);
  await session.handleTurn("안녕하세요");
  expect((await session.handleTurn("복지로 열어줘")).intentType).toBe("OPEN_SITE");
  expect(session.dialogue.firstRun).toBeUndefined();
  expect(profile.savedStep()).toBe("name");
});

it("test_reopened_session_resumes_at_recorded_step", async () => {
  const profile = setup("personal", "name");
  expect((await (await profile.open()).session.consentTo(true)).speech.endsWith(LINES.name.ko)).toBe(true);
  expect(profile.savedStep()).toBe("done");
  expect((await (await profile.open()).session.consentTo(true)).speech).not.toContain(LINES.name.ko);
});

it("test_practice_yes_opens_the_practice_form_and_finishes", async () => {
  const profile = setup("personal", "practice");
  const { session } = await profile.open();
  expect((await session.consentTo(true)).speech.endsWith(LINES["practice-offer"].ko)).toBe(true);
  expect((await session.handleTurn("네")).state).toBe("APPLICATION_OPEN");
  expect(session.dialogue.firstRun).toBeUndefined();
  expect(profile.savedStep()).toBe("done");
});

it("test_practice_no_finishes_quietly", async () => {
  const profile = setup("personal", "practice");
  const { session } = await profile.open();
  await session.consentTo(true);
  expect((await session.handleTurn("아니요")).speech).toBe(LINES["practice-no"].ko);
  expect(session.dialogue.firstRun).toBeUndefined();
  expect(profile.savedStep()).toBe("done");
});

it("test_call_name_stays_out_of_the_history_sent_to_models", async () => {
  const profile = setup();
  const { session } = await profile.open();
  await toStop(session);
  await session.handleTurn("멈춰");
  await session.handleTurn("네");
  expect(session.exportHistory().map(row => row.text).join(" ")).not.toContain("홍길동");
  expect(session.recentDialogue(20).join(" ")).not.toContain("홍길동");
  const again = (await profile.open()).session;
  expect((await again.consentTo(true)).speech).toMatch(/^홍길동님/u);
  expect(again.exportHistory().map(row => row.text).join(" ")).not.toContain("홍길동");
});
