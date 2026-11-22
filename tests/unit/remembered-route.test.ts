import { expect, it, vi } from "vitest";
import { existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalStore } from "../../src/personal/store.ts";
import { Seal } from "../../src/personal/seal.ts";
import { ACTION_TYPES } from "../../src/core/actions.ts";
import { RouteLearning, routeAnswer } from "../../src/agents/web/goal_route.ts";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { fieldVocabulary, createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { WelfareInformationAgent } from "../../src/agents/welfare/agent.ts";
import { FixtureWelfareDataProvider } from "../../src/agents/welfare/data/index.ts";
import { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { routeGoalKey, routePage, routeMetadataSafe, safeRouteStep } from "../../src/safety/route_metadata.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { browser, context, page } from "./fake-browser.ts";
import { FakeLlm, step } from "../helpers.ts";

const home = "https://guide.example.org/menu", end = "https://guide.example.org/hours";
const label = "상담 안내", fact = "상담은 수요일입니다.", goal = "상담하는 요일을 알려 줘";
const key = routeGoalKey(goal, [])!;
const planStep = {kind: "click" as const, page: home, role: "link", name: label};

function scenario(publicLookupOnly = false) {
  const start = page(home, "안내");
  start.outline!.items = [{ref: "start", role: "link", name: label, disabled: false, region: "main"}];
  const destination = page(end, "요일");
  destination.outline!.mainText = fact;
  const fake = browser({[home]: start, [end]: destination}, home);
  const execute = fake.adapter.execute;
  vi.spyOn(fake.adapter, "execute").mockImplementation(async action => {
    const receipt = await execute(action);
    if (action.type === "click") await execute({...action, type: "navigate", url: end});
    return receipt;
  });
  const profile = createMockWelfareProfile("http://localhost:5174");
  const web = new WebExecutionAgent(fake.adapter, new PolicyGuard({allowedOrigins: [], allowedActionTypes: ACTION_TYPES,
    allowedFieldIds: [], secretFieldIds: [], maxActionsPerTurn: 12, readOnlyWeb: true, publicLookupOnly}), profile);
  return {web, profile};
}

it("검증된 클릭과 근거만 봉인하며 예전 저장소를 다시 열어도 보존한다", async () => {
  const {web} = scenario(), ctx = context();
  const before = await web.observe(ctx);
  const out = await web.followLink(label, ctx, false, {expected: [home, "start", "link"]});
  const trail = new RouteLearning(key, []);
  trail.click(before, out);
  const route = trail.finish(out.view!, [fact])!;
  expect(route.steps).toEqual([planStep]);
  expect(routeAnswer(route, out.view!, [])).toEqual([fact]);
  const unfinished = new RouteLearning(key, []);
  unfinished.click(before, out);
  unfinished.pendingApprovalId = "다음 클릭의 승인";
  expect(unfinished.finish(out.view!, [fact])).toBeUndefined();
  unfinished.click(before, out);
  expect(unfinished.finish(out.view!, [fact])).toBeUndefined();
  using dir = mkdtempDisposableSync(join(tmpdir(), "voice-route-"));
  const file = join(dir.path, "fixture.json"), seal = new Seal({key: Buffer.alloc(32, 3)});
  writeFileSync(file, JSON.stringify({vault: {}, siteAllow: {[route.site]: true}}));
  new PersonalStore(file, seal).saveRoute(route, routeMetadataSafe);
  const bytes = readFileSync(file);
  expect(seal.isSealed(bytes)).toBe(true);
  expect(seal.open(bytes).toString()).not.toContain(fact);
  expect(seal.open(bytes).toString()).not.toContain(goal);
  const reopened = new PersonalStore(file, seal);
  expect(reopened.siteAllowed(route.site)).toBe(true);
  expect(reopened.rememberedRoute(route.site, key)).toEqual(route);
  for (const failed of [{...out, effect: "none" as const}, {...out, actions: []}, {...out, actions: out.actions.map(a => ({...a, result: undefined}))}]) {
    const invalid = new RouteLearning(key, []);
    invalid.click(before, failed);
    expect(invalid.finish(out.view!, [fact])).toBeUndefined();
  }
  const plain = join(dir.path, "plain.json");
  new PersonalStore(plain).saveRoute(route, routeMetadataSafe);
  expect(existsSync(plain)).toBe(false);
  writeFileSync(plain, JSON.stringify({routes: [route]}));
  expect(new PersonalStore(plain, seal).rememberedRoute(route.site, key)).toBeUndefined();
  reopened.clearVault();
  expect(reopened.rememberedRoute(route.site, key)).toBeUndefined();
});

it("주소·라벨·목표에 들어간 개인 값과 중요한 클릭을 경로에서 버린다", () => {
  for (const path of ["/menu?case=123", "/menu#token", "/user/alice", "/auth", "/recovery/zk43925", "/%EA%B9%80", "/id/fcc943c4-8be4-4a35"])
    expect(routePage(new URL(path, home).href, [])).toBeUndefined();
  for (const name of ["신청하기", "삭제", "로그인", "확인", "김하늘 안내", "홍길동님의 접수번호", "010-1234-5678", "test@example.org"])
    expect(safeRouteStep({...planStep, name}, ["김하늘"])).toBe(false);
  for (const phrase of ["김하늘 상담", "비밀번호 abcde", "이메일 test@example.org", "010-1234-5678 확인"])
    expect(routeGoalKey(phrase, ["김하늘"])).toBeUndefined();
  expect(routeGoalKey("  상담하는   요일을 알려 줘  ", [])).toBe(key);
});

it.each(["unspecified", "shared", "background", "public", "private", "unsealed"])("%s 경로에서는 개인 기억을 읽거나 쓰지 않는다", async scope => {
  const {web, profile} = scenario(scope === "background");
  using dir = mkdtempDisposableSync(join(tmpdir(), "voice-route-"));
  const store = new PersonalStore(join(dir.path, "fixture.json"), scope === "unsealed" ? undefined : new Seal({key: Buffer.alloc(32, 2)}));
  const lookup = vi.spyOn(store, "rememberedRoute"), save = vi.spyOn(store, "saveRoute");
  const session = new SessionOrchestrator({web, personal: store, routeDevice: scope === "unspecified" ? undefined : () => scope !== "shared",
    welfare: new WelfareInformationAgent(FixtureWelfareDataProvider.fromFile()), intentProvider: new RuleBasedIntentProvider(fieldVocabulary(profile)),
    llm: new FakeLlm(({schemaName}) => schemaName === "browse_step" ? step("fail", null, "찾지 못했어요.") : undefined)});
  await session.browse.runGoal(goal, new ExecContext({...context(), publicLookup: scope === "public",
    browsingScope: scope === "private" ? "personal-inspection" : undefined}),
  {continuation: {approvedRefs: new Set(), request: redactText(goal), publicLookup: false, actionLimit: 10}});
  expect(lookup).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
