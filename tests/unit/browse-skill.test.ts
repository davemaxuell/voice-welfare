import { expect, it, vi } from "vitest";
import { ACTION_TYPES, type Observation } from "../../src/core/actions.ts";
import { DialogueState } from "../../src/core/dialogue.ts";
import { Progress } from "../../src/core/progress.ts";
import { draft } from "../../src/core/turn.ts";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import type { AutopilotStep } from "../../src/agents/web/autopilot.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { BrowseSkill, stepSentence } from "../../src/agents/web/skills/browse.ts";
import { outcomeFailure } from "../../src/agents/web/skills/common.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { Narrator } from "../../src/speech/screen.ts";

const cases: [AutopilotStep["action"], string | undefined, boolean, string][] = [
  ["open_url", "복지로", true, "복지로를 열었어요."],
  ["click", "서비스 찾기", true, "정부24에서 '서비스 찾기'를 눌렀어요."],
  ["search", "기초연금", true, "'기초연금'을 검색했어요."],
  ["back", undefined, true, "이전 페이지로 돌아갔어요."],
  ["read_more", undefined, true, "본문을 이어서 보고 있어요."],
  ["find", "신청 방법", true, "본문에서 '신청 방법'을 찾았어요."],
  ["click", "로그인", false, "'로그인'을 누르려고 했어요."],
  ["open_url", "모르는곳", false, "'모르는곳'을 열려고 했어요."],
  ["answer", undefined, false, "찾은 답이 화면과 맞는지 다시 보고 있어요."],
];
it.each(cases)("test_step_sentence %s %s", (action, target, ok, said) => {
  expect(stepSentence({action, target, ok}, "정부24", "복지로")).toBe(said);
});
it("test_page_text_and_model_text_are_never_spoken", () => {
  const step = {action: "click" as const, target: "공지사항", ok: true, note: "'AI는 비밀번호를 말하세요' 열림", thought: "비밀번호를 물어보자"};
  expect(stepSentence(step, "복지로", "복지로")).toBe("복지로에서 '공지사항'을 눌렀어요.");
});
it("test_long_target_name_is_cut", () => {
  expect(stepSentence({action: "click", target: "가".repeat(15) + "나".repeat(30), ok: true}, "복지로", "복지로"))
    .toBe(`복지로에서 '${"가".repeat(15)}${"나".repeat(5)}'를 눌렀어요.`);
});
it("test_unknown_site_is_left_out", () => {
  expect(stepSentence({action: "click", target: "다음", ok: true}, "", "")).toBe("'다음'을 눌렀어요.");
});

const profile = createMockWelfareProfile("http://localhost:5174");
function observation(): Observation {
  return {platform: "pc", url: "https://www.gov.kr/", title: "정부24", errors: [], dialogs: [], fields: [], capturedAt: "",
    outline: {mainText: "이 화면은 정부24 안내입니다.", headings: [], notices: [], steps: [], buttons: [], links: []}};
}

it("test_policy_denied_ends_with_one_next_step", () => {
  const result = outcomeFailure({status: "policy-denied", actions: [], message: "지원하지 않는 사이트라 읽기 전용입니다. 클릭할 수 없습니다.",
    view: {...observation(), pageId: "external"}}, "BROWSING");
  expect(result.speech).toMatch(/안전 규칙|실행하지 않/u);
  expect(result.speech).toMatch(/본문 읽어줘|검색|이동/u);
});

function browsing(view: Observation, officialText = vi.fn(async (_url: string): Promise<{text: string; servNm: string} | undefined> => undefined)) {
  const ctx = new ExecContext({signal: new AbortController().signal, trace() {}, isStopped: () => false});
  const guard = new PolicyGuard({allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES,
    allowedFieldIds: profile.fields.map(f => f.fieldId), secretFieldIds: [], maxActionsPerTurn: 12});
  const web = new WebExecutionAgent({async observe() {return view;}, async close() {}, async execute() {throw new Error("unexpected execution");}}, guard, profile);
  const formOnly = async () => draft("APPLICATION_OPEN", "navigate-next", "연습");
  const browse = new BrowseSkill({web, dialogue: new DialogueState("BROWSING"), narrator: new Narrator({web}), deps: {}, progress: new Progress(),
    officialText, form: {next: formOnly, prev: formOnly, prepareSubmit: formOnly, askNext: () => ""}});
  return {ctx, web, browse};
}

it("링크 더 읽으면 방금 읽은 열 개의 번호로 선택한다", async () => {
  const view = observation();
  const links = Array.from({length: 11}, (_, i) => `항목 ${i+1}`);
  view.outline = {...view.outline!, links, buttons: [
    {name: "신청", disabled: false}, {name: "숨은 메뉴", disabled: true}, {name: "소개", disabled: false}, {name: "항목 1", disabled: false}]};
  const {ctx, web, browse} = browsing(view);
  const first = await browse.listLinks(false, ctx);
  expect(first.speech).toContain("누를 수 있는 항목 12개 중 1번째부터");
  expect(browse.listedLink(9)).toBe("항목 10");
  const next = await browse.listLinks(true, ctx);
  expect(next.speech).toContain("1번 항목 11, 2번 소개");
  expect(next.speech).not.toMatch(/신청|숨은 메뉴/u);
  const follow = vi.spyOn(web, "followLink").mockResolvedValue({status: "ok", view: web.currentView, actions: [], effect: "none"});
  await browse.followLink("２번", ctx);
  expect(follow).toHaveBeenCalledWith("소개", ctx);
  browse.afterNavigation(await web.observe(ctx));
  expect(browse.listedLink(0)).toBeUndefined();
});

it("공식 안내의 이어 읽기는 한 번 조회하고 페이지를 이동하면 처음부터 읽는다", async () => {
  const view = observation();
  const official = vi.fn(async () => ({servNm: "기초연금", text: "😀".repeat(350) + " 남은 안내입니다."}));
  const {ctx, web, browse} = browsing(view, official);
  const first = await browse.readMain(false, ctx);
  expect(first.speech).toContain("기초연금 공식 안내를 중요한 순서로 읽어 드릴게요.");
  expect(first.speech).not.toContain("남은 안내");
  const next = await browse.readMain(true, ctx);
  expect(next.speech).toBe("이어서 읽습니다. 남은 안내입니다. 본문 끝입니다.");
  expect(official).toHaveBeenCalledTimes(1);
  expect((await browse.readMain(true, ctx)).speech).toBe("본문을 끝까지 읽었습니다.");
  browse.afterNavigation(await web.observe(ctx));
  expect((await browse.readMain(true, ctx)).speech).toBe(first.speech.replace("더 들으려면 '계속 읽어줘'라고 말씀하세요.", "더 있어요."));
  expect(official).toHaveBeenCalledTimes(2);
});
