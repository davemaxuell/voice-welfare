import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { REPO_ROOT } from "../../src/core/assets.ts";
import { DialogueState } from "../../src/core/dialogue.ts";
import { INTRO_POSES, IntroLineSchema } from "../../src/core/turn.ts";
import { callNameFrom, FirstRunGuide } from "../../src/orchestrator/first_run.ts";
import { INTRO, INTRO_NONAME, LINES } from "../../src/orchestrator/first_run_text.ts";

const fixture = z.object({
  names: z.array(z.tuple([z.string(), z.string().nullable()])),
  lines: z.record(z.string(), z.record(z.string(), z.string())),
  intro: z.array(z.tuple([z.string(), z.record(z.string(), z.string())])),
  noName: z.record(z.string(), z.string()),
  scenarios: z.array(z.object({ lang: z.string(), start: z.string(), replies: z.array(z.string()), persistent: z.boolean(), events: z.array(z.unknown()) })),
}).parse(JSON.parse(readFileSync(join(REPO_ROOT, "tests/fixtures/personal/first-run.json"), "utf8")));

it("test_call_name_from", () => {
  for (const [text, name] of fixture.names) expect(callNameFrom(text) ?? null, text).toBe(name);
});

it("test_every_line_and_intro_line_has_four_languages", () => {
  expect(LINES).toEqual(fixture.lines);
  expect(INTRO).toEqual(fixture.intro);
  expect(INTRO_NONAME).toEqual(fixture.noName);
  for (const line of [...Object.values(LINES), ...INTRO.map(([, line]) => line), INTRO_NONAME]) {
    expect(new Set(Object.keys(line))).toEqual(new Set(["en", "ja", "ko", "zh"]));
    for (const text of Object.values(line)) expect(text.trim().length).toBeGreaterThan(0);
  }
});

it("test_intro_poses_exist_in_the_avatar_model", () => {
  const model = readFileSync(join(REPO_ROOT, "web/public/avatar/cheongeum-avatar.glb"));
  const clips = z.object({ animations: z.array(z.object({ name: z.string() })) })
    .parse(JSON.parse(model.toString("utf8", 20, 20 + model.readUInt32LE(12)))).animations.map(clip => clip.name);
  expect(INTRO.map(([pose]) => pose)).toEqual(INTRO_POSES);
  for (const pose of INTRO_POSES) expect(clips).toContain(pose);
});

it("test_first_run_slot_is_pending_and_cleared_by_stop", () => {
  const dialogue = new DialogueState("IDLE");
  dialogue.askFirstRun("name");
  expect(dialogue.firstRun).toBe("name");
  expect(dialogue.hasPendingInteraction).toBe(true);
  dialogue.stop();
  expect(dialogue.firstRun).toBeUndefined();
});

it("test_end_first_run_clears_the_slot", () => {
  const dialogue = new DialogueState("IDLE");
  dialogue.askFirstRun("practice");
  dialogue.endFirstRun();
  expect(dialogue.firstRun).toBeUndefined();
  expect(dialogue.hasPendingInteraction).toBe(false);
});

it("continues the offered mic exercise for a greeting and yields the whole turn for a new request", () => {
  function begin() {
    const dialogue = new DialogueState("IDLE");
    const guide = new FirstRunGuide(dialogue, { step: "stage2", lang: () => "en",
      callName: () => undefined, remember: () => false, isCommand: () => false });
    expect(guide.offer()).toEqual(LINES.mic);
    expect(guide.offer()).toBeUndefined();
    return { dialogue, guide };
  }
  for (const greeting of ["안녕하세요!", "Hello!", "你好！", "こんにちは。"]) {
    const { dialogue, guide } = begin();
    expect(guide.answer(greeting)).toMatchObject({ speech: expect.stringContaining(LINES.name.en) });
    expect(dialogue.firstRun).toBe("name");
  }
  expect(begin().guide.answer("Skip")).toMatchObject({ speech: LINES.name.en });
  const { dialogue, guide } = begin();
  expect(guide.answer("Skip the introduction and open Gov24")).toBeUndefined();
  expect(dialogue.firstRun).toBeUndefined();
});

it("test_intro_draft_is_a_valid_turn_result_and_replay_has_no_offer", () => {
  const dialogue = new DialogueState("IDLE"), seen: string[] = [];
  const guide = new FirstRunGuide(dialogue, { progress: step => seen.push(step), lang: () => "ko",
    callName: () => undefined, remember: () => true, isCommand: () => false });
  const replay = z.array(IntroLineSchema).parse(guide.introDraft({ replay: true }).introScript);
  expect(replay).toHaveLength(7);
  expect(replay[0]?.text).toBe(INTRO_NONAME.ko);
  expect(replay.some(line => line.ask === true)).toBe(false);
  expect(dialogue.firstRun).toBeUndefined();
  expect(seen).toEqual([]);
  const first = guide.introDraft().introScript;
  expect(first).toHaveLength(8);
  expect(first?.at(-1)?.ask).toBe(true);
  expect(dialogue.firstRun).toBe("practice");
  expect(seen).toEqual(["practice"]);
});

it("remembers a volunteered name immediately in the optional guide and lets the user correct it", () => {
  const dialogue = new DialogueState("IDLE");
  const names: string[] = [];
  const guide = new FirstRunGuide(dialogue, { step: "name", lang: () => "en", callName: () => names.at(-1),
    remember: name => { names.push(name); return false; }, isCommand: () => false });
  guide.offer();
  expect(guide.answer("Call me Mary Jane")).toMatchObject({ speech: expect.stringContaining("Mary Jane") });
  expect(names).toEqual(["Mary Jane"]);
  expect(dialogue.firstRun).toBe("stop");
  expect(guide.answer("Change my name")).toMatchObject({ speech: LINES.name.en });
  expect(guide.answer("Jo")).toMatchObject({ speech: expect.stringContaining(LINES["name-shared"].en) });
  expect(names).toEqual(["Mary Jane", "Jo"]);
  expect(dialogue.firstRun).toBe("stop");
  guide.answer("Change my name");
  expect(guide.answer("Open Bokjiro")).toBeUndefined();
  expect(names).toEqual(["Mary Jane", "Jo"]);
  for (const refusal of ["My name is private", "제 이름은 저장하지 마세요"]) {
    guide.answer("Change my name");
    expect(guide.answer(refusal)).toBeUndefined();
    expect(names).toEqual(["Mary Jane", "Jo"]);
  }
  expect(guide.answer("Change my name")).toMatchObject({ speech: LINES.name.en });
  expect(guide.answer("I'm looking for help")).toBeUndefined();
  expect(names).toEqual(["Mary Jane", "Jo"]);
  guide.answer("Change my name");
  expect(guide.answer("Ada")).toMatchObject({ privateHistory: true });
  expect(dialogue.firstRun).toBeUndefined();
  expect(names).toEqual(["Mary Jane", "Jo", "Ada"]);
});

it.each([
  ["ko", "저를 지민이라고 불러 줘", "지민", "지민님"],
  ["en", "Please call me Mary Jane", "Mary Jane", "Mary Jane"],
  ["zh", "请叫我小王", "小王", "小王"],
  ["ja", "私を花子と呼んでください", "花子", "花子"],
])("accepts an explicit %s call name as the first optional onboarding reply", (lang, phrase, name, spoken) => {
  let remembered: string | undefined;
  const dialogue = new DialogueState("IDLE");
  const guide = new FirstRunGuide(dialogue, { step: "stage2", lang: () => lang, callName: () => remembered,
    remember: name => { remembered = name; return true; }, isCommand: () => false });
  guide.offer();
  expect(guide.answer(phrase)).toMatchObject({ privateHistory: true, speech: expect.stringContaining(spoken) });
  expect(remembered).toBe(name);
  expect(dialogue.firstRun).toBe("stop");
});

it("keeps name confirmation when action review is explicitly enabled", () => {
  const dialogue = new DialogueState("IDLE");
  const names: string[] = [];
  const guide = new FirstRunGuide(dialogue, { step: "name", lang: () => "ko", callName: () => names.at(-1),
    remember: name => { names.push(name); return true; }, isCommand: () => false });
  guide.offer({ reviewNames: true });
  guide.answer("홍길동");
  expect(dialogue.firstRun).toBe("name-confirm");
  expect(names).toEqual([]);
  guide.answer("네");
  expect(names).toEqual(["홍길동"]);
});

it("replays the reference onboarding dialogues, including a resumed session and a shared device", () => {
  for (const scenario of fixture.scenarios) {
    const dialogue = new DialogueState("IDLE");
    const progress: string[] = [], remembered: string[] = [], events: unknown[] = [];
    const guide = new FirstRunGuide(dialogue, { step: scenario.start, progress: step => progress.push(step),
      lang: () => scenario.lang, callName: () => remembered.at(-1),
      remember: name => { remembered.push(name); return scenario.persistent; }, isCommand: text => text === "다른 명령" });
    function record(result: unknown) {
      events.push({ result: result ?? null, slot: dialogue.firstRun ?? null, name: guide.pendingName ?? null,
        progress: [...progress], remembered: [...remembered] });
    }
    record(guide.begin());
    record(guide.begin());
    for (const reply of scenario.replies) {
      if (reply === "@stop") {
        const praise = guide.afterStop();
        dialogue.stop();
        if (praise !== undefined) guide.praised();
        record(praise);
      } else record(guide.answer(reply));
    }
    expect(events, scenario.lang + "/" + scenario.start).toEqual(scenario.events);
  }
});
