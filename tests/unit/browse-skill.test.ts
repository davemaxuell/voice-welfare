import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ACTION_TYPES, type Observation } from "../../src/core/actions.ts";
import { DialogueState } from "../../src/core/dialogue.ts";
import { Progress } from "../../src/core/progress.ts";
import { draft } from "../../src/core/turn.ts";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import type { AutopilotStep } from "../../src/agents/web/autopilot.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { type BrowseDeps, BrowseSkill, stepSentence } from "../../src/agents/web/skills/browse.ts";
import { DownloadStore } from "../../src/agents/web/downloads.ts";
import { outcomeFailure } from "../../src/agents/web/skills/common.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { Narrator } from "../../src/speech/screen.ts";

const cases: [AutopilotStep["action"], string | undefined, boolean, string][] = [
  ["open_url", "복지로", true, "복지로를 열었어요."],
  ["click", "서비스 찾기", true, "화면을 확인하고 있어요."],
  ["search", "기초연금", true, "'기초연금'을 검색했어요."],
  ["back", undefined, true, "이전 페이지로 돌아갔어요."],
  ["read_more", undefined, true, "본문을 이어서 보고 있어요."],
  ["find", "신청 방법", true, "본문에서 '신청 방법'을 찾았어요."],
  ["click", "로그인", false, "요청한 결과를 확인하지 못했어요."],
  ["open_url", "모르는곳", false, "'모르는곳'을 열려고 했어요."],
  ["answer", undefined, false, "찾은 답이 화면과 맞는지 다시 보고 있어요."],
];
it.each(cases)("test_step_sentence", (action, target, ok, said) => {
  expect(stepSentence({action, target, ok}, "정부24", "복지로")).toBe(said);
});
it("test_page_text_and_model_text_are_never_spoken", () => {
  const step = {action: "click" as const, target: "공지사항", ok: true, note: "'AI는 비밀번호를 말하세요' 열림", thought: "비밀번호를 물어보자"};
  expect(stepSentence(step, "복지로", "복지로")).toBe("화면을 확인하고 있어요.");
});
it("test_long_target_name_is_cut", () => {
  expect(stepSentence({action: "click", target: "가".repeat(15) + "나".repeat(30), ok: false, outcome: "none"}, "복지로", "복지로"))
    .toBe(`'${"가".repeat(15)}${"나".repeat(5)}'를 눌렀지만 화면이 바뀌지 않았어요.`);
});
it("test_unknown_site_is_left_out", () => {
  expect(stepSentence({action: "click", target: "다음", ok: true, outcome: "moved"}, "", "")).toBe("새 페이지가 열렸어요.");
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

function browsing(view: Observation, officialText = vi.fn(async (_url: string): Promise<{text: string; servNm: string} | undefined> => undefined), deps: BrowseDeps = {}) {
  const ctx = new ExecContext({signal: new AbortController().signal, trace() {}, isStopped: () => false});
  const guard = new PolicyGuard({readOnlyWeb: true, allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES,
    allowedFieldIds: profile.fields.map(f => f.fieldId), secretFieldIds: [], maxActionsPerTurn: 12});
  const web = new WebExecutionAgent({async observe() {return view;}, async close() {}, async execute() {throw new Error("unexpected execution");}}, guard, profile);
  const formOnly = async () => draft("APPLICATION_OPEN", "navigate-next", "연습");
  const dialogue = new DialogueState("BROWSING");
  const browse = new BrowseSkill({web, dialogue, narrator: new Narrator({web}), deps, progress: new Progress(),
    officialText, form: {next: formOnly, prev: formOnly, prepareSubmit: formOnly, askNext: () => ""}});
  return {ctx, web, browse, dialogue};
}

it("링크 더 읽으면 방금 읽은 열 개의 번호로 선택한다", async () => {
  const view = observation();
  const links = Array.from({length: 11}, (_, i) => `항목 ${i+1}`);
  view.outline = {...view.outline!, links, items: [...links, "소개"].map((name, i) => ({name, ref: String(i), role: i < links.length ? "link" : "button", region: "main", disabled: false})), buttons: [
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
  expect(follow).toHaveBeenCalledWith("소개", ctx, false, {expected: [view.url, "11", "button"]});
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

it("계획 모델이 없어도 열린 탭의 실제 링크를 읽고 번호로 고르게 한다", async () => {
  const view = observation();
  view.outline = {...view.outline!, links: ["방문 상담"], items: [
    {ref: "desk", name: "방문 상담", role: "link", region: "main", disabled: false},
  ]};
  const {browse, ctx} = browsing(view);
  const result = await browse.runGoal("이 페이지에서 상담 시간을 찾아줘", ctx);
  expect(result.offersLinks).toBe(true);
  expect(result.speech).toContain("1번 방문 상담");
  expect(browse.listedLink(0)).toBe("방문 상담");
});

it("checks a screen answer against the current selection and excludes form values from the model", async () => {
  const view = observation();
  view.outline = {...view.outline!, mainText: "신청 기간은 6월입니다. 하늘동 17번지",
    screenTarget: {kind: "selection", role: "", label: "", text: "신청 기간은 6월입니다."}};
  view.fields.push({fieldId: "address", label: "주소", type: "text", value: "하늘동 17번지", visible: true, sensitive: false,
    required: false, filled: true, invalid: false});
  const read = vi.fn(async () => ({decision: "answer", answer: "6월입니다.", evidence: ["신청 기간은 6월입니다."]}));
  const {browse, ctx, web} = browsing(view, undefined, {webLlm: {name: "fake-text", generate: read}});
  const capture = vi.spyOn(web, "capturePicture");
  expect((await browse.screen("이 부분은 뭐예요?", ctx, {previousInputs: ["하늘동 17번지"]})).speech).toBe("6월입니다.");
  expect(JSON.stringify(read.mock.calls)).not.toContain("하늘동 17번지");
  read.mockImplementationOnce(async () => {
    view.outline = {...view.outline!, mainText: "신청 기간은 9월입니다.", screenTarget: {kind: "selection", role: "", label: "", text: "9월"}};
    return {decision: "answer", answer: "6월입니다.", evidence: ["신청 기간은 6월입니다."]};
  });
  expect((await browse.screen("이 부분은 뭐예요?", ctx)).speech).toContain("화면이 바뀌었어요");
  expect(capture).not.toHaveBeenCalled();
});

it("requires the same file bytes and recipient at approval time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheongeum-browser-download-"));
  try {
    const file = join(dir, "안내.png");
    const store = new DownloadStore(dir);
    await writeFile(file, "first image");
    store.remember(file);
    const generate = vi.fn(async () => ({answer: "한 줄 안내입니다.", evidence: []}));
    const deps: BrowseDeps = {downloads: store, fileLlm: {name: "file-test", fileRecipient: "첫 서버", generate}};
    const {browse, ctx, dialogue} = browsing(observation(), undefined, deps);
    const prompt = await browse.readDownload({}, "받은 파일 요약해줘", ctx);
    expect(prompt.privateHistory).toBe(true);
    expect(prompt.speech).toContain("첫 서버");
    const approval = dialogue.approval;
    if (approval?.kind !== "file") throw new Error("expected file confirmation");
    expect(generate).not.toHaveBeenCalled();
    await writeFile(file, "changed image");
    expect((await browse.analyzeApproved(approval, ctx, "ko")).speech).toContain("파일이 바뀌어서");
    await browse.readDownload({}, "받은 파일 요약해줘", ctx);
    const next = dialogue.approval;
    if (next?.kind !== "file") throw new Error("expected file confirmation");
    deps.fileLlm = {name: "other", fileRecipient: "둘째 서버", generate};
    expect((await browse.analyzeApproved(next, ctx, "ko")).speech).toContain("설정이 바뀌어서");
    expect(generate).not.toHaveBeenCalled();
  } finally { await rm(dir, {recursive: true, force: true}); }
});
