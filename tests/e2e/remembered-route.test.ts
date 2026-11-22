import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { PersonalStore } from "../../src/personal/store.ts";
import { Seal } from "../../src/personal/seal.ts";
import { FakeLlm, step } from "../helpers.ts";
import { createTestRuntime } from "./session-runtime.ts";

const runtime = createTestRuntime();
afterEach(runtime.closeSessions, 30_000);
afterAll(runtime.close, 30_000);
const request = "지금 열린 누리집에서 상담하는 요일을 찾아줘";
const address = "http://127.0.0.1:5174/counsel";
const first = "상담 일정";
const next = "정렬 수정";
const answer = "상담은 수요일에 열립니다.";
const plan = {steps: [{type: "GOAL", topic: request, site: null, more: null, list: null, text: null, fills: null, fieldMention: null}]};

it("봉인된 저장소를 다시 열면 기억한 두 단계를 한 번 승인하고 실제 화면의 답을 모델 없이 읽는다", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-route-"));
  const file = join(directory, "personal.json");
  const seal = new Seal({key: Buffer.alloc(32, 1)});
  try {
    for (const repeat of [false, true]) {
      const personal = new PersonalStore(file, seal);
      const {session, page, close} = await runtime.createBrowserSession({personal, routeDevice: () => true});
      await page.route(address, route => route.fulfill({contentType: "text/html; charset=utf-8",
        body: '<title>상담</title><main><a href="/calendar">상담 일정</a></main>'}));
      await page.route("**/calendar", route => route.fulfill({contentType: "text/html; charset=utf-8",
        body: '<title>일정</title><main><button type="button" aria-expanded="false" id="show">정렬 수정</button><p></p></main><script>show.onclick=()=>{show.ariaExpanded="true";document.querySelector("p").textContent="' + answer + '"}</script>'}));
      await page.goto(address);
      let decisions = 0;
      const choices = [step("click", first), step("click", next), step("answer", null, answer, [answer])];
      const model = new FakeLlm(call => {
        if (call.schemaName === "intent_plan") return plan;
        if (call.schemaName === "browse_step") return choices[decisions++] ?? step("fail", null, "찾지 못했어요.");
        return undefined;
      });
      session.deps.llm = session.deps.goalLlm = model;
      const asked = await session.handleTurn(request);
      expect(asked.pendingConfirmation?.kind).toBe(repeat ? "plan" : "click");
      expect(decisions).toBe(repeat ? 0 : 2);
      const done = await session.handleTurn("눌러");
      expect(done.speech).toContain(answer);
      expect(done.sources.map(source => source.url)).toContain(new URL("/calendar", address).href);
      expect([...asked.actions, ...done.actions].filter(a => a.result?.ok === true && a.action.type === "click")).toHaveLength(2);
      expect(model.calls.filter(c => c.schemaName === "browse_step")).toHaveLength(repeat ? 0 : 3);
      await close();
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

it("메뉴 이름이나 최종 근거가 바뀌면 현재 페이지부터 이어 가고 바뀐 경로를 다시 기억한다", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voice-route-"));
  const seal = new Seal({key: Buffer.alloc(32, 2)});
  const newAnswer = "상담은 목요일에 열립니다.";
  try {
    for (const [round, expected] of [3, 2, 0, 1, 0].entries()) {
      const personal = new PersonalStore(join(directory, "personal.json"), seal);
      const {session, page, close} = await runtime.createBrowserSession({personal, routeDevice: () => true});
      const name = round === 0 ? "운영 안내" : "새 운영 안내";
      const fact = round < 3 ? answer : newAnswer;
      const clicks: string[] = [];
      await page.exposeFunction("used", (label: string) => { clicks.push(label); });
      const content = (label: string, link: string) => '<a onclick="used(this.textContent)" href="' + link + '">' + label + '</a>';
      await page.route("**/counsel", r => r.fulfill({contentType: "text/html; charset=utf-8", body: '<main>' + content(first, "/menu") + '</main>'}));
      await page.route("**/menu", r => r.fulfill({contentType: "text/html; charset=utf-8", body: '<main>' + content(name, "/hours") + '</main>'}));
      await page.route("**/hours", r => r.fulfill({contentType: "text/html; charset=utf-8", body: '<main>' + fact + '</main>'}));
      await page.goto(address);
      const decisions: string[] = [];
      const model = new FakeLlm(call => {
        if (call.schemaName === "intent_plan") return plan;
        if (call.schemaName !== "browse_step") return undefined;
        const path = new URL(page.url()).pathname;
        decisions.push(path);
        if (path === "/hours") return step("answer", null, fact, [fact]);
        return step("click", path === "/menu" ? name : first);
      });
      session.deps.llm = session.deps.goalLlm = model;
      const result = await session.handleTurn(request);
      expect(result.speech).toContain(fact);
      expect(clicks).toEqual([first, name]);
      expect(decisions).toHaveLength(expected);
      if (round === 1) expect(decisions).toEqual(["/menu", "/hours"]);
      if (round === 3) expect(decisions).toEqual(["/hours"]);
      await close();
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
