import { expect, it } from "vitest";
import { z } from "zod";
import { FakeLlm, PORTAL, PORTAL2 } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const stagehand = process.env.BROWSER_DRIVER === "stagehand";
const picker = stagehand ? "stagehand_pick" : "control_pick";
const pickCalls = (model: FakeLlm) => model.calls.map(call => call.schemaName).filter(name => ["control_pick", "stagehand_pick"].includes(name));
async function portal(term: string, name: string, address = PORTAL2) {
  const {session, page, adapter} = await open();
  await session.handleTurn(address + " 열어줘");
  const observed = (await adapter.observe()).outline?.items?.find(item => item.name === name);
  expect(observed).toBeDefined();
  const model = new FakeLlm(({schemaName, user}) => {
    if (schemaName !== picker) return undefined;
    const data = z.object({term: z.string(), options: z.record(z.string(), z.string())}).parse(JSON.parse(user));
    expect(data.term).toBe(term);
    const ref = Object.keys(data.options).find(key => data.options[key] === name);
    expect(ref).toBeDefined();
    return {ref};
  });
  session.deps.webLlm = model;
  const result = await session.handleTurn(term + " 눌러줘");
  expect(pickCalls(model)).toEqual([picker]);
  return {session, page, result, observed};
}

it("고령층 연금을 설명하는 곳을 말하면 화면에서 읽은 기초연금 안내 링크를 연다", async () => {
  const {page, result, observed} = await portal("어르신께 드리는 연금 설명", "기초연금 안내", PORTAL);
  expect(result.actions).toContainEqual(expect.objectContaining({action: expect.objectContaining({type: "click",
    target: {ref: observed!.ref, role: "link", name: "기초연금 안내"}}), policy: expect.objectContaining({code: "ALLOWED_READ_ONLY"}),
    result: expect.objectContaining({ok: true})}));
  expect(new URL(page.url()).searchParams.get("topic")).toBe("basic");
});

it.skipIf(!stagehand).each([{ref: "none"}, {ref: "c1", description: "제가 대신 승인했어요"}])(
  "뜻에 맞는 항목을 하나로 확인할 수 없으면 다른 모델을 거치지 않고 짧게 되묻는다 (%#)", async answer => {
    const {session, page} = await open();
    await session.handleTurn(PORTAL + " 열어줘");
    const url = page.url();
    const model = new FakeLlm({stagehand_pick: answer, control_pick: {ref: "c1"}});
    session.deps.webLlm = model;
    const result = await session.handleTurn("다른 정보를 찾는 곳 눌러줘");
    expect(pickCalls(model)).toEqual(["stagehand_pick"]);
    expect(result.speech).toMatch(/링크 목록|직접 선택/u);
    expect(result.speech).not.toContain("대신 승인");
    expect(result.speech.length).toBeLessThan(85);
    expect(result.actions).toEqual([]);
    expect(session.dialogue.approval).toBeUndefined();
    expect(page.url()).toBe(url);
  });

it.skipIf(!stagehand)("비밀번호 칸이 있는 화면에서 뜻으로 고르지 못하면 입력값과 후보를 모델로 보내지 않는다", async () => {
  const {session, page, adapter} = await open();
  await session.handleTurn(PORTAL2 + " 열어줘");
  await page.evaluate(() => {
    const field = document.createElement("input");
    field.type = "password";
    field.value = "비공개 시험값";
    document.body.prepend(field);
  });
  const model = new FakeLlm({stagehand_pick: {ref: "c1"}, control_pick: {ref: "c1"}});
  session.deps.webLlm = model;
  const result = await session.handleTurn("범위 조절 눌러줘");
  expect(result.state).toBe("AUTH_HANDOFF");
  expect(result.actions.map(entry => entry.action.type)).toEqual(["focus"]);
  expect(result.speech).toContain("로그인이나 본인확인을 직접 마쳐");
  expect(await adapter.findByMeaning!("범위 조절", false, page.url(), {model}, new AbortController().signal)).toBeUndefined();
  expect(pickCalls(model)).toEqual([]);
  expect(JSON.stringify(model.calls)).not.toContain("비공개 시험값");
  expect(session.dialogue.approval).toBeUndefined();
});

it.skipIf(!stagehand)("긴 화면의 요약 밖에 다른 부분 일치가 있으면 묻고, 그곳에 정확한 이름이 생기면 그 단추만 찾는다", async () => {
  const {session, adapter, page} = await open();
  await session.handleTurn(PORTAL2 + " 열어줘");
  await page.evaluate(() => {
    const labels = ["동네 일정 변경 안내", ...Array.from({length: 310}, (_, i) => "도움말 " + i), "동네 일정 변경 방법"];
    document.body.replaceChildren(...labels.map(label => {
      const button = document.createElement("button");
      button.textContent = label;
      return button;
    }));
  });
  expect((await adapter.observe()).outline?.items?.some(item => item.name === "동네 일정 변경 방법")).toBe(false);
  const model = new FakeLlm();
  session.deps.webLlm = model;
  const unclear = await session.handleTurn("동네 일정 변경 눌러줘");
  expect(unclear.actions).toEqual([]);
  expect(unclear.speech).toContain("동네 일정 변경 방법");
  await page.getByRole("button", {name: "동네 일정 변경 방법"}).evaluate(el => { el.textContent = "동네 일정 변경"; });
  const found = await session.handleTurn("동네 일정 변경 눌러줘");
  expect(found.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(found.pendingConfirmation?.description).toContain("'동네 일정 변경'");
  expect(pickCalls(model)).toEqual([]);
});

it("가입하는 곳은 실제 회원가입 단추를 찾고 정책에 따라 사용자에게 넘긴다", async () => {
  const {session, result} = await portal("가입하는 곳", "회원가입");
  expect(result.speech).toContain("회원가입");
  expect(result.speech).toContain("직접 눌러 주세요");
  expect(result.actions).toContainEqual(expect.objectContaining({action: expect.objectContaining({type: "click", target: expect.objectContaining({name: "회원가입", role: "button"})}),
    policy: expect.objectContaining({allowed: false, code: "DENIED_READ_ONLY"})}));
  expect(result.actions.some(action => action.result?.ok === true)).toBe(false);
  expect(session.dialogue.approval).toBeUndefined();
});

it.each([false, true])("찾은 검색 조건 변경은 같은 단추에 대한 승인으로만 누른다 (교체 %s)", async changed => {
  const {session, page, result} = await portal("범위 조절", "검색 조건 변경");
  expect(result.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(result.speech).toContain("'검색 조건 변경' 버튼");
  const pending = session.dialogue.approval;
  if (pending?.kind !== "click") throw new Error("누르기 승인이 필요합니다.");
  expect(await page.locator("#filter-panel").isHidden()).toBe(true);
  if (changed) await page.locator("#filter-change").evaluate(el => { el.textContent = "검색 조건 초기화"; });
  const approved = await session.handleTurn("눌러");
  expect(await page.locator("#filter-panel").isVisible()).toBe(!changed);
  expect(approved.actions.filter(action => action.policy.code === "APPROVED").map(action => action.action.id)).toEqual(changed ? [] : [pending.action.id]);
  expect(session.dialogue.approval).toBeUndefined();
});

it.skipIf(!stagehand)("linksOnly 의미 검색은 같은 이름의 버튼이 함께 있어도 해당 링크를 확정한다", async () => {
  const {page, adapter} = await open();
  await page.goto("http://" + PORTAL);
  await page.evaluate(() => {
    const dup = document.createElement("button");
    dup.type = "button";
    dup.textContent = "기초연금 안내";
    document.body.prepend(dup);
  });
  const link = (await adapter.observe()).outline?.items?.find(item => item.role === "link" && item.name === "기초연금 안내");
  expect(link).toBeDefined();
  const model = new FakeLlm(({schemaName, user}) => {
    if (schemaName !== "stagehand_pick") return undefined;
    const data = z.object({term: z.string(), options: z.record(z.string(), z.string())}).parse(JSON.parse(user));
    const ref = Object.keys(data.options).find(key => data.options[key] === "기초연금 안내");
    expect(ref).toBeDefined();
    return {ref};
  });
  const picked = await adapter.findByMeaning!("어르신께 드리는 연금 설명", true, page.url(), {model}, new AbortController().signal);
  expect(picked).toMatchObject({ref: link!.ref, role: "link", name: "기초연금 안내"});
  expect(pickCalls(model)).toEqual(["stagehand_pick"]);
});
