import { expect, it, vi } from "vitest";
import { ACTION_TYPES, type Action } from "../../src/core/actions.ts";
import { Progress } from "../../src/core/progress.ts";
import type { LlmRequest } from "../../src/core/llm.ts";
import { ExecContext, WebExecutionAgent, type PageView, type WebOutcome } from "../../src/agents/web/agent.ts";
import { Autopilot, type AutopilotOptions } from "../../src/agents/web/autopilot.ts";
import { BrowserJourney, personalScrubber } from "../../src/agents/web/journey.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";

const portal = "https://portal.invalid";
const goal = "제 접수 상태를 확인해 주세요.";
const action = (type: Action["type"]): Action => ({ type, id: type, risk: "low", requiresConfirmation: false, reason: type });
const link = (name: string) => ({ ref: name, name, role: "link" as const, region: "main" as const, disabled: false });
function page(url: string, title: string, text: string, names: string[] = []): PageView {
  return {
    pageId: "external", url: portal + url, title, platform: "pc", fields: [], errors: [], dialogs: [], capturedAt: "",
    outline: { headings: [], notices: [], steps: [], buttons: [], links: names, items: names.map(link), mainText: text },
  };
}
const ctx = () => Object.assign(new ExecContext({
  signal: new AbortController().signal, isStopped: () => false, trace() {},
}), { browsingScope: "personal-inspection" as const });
function fixture(initial: PageView, decisions: (request: LlmRequest) => unknown, options: Partial<AutopilotOptions> = {}) {
  let current = initial;
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [], secretFieldIds: [], maxActionsPerTurn: 30 });
  const web = new WebExecutionAgent({ observe: async () => current, async execute() { throw new Error("예상 밖의 조작"); }, async close() {} }, guard, profile);
  vi.spyOn(web, "observe").mockImplementation(async () => current);
  const inputs: string[] = [];
  const searchUrl = vi.fn(() => "https://search.invalid/");
  const pilot = new Autopilot(web, { name: "test", async generate(request) { inputs.push(request.user); return decisions(request); } }, { searchUrl, ...options });
  const move = (view: PageView, type: Action["type"]): WebOutcome => {
    current = view;
    return { status: "ok", effect: "moved", view, actions: [{
      agent: web.id, policy: { allowed: true, code: "ALLOWED", reason: "" }, action: action(type), result: { actionId: type, ok: true, verified: true, latencyMs: 1 },
    }] };
  };
  return { web, pilot, inputs, searchUrl, move };
}

it("stops a personal journey before reading or sending a page in a public-only context", async () => {
  const f = fixture(page("/account", "회원 화면", "private"), () => ({}));
  const out = await f.pilot.run(goal, new ExecContext({...ctx(), publicLookup: true}));
  expect(out).toMatchObject({status: "failed", iterations: 0, actions: []});
  expect(f.web.observe).not.toHaveBeenCalled();
  expect(f.inputs).toEqual([]);
});

it("applies the local privacy scanner to retained screen labels and controls", async () => {
  const secret = "GardenAster";
  const scanner = {async scan(texts: readonly string[]) {
    return texts.map(text => text.includes(secret) ? [["health", text.indexOf(secret), text.indexOf(secret) + secret.length] as const] : []);
  }};
  const f = fixture(page("/desk", secret, "요청을 확인 중입니다.", [secret]), () => ({action: "fail"}), {scanner});
  await f.pilot.run(goal, ctx());
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]).not.toContain(secret);
  expect(JSON.parse(f.inputs[0]!).journey.current.title).toBe("[비공개]");
});

it("can verify arrival on a screen with just a title without inventing a status fact", async () => {
  const f = fixture(page("/desk", "나의 민원함", ""), () => ({action: "answer", answer: "민원함에 도착했어요.", evidence: ["나의 민원함"]}));
  const result = await f.pilot.run("내 민원함 열어 줘", ctx(), undefined, {inspectionOutcome: "arrival"});
  expect(result).toMatchObject({status: "answered", reviewQuotes: []});
  expect(result.reviewPages.at(-1)?.title).toBe("나의 민원함");
});

it("accepts a personal clarification in the resident's selected language", async () => {
  const f = fixture(page("/desk", "Service desk", ""), () => ({action: "ask_user", answer: "Which record would you like me to check?"}));
  const result = await f.pilot.run("Check my record", ctx(), undefined, {replyLanguage: "en"});
  expect(result).toMatchObject({status: "asked", iterations: 1, speech: "Which record would you like me to check?"});
});

it("잘못 들어간 화면에서 돌아와 인증을 맡긴 뒤 다른 경로의 확인 화면에서 답한다", async () => {
  const initial = page("/", "서비스", "시작 화면", ["안내", "접수 확인"]);
  const detour = page("/help", "공개 안내", "일반 이용 방법");
  const auth = page("/login?next=privateContinue", "로그인", "사용자 암호 입력");
  const detail = page("/entry/CASE-443761?session=PrivateToken55", "접수 상태",
    "CASE-443761 PrivateToken55 숨긴 이름 /entry/CASE-443761\n처리 상태는 검토 중입니다.");
  let requests = 0;
  const f = fixture(initial, request => {
    const current = JSON.parse(request.user);
    requests++;
    if (current.page.title === "공개 안내") return { action: "fail", assessment: "dead_end" };
    if (current.page.title === "접수 상태") {
      expect(current.journey).toMatchObject({
        resumed: true, blockedBy: null, currentSubgoal: "접수 상태 화면",
        subgoalsCompleted: ["사용자가 직접 인증을 마침"],
        visited: expect.arrayContaining([expect.objectContaining({ title: "공개 안내" }), expect.objectContaining({ title: "접수 상태" })]),
      });
      return { action: "answer", answer: "현재 검토 중입니다.", evidence: ["처리 상태는 검토 중입니다."] };
    }
    return { action: "click", target: requests === 1 ? "안내" : "접수 확인", expected: "접수 상태 화면" };
  });
  const follow = vi.spyOn(f.web, "followLink").mockImplementation(async name => f.move(name === "안내" ? detour : auth, "click"));
  const back = vi.spyOn(f.web, "back").mockImplementation(async () => f.move(initial, "back"));
  const journey = new BrowserJourney(8);
  const options = { journey, privateValues: ["숨긴 이름"] };
  const first = await f.pilot.run(goal, ctx(), undefined, options);
  expect(first.view?.title).toBe("로그인");
  expect(journey.blockedBy).toBe("auth");
  expect(journey.returnOrigin).toBe(portal);
  expect(back).toHaveBeenCalledTimes(1);
  expect(follow.mock.calls.map(([name]) => name)).toEqual(["안내", "접수 확인"]);
  expect(f.inputs.join("\n")).not.toContain("privateContinue");

  f.move(detail, "navigate");
  journey.resumeAfterAuth();
  const result = await f.pilot.run(goal, ctx(), undefined, options);
  expect(result).toMatchObject({ status: "answered", speech: "현재 검토 중입니다.", sources: [{ url: portal + "/", title: "접수 상태" }] });
  expect(result.reviewQuotes).toEqual(["처리 상태는 검토 중입니다."]);
  expect(journey.remaining).toBe(4);
  for (const privateText of ["/entry", "CASE-443761", "PrivateToken55", "숨긴 이름", "사용자 암호 입력"]) {
    expect(JSON.stringify([f.inputs, result.reviewPages, Object.fromEntries(result.quoteSources)])).not.toContain(privateText);
  }
});

it("주소가 같아도 탭을 구분하고 읽기 한도와 실패 기록을 인증 뒤에도 유지한다", () => {
  const a = page("/account", "내 정보", "요약");
  const b = page("/account", "내 정보", "신청 내용");
  for (const [view, selected] of [[a, "요약"], [b, "신청"]] as const) {
    view.outline!.items = ["요약", "신청"].map(name => ({ ...link(name), role: "tab", selected: name === selected }));
  }
  const journey = new BrowserJourney(4);
  journey.reservePersonalInspection();
  journey.observe(a, personalScrubber(a), true);
  journey.takeStep();
  journey.begin("click", "신청", 0, "접수 상태");
  journey.observe(b, personalScrubber(b), true);
  journey.finish(true, true, false);
  expect(journey.assess("dead_end")).toBe(true);
  expect(journey.canBack).toBe(false);
  const [attempt] = journey.context(goal).recent;
  expect(attempt?.before?.selected).toEqual(["요약"]);
  expect(attempt?.after?.selected).toEqual(["신청"]);
  expect(attempt?.before?.id).not.toEqual(attempt?.after?.id);

  for (const position of [0, 1500]) {
    journey.takeStep();
    journey.begin("read_more", undefined, position);
    journey.finish(true, false, false);
  }
  expect(journey.context(goal).budgets).toMatchObject({ portal: 0, inspection: 1 });
  expect(journey.admit("click")).toBe(false);
  journey.pause("captcha", portal + "/challenge");
  journey.resumeAfterAuth();
  journey.observe(a, personalScrubber(a), true);
  expect(journey.remaining).toBe(1);
  expect(journey.admit("answer")).toBe(true);
  expect(journey.canTry("read_more", undefined, 0)).toBe(false);
  expect(journey.canTry("click", "신청", 0)).toBe(false);
});

it("같은 사이트의 안전한 검색만 시도하고 실패하면 외부 검색으로 넘기지 않는다", async () => {
  const initial = page("/", "서비스", "검색");
  initial.fields = [{ fieldId: "query", value: "", searchable: true, visible: true, required: false, filled: false,
    invalid: false, sensitive: false, type: "search", label: "검색" }];
  let requests = 0;
  const f = fixture(initial, () => {
    requests++;
    if (requests === 1) return { action: "search", target: "private customer" };
    if (requests === 2) return { action: "search", target: "신청 메뉴" };
    return { action: "fail", answer: "화면에서 확인하지 못했어요." };
  });
  const search = vi.spyOn(f.web, "search").mockResolvedValue({ status: "failed", view: initial, actions: [] });
  const result = await f.pilot.run(goal, ctx(), undefined, { privateValues: ["private customer"] });
  expect(result.status).toBe("failed");
  expect(search.mock.calls.map(([query]) => query)).toEqual(["신청 메뉴"]);
  expect(f.searchUrl).not.toHaveBeenCalled();
  expect(f.inputs.join("\n")).not.toContain("private customer");
});

it("승인이 필요한 항목에서 다른 길을 선택하면 승인을 요청하지 않는다", async () => {
  const initial = page("/", "서비스", "업무 화면", ["내역", "접수 보기"]);
  const detail = page("/records", "접수 상태", "진행 상태는 검토 중입니다.");
  const f = fixture(initial, request => {
    const payload = JSON.parse(request.user);
    if (payload.page.title === "접수 상태") return { action: "answer", answer: "검토 중입니다.", evidence: ["진행 상태는 검토 중입니다."] };
    return { action: "click", target: payload.journey.recent.some((attempt: { outcome: string }) =>
      attempt.outcome === "approval_required") === true ? "접수 보기" : "내역" };
  });
  const follow = vi.spyOn(f.web, "followLink").mockImplementation(async name => name === "내역" ?
    { status: "needs-approval", view: initial, actions: [], pending: action("click") } : f.move(detail, "click"));
  const result = await f.pilot.run(goal, ctx());
  expect(result.status).toBe("answered");
  expect(follow.mock.calls.map(([name]) => name)).toEqual(["내역", "접수 보기"]);
});

it("빈 화면에서 기관 이름만 검색해 확인된 공식 후보를 연다", async () => {
  const blank = { ...page("/", "", ""), pageId: "blank" as const, url: "about:blank" };
  const entry = "https://entry.example.go.kr/";
  const official = { ...page("/", "처리 지원", "사용 방법"), url: entry };
  const discoverPortal = vi.fn(async () => [
    { url: "https://unapproved.invalid/?q=private", title: "공식이라고 주장하는 후보" },
    { url: entry + "detail?q=private", title: "기관 공식 누리집" },
  ]);
  const answers = [
    { action: "find_portal", target: "접수 번호 PRIVATE-5573" },
    { action: "open_url", target: "https://unapproved.invalid/" },
    { action: "open_url", target: "entry.example.go.kr" },
    { action: "fail", answer: "화면에서 답을 확인하지 못했어요." },
  ];
  const milestone = vi.fn();
  const generate = vi.fn();
  const progress = Object.assign(new Progress(), { milestone });
  const f = fixture(blank, () => answers.shift(), {
    discoverPortal, progress, activityLlm: { name: "activity", generate },
    milestoneText: key => key === "discover" ? "Finding the agency website." : "The site is open.",
  });
  const open = vi.spyOn(f.web, "openSite").mockImplementation(async () => f.move(official, "navigate"));
  const result = await f.pilot.run(goal + " PRIVATE-5573", ctx(), undefined, { discoveryAgency: "처리 지원 기관" });
  expect(result.view?.url).toBe(entry);
  expect(discoverPortal.mock.calls).toEqual([["처리 지원 기관", expect.any(AbortSignal)]]);
  expect(open.mock.calls.map(([url]) => url)).toEqual([entry]);
  expect(milestone.mock.calls).toEqual([["discover", "Finding the agency website."], ["entered", "The site is open."]]);
  expect(generate).not.toHaveBeenCalled();
  expect(f.inputs.join("\n")).not.toContain("unapproved.invalid");

  discoverPortal.mockClear();
  const ungrounded = fixture(blank, () => ({ action: "find_portal", target: "처리 지원 기관" }), { discoverPortal, maxSteps: 2 });
  await ungrounded.pilot.run(goal, ctx());
  expect(discoverPortal).not.toHaveBeenCalled();
});

it("현재 화면의 짧은 인용으로 부정을 뒤집을 수 없고 전체 행을 근거로 보낸다", async () => {
  const status = "신청 결과는 승인되지 않았습니다.";
  const record = page("/info", "처리 결과", status);
  const answers = [
    { action: "answer", answer: "승인되었습니다.", evidence: ["승인"] },
    { action: "answer", answer: "승인되지 않았어요.", evidence: [status] },
  ];
  const f = fixture(record, () => answers.shift());
  const result = await f.pilot.run(goal, ctx());
  expect(result).toMatchObject({ status: "answered", speech: "승인되지 않았어요.", reviewQuotes: [status] });
  expect(result.steps[0]?.ok).toBe(false);
  expect(f.inputs).toHaveLength(2);
});
