// tests/e2e/test_first_run_ui.py의 단계 규칙을 화면 없이 확인한다(같은 제목). 키 입력은 key(), 단계가 바뀐 직후의 잠깐은 settle().
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { Settings, SettingsInput } from "../../web/src/api.ts";
import { createFirstRun } from "../../web/src/first-run.ts";
import { REPO_ROOT } from "../../src/core/assets.ts";

const MANIFEST = z.record(z.string(), z.record(z.string(), z.string())).parse(JSON.parse(readFileSync(join(REPO_ROOT, "web/public/setup-audio/manifest.json"), "utf8")));
const STAGE1: Partial<Settings> = { language: "ko", region: "", speed: 1.35, rememberService: false, deviceUse: "unidentified", browser: "separate", hasKey: false };
const STAGE2: Partial<Settings> = { ...STAGE1, deviceUse: "personal", hasKey: true };

function setup(prefs: Partial<Settings>, { check = "ok", desktop }: { check?: string; desktop?: { setAutoStart(on: boolean): void } } = {}) {
  const timers: (() => void)[] = [];
  const saved: SettingsInput[] = [];
  const guardians: { name: string; phone: string }[] = [];
  const spoken: string[] = [];
  const clips: string[] = [];
  const rates: number[] = [];
  const consent = vi.fn(() => Promise.resolve());
  const machine = createFirstRun({
    desktop,
    speak: (text, _lang, speed) => { spoken.push(text); rates.push(speed); return Promise.resolve(); },
    stopSpeaking: () => {},
    onSaved: () => Promise.resolve(),
    onConsentReady: consent,
    loadManifest: () => Promise.resolve(MANIFEST),
    playClip: (src, speed) => { clips.push(src); rates.push(speed); return Promise.resolve(); },
    pauseClip: () => {},
    settings: () => Promise.resolve(prefs),
    checkKey: () => Promise.resolve(check),
    saveSettings: (values) => { saved.push(values); return Promise.resolve(); },
    saveGuardian: (contact) => { guardians.push(contact); return Promise.resolve(); },
    setTimer: (fn) => { timers.push(fn); },
  });
  const settle = () => { for (const fn of timers.splice(0)) fn(); };
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));
  /** 키를 누르고 할 일이 끝날 때까지 기다린 뒤 단계가 자리 잡게 한다(Python 테스트의 answer). */
  const answer = async (key: string) => {
    machine.key(key, false);
    await flush();
    settle();
  };
  const step = () => machine.snapshot().step;
  return { machine, saved, guardians, spoken, clips, rates, consent, settle, flush, answer, step };
}

async function toKeyStep(run: ReturnType<typeof setup>, who = "1") {
  await run.machine.start(1);
  run.settle();
  await run.answer("1");
  await run.answer(who);
  expect(run.step()).toBe("key");
}

it.each([false, true])("첫 실행의 네 언어 안내는 저장된 빠르기를 지키고 키가 있으면 같은 음성 API를 쓴다 (%s)", async hasKey => {
  const run = setup({ ...STAGE1, speed: 0.85, hasKey });
  await run.machine.start(1);
  await run.flush();
  expect(run.rates).toEqual([0.85, 0.85, 0.85, 0.85]);
  expect(run.spoken).toHaveLength(hasKey ? 4 : 0);
  expect(run.clips).toHaveLength(hasKey ? 0 : 4);
});

it("test_user_alone_finishes_stage1_with_keys_only", async () => {
  const run = setup(STAGE1);
  await toKeyStep(run);
  expect(run.machine.snapshot().focus.target).toBe("key");
  await run.machine.submitKey("sk-test-alone");
  run.settle();
  expect(run.step()).toBe("pc");
  await run.answer("1");
  expect(run.step()).toBe("sound");
  expect(run.saved).toEqual([{ apiKey: "sk-test-alone", language: "ko", region: "", speed: 1.35, deviceUse: "personal", browser: "separate", rememberService: false }]);
});

it("test_wrong_key_stays_on_key_step_with_reason", async () => {
  const run = setup(STAGE1, { check: "invalid" });
  await toKeyStep(run);
  await run.machine.submitKey("sk-wrong");
  expect(run.machine.snapshot().live.text).toContain("키가 맞지 않아요");
  expect(run.step()).toBe("key");
  expect(run.machine.snapshot().focus.target).toBe("key");
  expect(run.clips).toContain("/setup-audio/ko/key-invalid.mp3");
  expect(run.saved).toEqual([]);
});

it("test_double_key_press_answers_one_step", async () => {
  const run = setup(STAGE1);
  await run.machine.start(1);
  run.settle();
  run.machine.key("1", false);
  run.machine.key("1", false);
  expect(run.step()).toBe("who");
  run.settle();
  expect(run.step()).toBe("who");
});

it("test_each_choice_step_moves_focus_to_its_heading_and_reads_the_clip_text", async () => {
  const run = setup(STAGE1);
  await run.machine.start(1);
  run.settle();
  await run.answer("1");
  expect(run.step()).toBe("who");
  expect(run.machine.snapshot().focus.target).toBe("step");
  expect(run.machine.snapshot().live.text).toBe("지금 누가 설정하고 계세요? 사용하실 분 본인이면 1번, 가족이나 복지관 직원이면 2번.");
  expect(run.machine.snapshot().choices.map(c => [c.kbd, c.label])).toEqual([["1", "사용하실 분 본인"], ["2", "가족이나 복지관 직원"]]);
});

it("test_esc_goes_back_one_step", async () => {
  const run = setup(STAGE1);
  await run.machine.start(1);
  run.settle();
  await run.answer("1");
  expect(run.machine.key("Escape", false)).toBe(true);
  expect(run.step()).toBe("language");
});

it("test_helper_path_saves_extras_then_hands_over", async () => {
  const run = setup(STAGE1);
  await toKeyStep(run, "2");
  expect(run.machine.snapshot().keyForm?.help?.link).toBe("키 받는 방법");
  await run.machine.submitKey("sk-test-helper");
  run.settle();
  await run.answer("1");
  expect(run.step()).toBe("browser");
  await run.answer("1");
  expect(run.step()).toBe("guardian");
  expect(run.machine.snapshot().focus.target).toBe("guardian-name");
  await run.machine.submitGuardian("홍길동", "010-1122-3344");
  run.settle();
  expect(run.step()).toBe("handover");
  expect(run.saved.at(-1)).toMatchObject({ browser: "chrome", deviceUse: "personal" });
  expect(run.guardians).toEqual([{ name: "홍길동", phone: "010-1122-3344" }]);
  await run.answer("Enter");
  expect(run.step()).toBe("sound");
});

it("test_shared_pc_skips_browser_and_guardian", async () => {
  const run = setup(STAGE1);
  await toKeyStep(run, "2");
  await run.machine.submitKey("sk-test-helper");
  run.settle();
  await run.answer("2");
  expect(run.step()).toBe("handover");
  expect(run.saved.at(-1)).toMatchObject({ deviceUse: "shared", browser: "separate" });
  expect(run.guardians).toEqual([]);
});

it("test_guardian_can_be_skipped", async () => {
  const run = setup(STAGE1);
  await toKeyStep(run, "2");
  await run.machine.submitKey("sk-test-helper");
  run.settle();
  await run.answer("1");
  await run.answer("2");
  expect(run.step()).toBe("guardian");
  run.machine.skipGuardian();
  expect(run.step()).toBe("handover");
  expect(run.saved.at(-1)).toMatchObject({ browser: "separate" });
  expect(run.guardians).toEqual([]);
});

it("도와주는 분이 데스크톱 앱에서 설정하면 자동 실행을 묻고 저장한다", async () => {
  const setAutoStart = vi.fn();
  const run = setup(STAGE1, { desktop: { setAutoStart } });
  await toKeyStep(run, "2");
  await run.machine.submitKey("sk-test-helper");
  run.settle();
  await run.answer("2");
  expect(run.step()).toBe("autostart");
  await run.answer("1");
  expect(setAutoStart).toHaveBeenCalledWith(true);
  expect(run.step()).toBe("handover");
});

it("test_reopening_in_stage2_resumes_at_sound_check", async () => {
  const run = setup(STAGE2);
  await run.machine.start(2);
  expect(run.step()).toBe("sound");
  expect(run.spoken).toContain("제 목소리가 들리시면 Enter를 눌러 주세요.");
});

it("test_speed_keys_change_and_save_speed_then_consent", async () => {
  const run = setup(STAGE2);
  await run.machine.start(2);
  run.settle();
  await run.answer("Enter");
  expect(run.step()).toBe("speed");
  await run.answer("3");
  expect(run.machine.snapshot().live.text).toContain("1.6");
  expect(run.machine.snapshot().speed).toBe("1.6×");
  await run.answer("2");
  expect(run.saved.at(-1)?.speed).toBe(1.6);
  expect(run.consent).toHaveBeenCalledOnce();
});

it("test_three_replays_show_the_sound_help", async () => {
  const run = setup(STAGE2);
  await run.machine.start(2);
  for (let i = 0; i < 3; i++) {
    run.settle();
    run.machine.key(" ", false);
  }
  expect(run.machine.snapshot().soundHelp).toContain("스피커 연결과 소리 크기");
});

it("입력란에서 누른 숫자는 단계 답이 아니다", async () => {
  const run = setup(STAGE1);
  await toKeyStep(run);
  expect(run.machine.key("1", true)).toBe(false);
  expect(run.step()).toBe("key");
});
