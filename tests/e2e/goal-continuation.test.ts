import { expect, it, vi } from "vitest";
import { parseTurnResult } from "../../src/core/turn.ts";
import { FakeLlm, Gate, PORTAL, step } from "../helpers.ts";
import { pageFor, runtimeCases } from "./browser-runtime-cases.ts";

const create = runtimeCases();
const address = "http://" + PORTAL;
const currentGoal = "지금 열린 누리집에서 상담하는 요일을 찾아줘";
const goalPlan = {steps: [{type: "GOAL", topic: currentGoal, site: null, more: null, list: null, text: null, fills: null, fieldMention: null}]};
const answer = "상담은 수요일에 열립니다.";
const stt = {name: "연습용 받아쓰기", supported: true, async transcribe(bytes: Uint8Array) {
  return {text: new TextDecoder().decode(bytes).trim()};
}};

async function openGoal() {
  const {app, session: start} = await create({PRACTICE_MODE: "false"}, {stt});
  const {id, session} = await start();
  const page = pageFor(session);
  async function say(text: string) {
    const response = await app.request("/api/audio/turn?sessionId=" + id, {
      method: "POST", headers: {"content-type": "audio/wav"}, body: text.padEnd(256),
    });
    expect(response.status).toBe(200);
    return parseTurnResult(await response.json());
  }
  return {session, page, say, progress: () => app.request("/api/session/" + id + "/progress")};
}

it.each([
  ["GOAL", currentGoal],
  ["UNKNOWN", "남은 거 알아서 마무리해 줘"],
])("%s 음성 목표는 승인된 단추를 한 번만 누르고 화면의 답을 확인한다", async (intent, goal) => {
  const {session, page, say, progress} = await openGoal();
  await page.route(address, route => route.fulfill({contentType: "text/html; charset=utf-8", body:
    `<title>상담 일정</title><main><button onclick="this.dataset.count++; document.querySelector('p').textContent='${answer}'" data-count="0">확인</button><p>상담 안내입니다.</p></main>`}));
  await page.goto(address);
  const gate = new Gate([step("click", "확인"), step("click", "확인"), step("answer", null, answer, [answer])], 2);
  const model = new FakeLlm(call => {
    if (call.schemaName === "intent_plan" && goal === currentGoal) return goalPlan;
    if (call.schemaName === "chat_route") return {route: "web_task"};
    return gate.generate(call);
  });
  session.deps.llm = session.deps.goalLlm = model;
  const asked = await say(goal);
  expect(asked.intentType).toBe(intent);
  expect(asked).toMatchObject({state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: {kind: "click"}});
  expect(asked).not.toHaveProperty("review");
  expect(asked.pendingConfirmation?.description).toContain("확인");
  const target = page.getByRole("button", {name: "확인"});
  expect(await target.getAttribute("data-count")).toBe("0");

  const pending = say("눌러");
  try {
    await Promise.race([gate.reached, pending.then(result => { throw new Error(result.speech); })]);
    expect(await (await progress()).json()).toMatchObject({running: true, spoken: true, activitySpoken: true, activity: "이어서 요청하신 일을 진행할게요."});
  } finally { gate.release(); }
  const done = await pending;
  expect(done).toMatchObject({speech: answer, review: {status: "completed", browserIterations: 3}});
  expect(done.sources.map(source => source.url)).toContain(address);
  expect(done.actions.filter(row => row.action.type === "click" && row.result?.ok === true)).toHaveLength(1);
  expect(await target.getAttribute("data-count")).toBe("1");
  expect(gate.calls).toBe(3);
});

it("음성 목표가 로그인 화면에서 기다렸다가 직접 인증한 뒤 같은 페이지에서 답한다", async () => {
  const {session, page, say} = await openGoal();
  let signedIn = false;
  await page.route(address, route => route.fulfill({contentType: "text/html; charset=utf-8", body: signedIn
    ? `<title>상담 일정</title><main>${answer}</main>`
    : '<title>상담 일정</title><main><a href="/login.html">상담 안내</a></main>'}));
  await page.route("**/login.html", route => route.fulfill({contentType: "text/html; charset=utf-8",
    body: '<title>로그인</title><main>로그인<input type="password"><button>로그인</button></main>'}));
  await page.goto(address);
  let calls = 0;
  const model = new FakeLlm(call => {
    if (call.schemaName === "intent_plan") return goalPlan;
    if (call.schemaName === "browse_step") return ++calls === 1 ? step("click", "상담 안내") : step("answer", null, answer, [answer]);
    return undefined;
  });
  session.deps.llm = session.deps.goalLlm = model;
  const asked = await say(currentGoal);
  expect(asked).toMatchObject({intentType: "GOAL", state: "AUTH_HANDOFF", authHandoff: {status: "waiting"}});
  expect(asked).not.toHaveProperty("review");
  expect((await say("다 했어")).state).toBe("AUTH_HANDOFF");
  expect(calls).toBe(1);
  signedIn = true;
  await page.goto(address);
  const done = await say("다 했어");
  expect(done).toMatchObject({speech: answer, review: {status: "completed", browserIterations: 2}});
  expect(done.sources.map(source => source.url)).toContain(address);
  expect(calls).toBe(2);
});

it("단계가 바뀌어 같은 DOM 단추를 재사용하면 다음 단계에서 새 승인을 받아 진행한다", async () => {
  const {session, page, say} = await openGoal();
  await page.route(address, route => route.fulfill({contentType: "text/html; charset=utf-8", body:
    `<title>상담 안내</title><main><h1>1단계</h1><p>첫 번째 안내입니다.</p><button id="next" data-step="1" data-count="0">확인</button></main>
    <script>
      const btn = document.getElementById('next');
      const h1 = document.querySelector('h1');
      const p = document.querySelector('p');
      btn.addEventListener('click', () => {
        const next = Number(btn.dataset.step) + 1;
        btn.dataset.step = String(next);
        btn.dataset.count = String(Number(btn.dataset.count) + 1);
        h1.textContent = next + '단계';
        p.textContent = next === 3 ? '${answer}' : '두 번째 안내입니다.';
      });
    </script>`}));
  await page.goto(address);
  let calls = 0;
  const model = new FakeLlm(call => {
    if (call.schemaName === "intent_plan") return goalPlan;
    if (call.schemaName === "browse_step") {
      calls++;
      return calls <= 2 ? step("click", "확인") : step("answer", null, answer, [answer]);
    }
    return undefined;
  });
  session.deps.llm = session.deps.goalLlm = model;
  const target = page.getByRole("button", {name: "확인"});
  const firstAsk = await say(currentGoal);
  expect(firstAsk).toMatchObject({state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: {kind: "click"}});
  expect(await target.getAttribute("data-count")).toBe("0");

  const secondAsk = await say("눌러");
  expect(secondAsk).toMatchObject({state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: {kind: "click"}});
  expect(await target.getAttribute("data-step")).toBe("2");
  expect(await target.getAttribute("data-count")).toBe("1");

  const done = await say("눌러");
  expect(done).toMatchObject({speech: answer, review: {status: "completed", browserIterations: 3}});
  expect(await target.getAttribute("data-step")).toBe("3");
  expect(await target.getAttribute("data-count")).toBe("2");
  expect(calls).toBe(3);
});

it("승인 유효시간이 지나 다시 물은 뒤 확인해도 목표를 이어 가며 같은 화면의 중복 클릭을 막는다", async () => {
  const {session, page, say} = await openGoal();
  await page.route(address, route => route.fulfill({contentType: "text/html; charset=utf-8", body:
    `<title>상담 일정</title><main><button onclick="this.dataset.count++; document.querySelector('p').textContent='${answer}'" data-count="0">확인</button><p>상담 안내입니다.</p></main>`}));
  await page.goto(address);
  let calls = 0;
  const responses = [step("click", "확인"), step("click", "확인"), step("answer", null, answer, [answer])];
  const model = new FakeLlm(call => {
    if (call.schemaName === "intent_plan") return goalPlan;
    if (call.schemaName === "browse_step") return responses[calls++];
    return undefined;
  });
  session.deps.llm = session.deps.goalLlm = model;
  const target = page.getByRole("button", {name: "확인"});
  const firstAsk = await say(currentGoal);
  expect(firstAsk).toMatchObject({state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: {kind: "click"}});

  const realNow = performance.now.bind(performance);
  let offset = 0;
  const spy = vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
  try {
    offset = 125_000;
    const renewed = await say("눌러");
    expect(renewed).toMatchObject({state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation: {kind: "click"}});
    expect(renewed.speech).toContain("다시 여쭤볼게요");
    expect(await target.getAttribute("data-count")).toBe("0");

    const done = await say("눌러");
    expect(done).toMatchObject({speech: answer, review: {status: "completed", browserIterations: 3}});
    expect(await target.getAttribute("data-count")).toBe("1");
    expect(calls).toBe(3);
  } finally { spy.mockRestore(); }
});
