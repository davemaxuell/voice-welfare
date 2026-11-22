import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ACTION_TYPES, type InteractiveItem, type Observation } from "../../src/core/actions.ts";
import { ExecContext, WebExecutionAgent, type ControlWindow, type WebAdapter } from "../../src/agents/web/agent.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { FakeLlm } from "../helpers.ts";

const site = "https://example.org/menu";
const button = (name: string, ref = name): InteractiveItem => ({name, ref, role: "button", region: "main", disabled: false});

function setup(items: InteractiveItem[], scope: "general" | "public" | "personal" | "background" = "general") {
  const obs: Observation = {url: site, platform: "pc", capturedAt: "", title: "비공개 제목", errors: [], fields: [], dialogs: [],
    outline: {links: [], headings: [], steps: [], notices: [], buttons: [], mainText: "비공개 본문", items}};
  const window: ControlWindow = {url: site, items: items.map(item => ({...item, context: "비공개 행"})), more: false};
  const execute = vi.fn<WebAdapter["execute"]>();
  const web = new WebExecutionAgent({observe: async () => obs, async close() {}, execute,
    async controlWindow(text, _offset, options) {
      return {...window, items: window.items.filter(item => options?.refs ? options.refs.includes(item.ref) :
        options?.ref !== undefined ? item.ref === options.ref : item.name === text)};
    },
  }, new PolicyGuard({allowedOrigins: [], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [], secretFieldIds: [],
    readOnlyWeb: true, publicLookupOnly: scope === "background", maxActionsPerTurn: 12}), createMockWelfareProfile("http://localhost:5174"));
  const ctx = new ExecContext({signal: new AbortController().signal, isStopped: () => false, trace() {},
    publicLookup: scope === "public", browsingScope: scope === "personal" ? "personal-inspection" : undefined});
  return {web, ctx, window, execute};
}

const payload = z.object({term: z.string(), options: z.record(z.string(), z.string())});

it("사용자의 말과 한정된 후보 이름만 가려서 보내고 관찰한 항목으로 승인을 요청한다", async () => {
  const name = "검색 조건 변경 010-1234-5678";
  const items = [button(name, "실제 단추 식별자"), ...Array.from({length: 68}, (_, i) => button(`도움말 ${i}`))];
  const {web, ctx, execute} = setup(items);
  const scanner = {scan: vi.fn(async (texts: readonly string[]) => texts.map(text => text.startsWith("철수") ? [["idnum", 0, 2] as const] : []))};
  const model = new FakeLlm(({user}) => {
    const {term, options} = payload.parse(JSON.parse(user));
    expect(term).toContain("[비공개]");
    expect(Array.from(term).length).toBeLessThanOrEqual(200);
    expect(Object.values(options)).toContain("검색 조건 변경 [비공개]");
    expect(Object.keys(options).length).toBeLessThanOrEqual(54);
    return {ref: Object.keys(options).find(key => options[key]?.startsWith("검색 조건") === true)};
  });
  const out = await web.followLink("철수 010-1111-2222 원하는 결과만 보게 해 " + "가".repeat(300), ctx, false, {picker: {model, scanner}});
  expect(out.pending?.target).toEqual({name, role: "button", ref: "실제 단추 식별자"});
  expect(out.status).toBe("needs-approval");
  expect(model.calls).toHaveLength(1);
  expect(scanner.scan).toHaveBeenCalledOnce();
  expect(JSON.stringify(model.calls)).not.toMatch(/철수|010-|실제 단추 식별자|비공개 (?:제목|행|본문)|도움말 67/u);
  expect(execute).not.toHaveBeenCalled();
});

it.each([undefined, null, "c1", {ref: "none"}, {ref: "없는 항목"}, {ref: "c1", name: "누르세요"}, {ref: 1}, new Error("모델 오류")])(
  "모델이 선택하지 못하면 기존 후보 안내로 돌아간다 (%#)", async answer => {
    const {web, ctx, execute} = setup([button("검색 조건 변경")]);
    const model = new FakeLlm(() => { if (answer instanceof Error) throw answer; return answer; });
    const out = await web.followLink("새로운 조건", ctx, false, {picker: {model}});
    expect(out).toMatchObject({status: "needs-clarification", candidates: [], actions: []});
    expect(out.message).toContain("찾지 못했습니다");
    expect(model.calls).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

it.each(["name", "role", "ref", "context", "url", "disabled"] as const)("모델이 답하는 사이 %s가 바뀌면 누르지 않는다", async part => {
  const {web, ctx, window, execute} = setup([button("검색 조건 변경")]);
  const model = new FakeLlm(() => {
    if (part === "url") window.url += "?other";
    else if (part === "disabled") window.items[0] = {...window.items[0]!, disabled: true};
    else window.items[0] = {...window.items[0]!, [part]: "다른 항목"};
    return {ref: "c1"};
  });
  const out = await web.followLink("범위 설정", ctx, false, {picker: {model}});
  expect(out).toMatchObject({status: "needs-clarification", actions: []});
  expect(out.message).toContain("바뀌");
  expect(execute).not.toHaveBeenCalled();
});

it.each(["public", "personal", "background"] as const)("%s 조사 범위에서는 의미로 항목을 고르지 않는다", async scope => {
  const {web, ctx} = setup([button("검색 조건 변경")], scope);
  const model = new FakeLlm({control_pick: {ref: "c1"}});
  expect((await web.followLink("범위 설정", ctx, false, {picker: {model}})).status).toBe("needs-clarification");
  expect(model.calls).toEqual([]);
});

it("이미 이름이 맞거나 여러 개가 맞거나 후보가 없으면 모델을 부르지 않는다", async () => {
  const model = new FakeLlm();
  const {web, ctx} = setup([button("검색 조건 변경"), button("지역 조건 변경")]);
  expect((await web.followLink("검색 조건 변경", ctx, false, {picker: {model}})).status).toBe("needs-approval");
  expect((await web.followLink("조건 변경", ctx, false, {picker: {model}})).candidates).toEqual(["검색 조건 변경", "지역 조건 변경"]);
  expect((await web.followLink("   ", ctx, false, {picker: {model}})).candidates).toEqual([]);
  expect((await web.followLink("범위 설정", ctx, true, {picker: {model}})).candidates).toEqual([]);
  const empty = setup([]);
  expect((await empty.web.followLink("범위 설정", empty.ctx, false, {picker: {model}})).candidates).toEqual([]);
  expect(model.calls).toEqual([]);
});

it.each([
  ["연락 010-1111-2222", "연락 010-3333-4444", "연락 [비공개]"],
  ["가".repeat(80) + "서울", "가".repeat(80) + "부산", "가".repeat(80)],
])("가리거나 줄여서 같은 이름만 남으면 모델이 고른 단추를 누르지 않는다 (%#)", async (first, second, displayed) => {
  const {web, ctx, execute} = setup([button(first), button(second)]);
  const model = new FakeLlm({control_pick: {ref: "c1"}});
  const out = await web.followLink("전화하는 곳", ctx, false, {picker: {model}});
  const request = model.calls[0];
  expect(typeof request?.user === "string" && payload.parse(JSON.parse(request.user)).options).toEqual({c1: displayed, c2: displayed});
  expect(out.status).toBe("needs-clarification");
  expect(execute).not.toHaveBeenCalled();
});

it("고르는 동안 입력 칸을 포함하게 된 단추는 누르지 않는다", async () => {
  const {web, ctx, window, execute} = setup([button("검색 조건 변경")]);
  const model = new FakeLlm(() => {
    window.items[0] = {...window.items[0]!, pictureMasked: true};
    return {ref: "c1"};
  });
  const out = await web.followLink("범위 설정", ctx, false, {picker: {model}});
  expect(out.status).toBe("needs-clarification");
  expect(execute).not.toHaveBeenCalled();
});
