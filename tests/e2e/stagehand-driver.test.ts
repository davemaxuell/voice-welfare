import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Action } from "../../src/core/actions.ts";
import { createStructuredLlm, ModelConnections } from "../../src/core/llm.ts";
import { closeLaunchedBrowser, launchBrowser, launchChromeProfile, PlaywrightExecutionAdapter, stopPlaywright } from "../../src/agents/web/browser/index.ts";
import { observedSelectors, stagehandTab } from "../../src/agents/web/browser/stagehand_browser.ts";
import { stagehandDriver } from "../../src/agents/web/browser/stagehand_driver.ts";
import { AgentRuntime, loadConfig } from "../../src/server/runtime.ts";
import { FakeLlm } from "../helpers.ts";

let browser: Browser;
const adapters: PlaywrightExecutionAdapter[] = [];
beforeAll(async () => { browser = await launchBrowser(true, 0, "stagehand"); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});
afterAll(() => stopPlaywright(), 60_000);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(html: string) {
  const adapter = new PlaywrightExecutionAdapter({ browser, driver: "stagehand", allowedOrigins: [], readOnlyWeb: true });
  adapters.push(adapter);
  await adapter.start();
  const page = adapter.page!;
  await page.setContent(html);
  return { adapter, page };
}
function action(type: Action["type"], target: Action["target"], value?: string): Action {
  return { id: "한번", type, target, value, risk: "low", reason: "시험", requiresConfirmation: false };
}

it.each([undefined, "playwright"])("모델 키가 없는 서비스(%s)에서 한 번 말하면 실제 안내 단추가 한 번만 동작한다", async driver => {
  const runtime = new AgentRuntime(loadConfig({HEADLESS:"true", REQUIRE_CONSENT:"false", PRACTICE_MODE:"false", BROWSER_DRIVER:driver}));
  const connectedAtDetach: boolean[] = [];
  try {
    const session = await runtime.createSession();
    try {
      const adapter = session.deps.web.adapter as PlaywrightExecutionAdapter;
      const page = adapter.page!;
      const url = "https://notice.example.org/board";
      await page.route(url, route => route.fulfill({contentType:"text/html; charset=utf-8", body:'<title>0</title><main><button onclick="document.title=String(Number(document.title)+1)">새 소식</button></main>'}));
      await session.handleTurn(url + " 열어줘");
      expect(page.url()).toBe(url);
      const sdk = driver === undefined ? await stagehandTab(page) : undefined;
      if (sdk !== undefined) {
        const handle = sdk.connection.sdk.browser;
        const detach = handle.disconnect.bind(handle);
        vi.spyOn(handle, "disconnect").mockImplementation(() => {
          connectedAtDetach.push(page.context().browser()!.isConnected());
          return detach();
        });
      }
      const act = sdk && vi.spyOn(sdk.connection.sdk, "act");
      const result = await session.handleTurn("새 소식 버튼 눌러줘");
      expect(result.actions).toContainEqual(expect.objectContaining({action:expect.objectContaining({type:"click"}), result:expect.objectContaining({ok:true})}));
      expect(await page.title()).toBe("1");
      if (act) expect(act).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({method:"click", selector:expect.any(String)}),
        expect.objectContaining({page:sdk!.tab}));
      else expect(adapter.findByMeaning).toBeUndefined();
    } finally { await session.close(); }
  } finally { await runtime.close(); }
  expect(connectedAtDetach).toEqual(driver === undefined ? [true] : []);
});

it("이름이 같은 두 행에서 음성으로 말한 행만 찾아 한 번 누르고 개인 입력값은 모델에 보내지 않는다", async () => {
  const {page, adapter} = await fixture('<main><article><h2>교육비 지원</h2><button onclick="document.title=1">자세히</button></article>' +
    '<article><h2>주거비 지원</h2><button onclick="document.title=2">자세히</button></article><input value="개인입력시험"></main>');
  const model = new FakeLlm(({user, schemaName}) => {
    expect(schemaName).toBe("stagehand_pick");
    expect(user).not.toContain("개인입력시험");
    const choices = JSON.parse(user) as {options: Record<string, string>};
    return {ref:Object.keys(choices.options).find(key => choices.options[key]!.includes("주거비"))};
  });
  const target = await adapter.findByMeaning!("집세 도움에 관해 더 알아보기", false, page.url(), {model}, new AbortController().signal);
  expect(target).toMatchObject({role:"button", name:"자세히", context:"주거비 지원"});
  const act = vi.spyOn((await stagehandTab(page)).connection.sdk, "act");
  expect((await adapter.execute(action("click", target))).verified).toBe(true);
  expect(await page.title()).toBe("2");
  expect(act).toHaveBeenCalledTimes(1);
});

it("아이콘이나 외부 라벨로 이름을 붙인 버튼은 읽어 준 이름으로 찾아 누른다", async () => {
  const {page, adapter} = await fixture('<span id="page-label">다음 목록</span><button aria-labelledby="page-label" onclick="document.title=1">›</button>' +
    '<button aria-label="목록 닫기" onclick="document.title=2">×</button>');
  expect((await adapter.observe()).outline?.items?.map(i => i.name)).toEqual(["다음 목록", "목록 닫기"]);
  for (const [name, title] of [["다음 목록", "1"], ["목록 닫기", "2"]]) {
    expect((await adapter.execute(action("click", {role:"button", name}))).ok).toBe(true);
    expect(await page.title()).toBe(title);
  }
});

it("멈춘 뒤 늦게 도착한 Stagehand 클릭은 같은 자리에 나타난 단추를 작동시키지 않는다", async () => {
  const {page, adapter} = await fixture('<button onclick="document.title=1">안내</button>');
  const {connection} = await stagehandTab(page);
  const act = connection.sdk.act.bind(connection.sdk), started = gate(), release = gate(), delivered = gate();
  vi.spyOn(connection.sdk, "act").mockImplementation(async (instruction, options) => {
    started.resolve();
    await release.promise;
    try { return await act(instruction, options); } finally { delivered.resolve(); }
  });
  const stop = new AbortController();
  const running = adapter.execute(action("click", {role:"button", name:"안내"}), stop.signal);
  try {
    await Promise.race([started.promise, running.then(() => { throw new Error("Stagehand 클릭이 실행되지 않았습니다."); })]);
    stop.abort();
    expect((await running).errorCode).toBe("ABORTED");
    await page.locator("button").evaluate(el => el.replaceWith(el.cloneNode(true)));
  } finally { release.resolve(); }
  await delivered.promise;
  expect(await page.title()).toBe("");
});

it("Stagehand 클릭을 기다리며 사용자가 이미 체크한 항목을 다시 해제하지 않는다", async () => {
  const {page, adapter} = await fixture('<input type="checkbox" id="choice" aria-label="수신" onchange="document.title=1">');
  const {connection} = await stagehandTab(page);
  const act = connection.sdk.act.bind(connection.sdk);
  vi.spyOn(connection.sdk, "act").mockImplementation(async (instruction, options) => {
    await page.locator("#choice").evaluate(el => { (el as HTMLInputElement).checked = true; });
    return act(instruction, options);
  });
  await adapter.execute({...action("check", {fieldId:"choice"}), checked:true});
  expect(await page.locator("#choice").isChecked()).toBe(true);
  expect(await page.title()).toBe("");
});

it("같은 Stagehand 조작에서 추가 포인터가 도착해도 사이트 클릭은 한 번만 실행된다", async () => {
  const {page, adapter} = await fixture('<button onclick="document.title=String(Number(document.title)+1)">알림</button>');
  const {connection} = await stagehandTab(page);
  const act = connection.sdk.act.bind(connection.sdk);
  vi.spyOn(connection.sdk, "act").mockImplementation(async (instruction, options) => {
    const first = await act(instruction, options);
    await act(instruction, options);
    return first;
  });
  expect((await adapter.execute(action("click", {role:"button", name:"알림"}))).verified).toBe(true);
  expect(await page.title()).toBe("1");
});

it.each(["iframe", "shadow"])("%s 안에서도 Stagehand가 요청한 단추를 정확히 한 번 누른다", async kind => {
  const {page, adapter} = await fixture("<main><div id='host'></div></main>");
  await page.locator("#host").evaluate((host, kind) => {
    const html = '<button onclick="this.textContent=String(Number(this.dataset.count || 0)+1);this.dataset.count=this.textContent">안쪽 안내</button>';
    if (kind === "shadow") host.attachShadow({mode:"open"}).innerHTML = html;
    else { const frame = document.createElement("iframe"); frame.srcdoc = html; host.appendChild(frame); }
  }, kind);
  const button = kind === "shadow" ? page.getByRole("button") : page.frameLocator("iframe").getByRole("button");
  await button.waitFor();
  const item = (await adapter.observe()).outline!.items!.find(control => control.name === "안쪽 안내")!;
  const act = vi.spyOn((await stagehandTab(page)).connection.sdk, "act");
  const result = await adapter.execute(action("click", item), undefined, undefined, {requestedClick:"command"});
  expect(result).toMatchObject({ok:true, verified:true});
  expect(await button.textContent()).toBe("1");
  expect(act).toHaveBeenCalledTimes(1);
});

it.each(["iframe", "shadow", "autocomplete", "textarea"])("%s의 비밀번호 칸은 값 없이 인계하고, 직접 입력한 뒤 채워졌는지만 확인한다", async kind => {
  const {page, adapter} = await fixture("<section id='host'></section>");
  await page.locator("#host").evaluate((host, kind) => {
    const html = kind === "textarea" ? '<label>비밀번호<textarea autocomplete="new-password">미리채운시험암호</textarea></label>' :
      '<input type="' + (kind === "autocomplete" ? "text" : "password") + '" autocomplete="current-password" aria-label="비밀번호">';
    if (kind === "shadow") host.attachShadow({mode:"open"}).innerHTML = html;
    else if (kind === "iframe") { const frame = document.createElement("iframe"); frame.srcdoc = html; host.appendChild(frame); }
    else if (kind === "textarea") {
      const footer = document.createElement("footer");
      footer.innerHTML = "대표전화 안내 " + html;
      document.body.appendChild(footer);
    } else host.innerHTML = html;
  }, kind);
  const field = kind === "iframe" ? page.frameLocator("iframe").locator("input") : page.locator("input,textarea");
  await field.waitFor();
  const before = await adapter.observe();
  if (kind === "textarea") expect(before.outline?.footerText).toContain("대표전화 안내");
  expect(JSON.stringify(before)).not.toContain("미리채운시험암호");
  const first = before.fields.find(f => f.type === "password");
  expect(first).toMatchObject({visible:true, filled:kind === "textarea", sensitive:true});
  expect((await adapter.execute(action("focus", {fieldId:first!.fieldId, label:first!.label}))).ok).toBe(true);
  expect(await field.evaluate(el => (el.getRootNode() as Document | ShadowRoot).activeElement === el)).toBe(true);
  await field.fill("본인만아는시험암호");
  const after = await adapter.observe();
  expect(after.fields.find(f => f.fieldId === first!.fieldId)).toMatchObject({type:"password", filled:true, value:""});
  expect(JSON.stringify(after)).not.toContain("본인만아는시험암호");
  expect((await adapter.execute(action("fill", {fieldId:first!.fieldId, label:first!.label}, "잘못된 값"))).ok).toBe(false);
  expect(await field.inputValue()).toBe("본인만아는시험암호");
});

it("같은 주소를 연 두 세션에서 관찰·입력·클릭은 선택한 탭에만 적용한다", async () => {
  const html = '<button onclick="document.title=this.textContent">공통 안내</button><input id="field">';
  const [a, b] = await Promise.all([fixture(html), fixture(html)]);
  const [first, second] = await Promise.all([stagehandTab(a.page), stagehandTab(b.page)]);
  expect(first.tab.pageId).not.toBe(second.tab.pageId);
  const select = vi.spyOn(second.tab, "evaluate");
  expect((await b.adapter.observe()).outline?.items?.[0]?.name).toBe("공통 안내");
  expect(select).toHaveBeenCalled();
  expect((await a.adapter.execute(action("fill", { fieldId: "field" }, "첫째"))).verified).toBe(true);
  expect(await b.page.locator("input").inputValue()).toBe("");
  const item = (await b.adapter.observe()).outline!.items![0]!;
  expect((await b.adapter.execute(action("click", item))).ok).toBe(true);
  expect(await b.page.title()).toBe("공통 안내");
  expect(await a.page.title()).toBe("");
  await a.page.context().addCookies([{ url: "http://localhost", name: "session", value: "first" }]);
  expect(await b.page.context().cookies()).toEqual([]);
});

it("실제 누르기의 포인터 입력 도중 이름이 바뀌면 이어지는 클릭 핸들러가 실행되지 않는다", async () => {
  const { adapter, page } = await fixture('<button onpointerdown="this.textContent=String(999)" onclick="document.title=String(321)">안내</button>');
  const item = (await adapter.observe()).outline!.items![0]!;
  expect((await adapter.execute(action("click", item))).errorCode).toBe("VERIFY_FAILED");
  expect(await page.locator("button").innerText()).toBe("999");
  expect(await page.title()).toBe("");
});

it("단추 이름·링크 역할·입력 칸 표지는 Stagehand 탭에서 찾고 호스트에는 찾은 ref만 넘긴다", async () => {
  const { adapter, page } = await fixture('<button onclick="document.title=String(event.isTrusted)">안내</button>' +
    '<a href="https://example.invalid/" onclick="event.preventDefault()">본문</a><label for="a">성명</label><input id="a"><input placeholder="연락처" data-testid="phone">');
  const { tab } = await stagehandTab(page);
  const lookup = vi.spyOn(tab, "evaluate");
  const host = vi.spyOn(page, "locator");
  const byRole = vi.spyOn(page, "getByRole"), byLabel = vi.spyOn(page, "getByLabel"), byId = vi.spyOn(page, "getByTestId");
  expect((await adapter.execute(action("click", { role: "button", name: "안내" }))).ok).toBe(true);
  expect(await page.title()).toBe("true");
  expect((await adapter.execute(action("click", { role: "link", name: "본문" }))).ok).toBe(true);
  expect((await adapter.execute(action("fill", { label: "성명", fieldId: "a" }, "하늘"))).readValue).toBe("하늘");
  expect((await adapter.execute(action("fill", { label: "연락처" }, "시험"))).readValue).toBe("시험");
  expect((await adapter.execute(action("read", { testId: "phone" }))).readValue).toBe("시험");
  expect(lookup).toHaveBeenCalled();
  expect(byRole).not.toHaveBeenCalled();
  expect(byLabel).not.toHaveBeenCalled();
  expect(byId).not.toHaveBeenCalled();
  expect(host).toHaveBeenCalled();
  for (const [selector] of host.mock.calls) expect(selector).toMatch(/^\[data-cheongeum-ref="r[\w-]+"\]$/u);
});

it("같은 이름이 둘이면 순번이 있을 때만 누르고 칸의 id와 이름도 함께 대조한다", async () => {
  const { adapter, page } = await fixture('<button onclick="document.title=String(1)">안내</button><button onclick="document.title=String(2)">안내</button>' +
    '<input id="one" aria-label="성명"><input id="two" aria-label="주소"><input aria-label="성명">');
  expect((await adapter.execute(action("click", { role: "button", name: "안내" }))).errorCode).toBe("AMBIGUOUS_TARGET");
  expect(await page.title()).toBe("");
  expect((await adapter.execute(action("click", { role: "button", name: "안내", nth: 1 }))).ok).toBe(true);
  expect(await page.title()).toBe("2");
  expect((await adapter.execute(action("fill", { label: "성명" }, "하늘"))).errorCode).toBe("AMBIGUOUS_TARGET");
  expect((await adapter.execute(action("fill", { fieldId: "two", label: "성명" }, "하늘"))).ok).toBe(false);
  expect((await adapter.execute(action("fill", { fieldId: "two", role: "searchbox" }, "시험"))).ok).toBe(false);
  expect(await page.evaluate(() => Array.from(document.querySelectorAll("input"), input => input.value))).toEqual(["", "", ""]);
});

it("이름으로 찾은 단추가 누르는 사이에 바뀌거나 입력 초점에서 칸 이름이 바뀌면 실행하지 않는다", async () => {
  const { adapter, page } = await fixture('<button onpointerdown="this.textContent=String(999)" onclick="document.title=String(321)">안내</button>' +
    '<input id="a" aria-label="성명" onfocus="this.setAttribute(\'aria-label\',\'다른 칸\')">');
  expect((await adapter.execute(action("click", { role: "button", name: "안내" }))).errorCode).toBe("VERIFY_FAILED");
  expect((await adapter.execute(action("fill", { fieldId: "a", name: "성명" }, "하늘"))).errorCode).toBe("VERIFY_FAILED");
  expect(await page.title()).toBe("");
  expect(await page.locator("#a").inputValue()).toBe("");
});

it("칸의 실제 이름·id까지 정책에 묶고 초점·키·체크 시점의 역할과 이름도 다시 확인한다", async () => {
  const { page } = await fixture('<input id="name" aria-label="성명" onfocus="this.setAttribute(\'aria-label\',\'다른 칸\')" onkeydown="document.title=String(1)">' +
    '<input type="checkbox" id="notice" aria-label="알림" onpointerdown="this.setAttribute(\'aria-label\',\'다른 설정\')">');
  const driver = stagehandDriver(page, 5000);
  const signal = new AbortController().signal;
  const bound = await driver.bindTarget!({ label: "성명" }, signal);
  expect(bound).toEqual({ fieldId: "name", ref: expect.any(String), role: "textbox", name: "성명", label: "성명" });
  const element = await driver.resolve(bound, signal);
  await expect(element.press("Enter")).rejects.toMatchObject({ code: "VERIFY_FAILED" });
  await expect(element.focus()).rejects.toMatchObject({ code: "VERIFY_FAILED" });
  expect(await page.title()).toBe("");
  const checkbox = await driver.resolve({ fieldId: "notice", label: "알림" }, signal);
  await expect(checkbox.check(true)).rejects.toMatchObject({ code: "VERIFY_FAILED" });
  expect(await page.locator("#notice").isChecked()).toBe(false);
});

it("옵션 이름과 값이 겹치고 이름도 중복되면 처음으로 이름이 맞는 옵션 하나를 고른다", async () => {
  const { adapter, page } = await fixture('<select id="city" aria-label="지역" multiple oninput="document.title+=event.type" onchange="document.title+=event.type">' +
    '<option value="서울" selected>부산</option><option value="seoul">서울</option><option value="duplicate">서울</option></select>');
  expect(await adapter.execute(action("select", { fieldId: "city", label: "지역" }, "서울"))).toMatchObject({ verified: true, readValue: "서울" });
  expect(await page.locator("select").inputValue()).toBe("seoul");
  expect(await page.locator("option:checked").count()).toBe(1);
  expect(await page.title()).toBe("inputchange");
});

it.each(["멈춤", "칸 이름 변경", "옵션 값 변경", "옵션 그룹 비활성화", "옵션 그룹 숨김", "같은 문서 주소 변경"])("이미 찾은 칸에 뒤늦게 선택이 도착해도 %s 뒤에는 값과 이벤트가 그대로다", async change => {
  const { adapter, page } = await fixture('<select id="city" aria-label="지역" oninput="document.title+=event.type" onchange="document.title+=event.type">' +
    '<option value="busan">부산</option><optgroup label="수도권"><option value="seoul">서울</option></optgroup></select>');
  const { tab } = await stagehandTab(page);
  const evaluate = tab.evaluate.bind(tab);
  const delivered = gate();
  vi.spyOn(tab, "evaluate").mockImplementation(async (source, arg) => {
    if (typeof arg !== "object" || arg === null || !("selector" in arg) || typeof arg.selector !== "string" ||
      !("token" in arg) || typeof arg.token !== "string") return evaluate(source, arg);
    return evaluate(async ({ selector, token }) => {
      const field = document.querySelector(selector);
      if (!(field instanceof HTMLSelectElement)) throw new Error("선택 칸을 찾지 못했습니다.");
      // SDK처럼 요소를 먼저 잡는다. 풀려난 뒤에는 셀렉터를 다시 찾지 않는다.
      document.documentElement.dataset.selectionReady = "true";
      await new Promise<void>(resume => window.addEventListener("resume-selection", () => resume(), { once: true }));
      field.dispatchEvent(new Event(token));
    }, { selector: arg.selector, token: arg.token }).finally(delivered.resolve);
  });
  const stop = new AbortController();
  const running = adapter.execute(action("select", { fieldId: "city", label: "지역" }, "서울"), stop.signal);
  await page.locator("html[data-selection-ready]").waitFor({ state: "attached", timeout: 5000 });
  if (change === "멈춤") {
    stop.abort();
    await running;
  } else await page.evaluate(change => {
    const field = document.querySelector("select")!;
    if (change === "칸 이름 변경") field.setAttribute("aria-label", "다른 지역");
    else if (change === "옵션 값 변경") field.options[1]!.value = "changed";
    else if (change === "옵션 그룹 비활성화") field.querySelector("optgroup")!.disabled = true;
    else if (change === "옵션 그룹 숨김") field.querySelector("optgroup")!.style.display = "none";
    else location.hash = "다른-화면";
  }, change);
  await page.evaluate(() => window.dispatchEvent(new Event("resume-selection")));
  await delivered.promise;
  expect((await running).errorCode).toBe(change === "멈춤" ? "ABORTED" : "VERIFY_FAILED");
  expect(await page.locator("select").inputValue()).toBe("busan");
  expect(await page.title()).toBe("");
});

it("실제 누르기가 가려진 단추를 기다리는 동안 멈추면 앞뒤 어느 단추도 동작하지 않는다", async () => {
  const { page, adapter } = await fixture('<button onclick="document.title=String(1)">앞 단추</button><button id="cover" onclick="document.title=String(2)" hidden>다른 단추</button>');
  const item = (await adapter.observe()).outline!.items![0]!;
  const stopped = new AbortController();
  const arrived = gate();
  const { tab } = await stagehandTab(page);
  const evaluate = tab.evaluate.bind(tab);
  let observations = 0;
  vi.spyOn(tab, "evaluate").mockImplementation(async (source, arg) => {
    const result = await evaluate(source, arg);
    if (typeof source === "string" && source.includes('"ref":"' + item.ref + '"') && ++observations === 2) {
      await page.locator("#cover").evaluate(el => { el.removeAttribute("hidden"); el.style.cssText = "position:fixed;inset:0;z-index:99"; });
      arrived.resolve();
    }
    return result;
  });
  const clicking = adapter.execute(action("click", item), stopped.signal);
  await arrived.promise;
  await delay(80);
  stopped.abort();
  expect((await clicking).errorCode).toBe("ABORTED");
  await page.locator("#cover").evaluate(el => { el.setAttribute("hidden", ""); });
  await delay(120);
  expect(await page.title()).toBe("");
});

it("입력 검사 설치 도중 멈춰도 뒤늦게 도착한 리스너를 정리해 다른 단추 클릭을 막지 않는다", async () => {
  const { page, adapter } = await fixture('<button onclick="document.title=\'첫 단추\'">첫 단추</button><button onclick="document.title=\'다른 단추\'">다른 단추</button>');
  const item = (await adapter.observe()).outline!.items!.find(control => control.name === "첫 단추")!;
  const orig = page.evaluateHandle.bind(page);
  const installed = gate(), release = gate();
  vi.spyOn(page, "evaluateHandle").mockImplementation((async (fn: unknown, ...args: unknown[]) => {
    const handle = await (orig as (...a: unknown[]) => Promise<unknown>)(fn, ...args);
    if (typeof fn === "string" && fn.includes("addEventListener")) {
      installed.resolve();
      await release.promise;
    }
    return handle;
  }) as typeof page.evaluateHandle);
  const stop = new AbortController();
  const clicking = adapter.execute(action("click", item), stop.signal);
  try {
    await installed.promise;
    stop.abort();
    expect((await clicking).errorCode).toBe("ABORTED");
  } finally { release.resolve(); }
  await delay(100);
  await page.getByRole("button", { name: "다른 단추" }).click();
  expect(await page.title()).toBe("다른 단추");
});

it("입력 전에 초점이 비밀번호로 옮겨지거나 원래 칸이 비밀번호로 바뀌면 쓰지 않는다", async () => {
  for (const focus of ["document.getElementById('secret').focus()", "this.type='password'"]) {
    const { adapter, page } = await fixture('<input id="field" onfocus="' + focus + '"><input id="secret" type="password">');
    expect((await adapter.execute(action("fill", { fieldId: "field" }, "민감한 입력"))).errorCode).toBe("VERIFY_FAILED");
    expect(await page.locator("#field").inputValue()).toBe("");
    expect(await page.locator("#secret").inputValue()).toBe("");
  }
});

it("중단된 입력은 늦게 도착해도 값이나 키 입력을 보내지 않는다", async () => {
  const { adapter, page } = await fixture('<input id="field"><input type="password">');
  const { tab } = await stagehandTab(page);
  const evaluate = tab.evaluate.bind(tab);
  const arrived = gate(), release = gate();
  vi.spyOn(tab, "evaluate").mockImplementation(async (source, arg) => {
    if (typeof arg === "object" && arg !== null && "token" in arg) { arrived.resolve(); await release.promise; }
    return evaluate(source, arg);
  });
  const stop = new AbortController();
  const running = adapter.execute(action("fill", { fieldId: "field" }, "입력값"), stop.signal);
  try {
    await arrived.promise;
    stop.abort();
    expect((await running).errorCode).toBe("ABORTED");
  } finally { release.resolve(); }
  await delay(150);
  expect(await page.locator("#field").inputValue()).toBe("");
});

it("실제 SDK 추론에는 해당 탭의 공개된 가린 항목 이름과 번호만 전달한다", async () => {
  const { page } = await fixture('<button>연락 010-5555-0123</button><input value="private-field"><input type="password" value="private-password"><textarea>private-note</textarea><iframe srcdoc="<button>private-frame</button>"></iframe>');
  let calls = 0;
  const pool = new ModelConnections(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const prompt = request.messages.find(item => item.role === "user")!.content;
    expect(prompt).not.toMatch(/private-|010-5555-0123/u);
    const id = prompt.match(/\[(\d+-\d+)\] button: 연락/u)?.[1];
    expect(id).toBeDefined();
    calls++;
    const content = JSON.stringify({ elements: [{ elementId: id, method: "click", arguments: [], description: "임의의 설명" }] });
    return Response.json({ choices: [{ message: { content } }] });
  });
  const llm = createStructuredLlm({ provider: "openai-compatible", model: "시험", baseUrl: "http://127.0.0.1:9" }, { pool })!;
  const result = await observedSelectors(page, "연락 단추", llm, new AbortController().signal);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatch(/^xpath=.*button/u);
  expect(calls).toBe(1);
});

it("앱이 만든 지속 프로필의 실제 탭에도 붙는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheongeum-b2-"));
  try {
    const ctx = await launchChromeProfile(dir, 0, "stagehand", { channel: "chromium", headless: true });
    try {
      const adapter = new PlaywrightExecutionAdapter({ context: ctx, driver: "stagehand", allowedOrigins: [] });
      try {
        await adapter.start();
        const page: Page = adapter.page!;
        await page.setContent("<title>지속 프로필</title>");
        expect((await adapter.observe()).title).toBe("지속 프로필");
      } finally { await adapter.close(); }
    } finally { await closeLaunchedBrowser(ctx); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
