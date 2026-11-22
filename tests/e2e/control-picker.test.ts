import { expect, it } from "vitest";
import { z } from "zod";
import { FakeLlm, PORTAL2 } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
async function portal(term: string, name: string) {
  const {session, page} = await open();
  await session.handleTurn(PORTAL2 + " 열어줘");
  const model = new FakeLlm(({schemaName, user}) => {
    if (schemaName !== "control_pick") return undefined;
    const data = z.object({term: z.string(), options: z.record(z.string(), z.string())}).parse(JSON.parse(user));
    expect(data.term).toBe(term);
    const ref = Object.keys(data.options).find(key => data.options[key] === name);
    expect(ref).toBeDefined();
    return {ref};
  });
  session.deps.webLlm = model;
  const result = await session.handleTurn(term + " 눌러줘");
  expect(model.calls.filter(call => call.schemaName === "control_pick")).toHaveLength(1);
  return {session, page, result};
}

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
