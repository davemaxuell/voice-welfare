import { expect, it } from "vitest";
import { ExecContext } from "../../src/agents/web/agent.ts";
import { FakeLlm } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const same = "http://localhost:5174";
const other = "http://127.0.0.1:5174";
const ctx = () => new ExecContext({signal: new AbortController().signal, isStopped: () => false, trace() {}});
async function fixture() {
  const {session, adapter, page} = await open({practiceMode:false});
  await page.route("**/b3-*", route => {
    const path = new URL(route.request().url()).pathname;
    const html = path === "/b3-page"
      ? `<main><h1>화면 안내</h1><button>화면 도움말</button><span id="open"></span><span id="closed"></span>
          <iframe src="${same}/b3-inside"></iframe><iframe src="${other}/b3-outside"></iframe>
          <iframe aria-hidden="true" src="${other}/b3-hidden"></iframe></main>
          <script>
          const button = document.createElement('button'); button.textContent = '열린 도움말'; button.onclick = () => document.title = '열림';
          document.querySelector('#open').attachShadow({mode:'open'}).append(button);
          const closedButton = document.createElement('button'); closedButton.textContent = '닫힌 도움말';
          document.querySelector('#closed').attachShadow({mode:'closed'}).append(closedButton);
          </script>`
      : `<main><p>보내지 말아야 할 사적인 본문</p><textarea>보내지 말아야 할 메모</textarea>
          <div contenteditable="true"><button>사적인 편집 내용</button></div>
          <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">${path === "/b3-inside" ? "동네 소식" : path === "/b3-hidden" ? "숨은 단추" : "지원 일정"}</button>
          <button onclick="document.title='눌렀음'">확인</button><button>계정 삭제</button></main>`;
    return route.fulfill({contentType:"text/html; charset=utf-8",body:html});
  });
  await page.goto(same + "/b3-page");
  return {session, adapter, page};
}

it("같은 출처·다른 출처의 내부 문서와 열린 섀도의 단추를 관찰하고 그 항목만 누른다", async () => {
  const {adapter, session, page} = await fixture();
  const obs = await adapter.observe();
  const controls = obs.outline?.items ?? [];
  expect(controls.map(i => i.name)).toEqual(expect.arrayContaining(["동네 소식", "지원 일정", "열린 도움말"]));
  expect(JSON.stringify(obs)).not.toMatch(/사적인|숨은 단추|닫힌 도움말/u);
  expect(controls.filter(i => i.name === "확인")).toHaveLength(2);
  expect(new Set(controls.map(i => i.ref)).size).toBe(controls.length);
  for (const name of ["동네 소식", "지원 일정", "열린 도움말"]) {
    const out = await session.deps.web.followLink(name, ctx());
    expect(out.actions[0]?.result?.ok).toBe(true);
  }
  for (const frame of page.frames().filter(f => /b3-(?:inside|outside)$/u.test(f.url()))) {
    expect(await frame.locator("[aria-expanded]").getAttribute("aria-expanded")).toBe("true");
  }
  expect(await page.title()).toBe("열림");
});

it("내부 문서가 같은 주소로 다시 열리거나 이름이 바뀌면 이전 승인을 실행하지 않는다", async () => {
  const {adapter, page} = await fixture();
  const item = (await adapter.observe()).outline?.items?.find(i => i.name === "지원 일정");
  if (item === undefined) throw new Error("안쪽 단추가 필요해요.");
  const frame = page.frames().find(f => f.url() === other + "/b3-outside")!;
  const action = {id: "승인한-조작", type: "click" as const, risk: "low" as const, requiresConfirmation: false,
    target: {ref: item.ref, role: item.role, name: item.name}, reason: "지원 일정 읽기"};
  await frame.getByRole("button", {name: item.name}).evaluate(el => { el.textContent = "결제"; });
  expect((await adapter.execute(action)).ok).toBe(false);
  await frame.goto(frame.url());
  expect((await adapter.execute(action)).ok).toBe(false);
  expect(await frame.locator("[aria-expanded]").getAttribute("aria-expanded")).toBe("false");
});

it("바깥 화면 주소만 바뀌어도 남아 있는 안쪽 단추를 이전 번호로 누르지 않는다", async () => {
  const {page, adapter} = await fixture();
  const inner = page.frames().find(frame => frame.url() === other + "/b3-outside")!;
  const item = (await adapter.observe()).outline!.items!.find(control => control.name === "지원 일정")!;
  await page.evaluate(() => { history.pushState({}, "", "#다른-화면"); });
  expect((await adapter.execute({id:"이전-화면", type:"click", risk:"low", requiresConfirmation:false,
    reason:"일정 보기", target:{name:item.name, role:item.role, ref:item.ref}})).ok).toBe(false);
  expect(await inner.locator("[aria-expanded]").getAttribute("aria-expanded")).toBe("false");
});

it("출처가 다른 내부 창은 지원 사이트 권한을 물려받지 않고, 닫힌 섀도는 직접 선택하도록 안내한다", async () => {
  const {session, page} = await fixture();
  await page.frames().find(f => f.url() === same + "/b3-inside")!.getByRole("button", {name:"계정 삭제"}).evaluate(el => el.remove());
  const denied = await session.deps.web.followLink("계정 삭제", ctx());
  expect(denied.actions[0]?.policy.code).toBe("DENIED_READ_ONLY");
  await page.locator("iframe").evaluateAll(frames => frames.forEach(frame => frame.remove()));
  const missing = await session.deps.web.followLink("닫힌 도움말", ctx());
  expect(missing.message).toContain("직접");
  expect(missing.actions).toEqual([]);
});

it("열린 섀도와 바깥 문서에 이름이 같은 단추가 있으면 둘 중 하나를 짐작하지 않는다", async () => {
  const {session, page} = await fixture();
  await page.getByRole("button", {name:"화면 도움말"}).evaluate(el => { el.textContent = "열린 도움말"; });
  const result = await session.deps.web.followLink("열린 도움말", ctx());
  expect(result.status).toBe("needs-clarification");
  expect(result.actions).toEqual([]);
  expect(await page.title()).toBe("");
});

it("포인터 입력 도중 안쪽 단추의 이름이 바뀌면 클릭을 취소한다", async () => {
  const {page, adapter} = await fixture();
  const frame = page.frames().find(f => f.url() === other + "/b3-outside")!;
  const button = frame.getByRole("button", {name:"지원 일정"});
  await button.evaluate(el => { el.addEventListener("pointerdown", () => { el.textContent = "다른 단추"; }); });
  const item = (await adapter.observe()).outline!.items!.find(i => i.name === "지원 일정")!;
  expect((await adapter.execute({id:"포인터", type:"click", risk:"low", requiresConfirmation:false,
    reason:"일정 보기", target:{name:item.name, role:item.role, ref:item.ref}})).errorCode).toBe("VERIFY_FAILED");
  expect(await frame.locator("[aria-expanded]").getAttribute("aria-expanded")).toBe("false");
});

it("안쪽 단추에 포인터가 닿아 바깥 주소가 바뀌면 클릭을 마치지 않는다", async () => {
  const {page, adapter} = await fixture();
  const inner = page.frames().find(frame => frame.url() === same + "/b3-inside")!;
  await inner.getByRole("button", {name:"동네 소식"}).evaluate(button => {
    button.addEventListener("pointerdown", () => { window.parent.history.pushState({}, "", "#다른-화면"); });
  });
  const item = (await adapter.observe()).outline!.items!.find(control => control.name === "동네 소식")!;
  const result = await adapter.execute({id:"안쪽-포인터", type:"click", risk:"low", requiresConfirmation:false,
    reason:"소식 보기", target:{name:item.name, role:item.role, ref:item.ref}});
  expect(result.errorCode).toBe("VERIFY_FAILED");
  expect(await inner.locator("[aria-expanded]").getAttribute("aria-expanded")).toBe("false");
});

it("내부 창이 있어도 바깥 문서의 단순 공지 닫기는 기존 증명으로 동작한다", async () => {
  const {page, adapter, session} = await fixture();
  // 외부 사이트에 공지만 두고, 안내 확인과 같은 이름인 안쪽 단추는 없앤다.
  await page.goto(other + "/b3-page");
  for (const frame of page.frames().filter(f => f !== page.mainFrame())) {
    await frame.locator("button").evaluateAll(els => els.forEach(el => el.remove()));
  }
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("aria-label", "점검 공지");
    dialog.innerHTML = "<p>내일 오전에 자료가 갱신됩니다.</p><button>확인</button>";
    dialog.querySelector("button")!.onclick = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  });
  const item = (await adapter.observe()).outline!.items!.find(i => i.name === "확인")!;
  expect((await adapter.controlWindow("", 0, {ref:item.ref, notice:true})).items[0]?.notice?.shadows).toBe(0);
  const result = await session.deps.web.followLink("확인", ctx());
  expect(result.actions[0]?.policy.code).toBe("ALLOWED_NOTICE");
  expect(await page.locator("dialog").count()).toBe(0);
});

it("내부 문서의 일반 확인 단추는 음성으로 물은 뒤 한 번만 누른다", async () => {
  const {page, session} = await fixture();
  const inner = page.frames().find(f => f.url() === same + "/b3-inside")!;
  await page.frames().find(f => f.url() === other + "/b3-outside")!.getByRole("button", {name:"확인"}).evaluate(el => el.remove());
  await session.deps.web.observe(ctx());
  const ask = await session.handleTurn("확인 버튼 눌러줘");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(ask.speech).toContain("확인");
  expect(await inner.title()).toBe("");
  const yes = await session.handleTurn("눌러");
  expect(yes.actions.some(entry => entry.policy.code === "APPROVED" && entry.result?.ok === true)).toBe(true);
  expect(await inner.title()).toBe("눌렀음");
});

it.skipIf(process.env.BROWSER_DRIVER !== "stagehand").each(["동네 소식", "지원 일정"])(
  "의미로 찾은 내부 문서의 %s는 SDK 설명 대신 현재 관찰한 역할과 이름으로 실행한다", async name => {
    const {session, adapter} = await fixture();
    const observed = (await adapter.observe()).outline?.items?.find(item => item.name === name);
    const model = new FakeLlm(({user, schemaName}) => {
      if (schemaName !== "stagehand_pick") return undefined;
      expect(user).not.toMatch(/사적인|숨은|닫힌|localhost|127\.0\.0\.1|xpath|data-cheongeum|f-[a-f0-9-]+:r/u);
      const options = (JSON.parse(user) as {options: Record<string,string>}).options;
      const entry = Object.entries(options).find(([, label]) => label === name);
      expect(entry).toBeDefined();
      return {ref:entry?.[0]};
    });
    session.deps.webLlm = model;
    const term = name === "동네 소식" ? "우리 지역에 새로 생긴 일 보는 곳" : "언제 도움받을 수 있는지 보는 곳";
    const out = await session.handleTurn(term + " 눌러줘");
    expect(model.calls.filter(call => call.schemaName.endsWith("_pick")).map(call => call.schemaName)).toEqual(["stagehand_pick"]);
    expect(observed?.ref).toMatch(/^f-/u);
    expect(out.actions[0]?.action.target).toEqual({name, role:"button", ref: observed?.ref});
    expect(out.actions[0]?.result?.ok).toBe(true);
  });

it.skipIf(process.env.BROWSER_DRIVER !== "stagehand")("모델이 고르는 동안 같은 이름으로 내부 문서를 다시 열면 제안을 버린다", async () => {
  const {page, session} = await fixture();
  const frame = page.frames().find(f => f.url() === other + "/b3-outside")!;
  const model = new FakeLlm(async ({schemaName, user}) => {
    if (schemaName !== "stagehand_pick") return undefined;
    const code = Object.entries((JSON.parse(user) as {options:Record<string,string>}).options).find(([,name]) => name === "지원 일정")?.[0];
    await frame.goto(frame.url());
    return {ref:code};
  });
  session.deps.webLlm = model;
  const result = await session.handleTurn("언제 하는지 보는 곳 눌러줘");
  expect(model.calls.filter(call => call.schemaName.endsWith("_pick")).map(call => call.schemaName)).toEqual(["stagehand_pick"]);
  expect(result.speech).toMatch(/직접 선택|링크 목록/u);
  expect(result.actions).toEqual([]);
  expect(await frame.locator("[aria-expanded]").getAttribute("aria-expanded")).toBe("false");
});

it("숨겨진 유틸리티 iframe은 불투명 영역으로 오인하지 않고 보이는 sandbox iframe만 불투명으로 판정한다", async () => {
  const {page, adapter, session} = await open({practiceMode: false});
  await page.route("**/b3-opaque", route => route.fulfill({contentType: "text/html; charset=utf-8", body:
    `<main><h1>안내</h1><button>화면 도움말</button>
      <iframe style="display:none" srcdoc="<button>숨김1</button>"></iframe>
      <iframe aria-hidden="true" srcdoc="<button>숨김2</button>"></iframe>
      <iframe hidden sandbox srcdoc="<button>숨김3</button>"></iframe>
      <iframe style="width:0;height:0;border:0" srcdoc="<button>숨김4</button>"></iframe>
    </main>`}));
  await page.goto(same + "/b3-opaque");
  expect(await adapter.hasOpaqueContent!()).toBe(false);
  const plainMissing = await session.deps.web.followLink("없는 항목", ctx());
  expect(plainMissing.status).toBe("needs-clarification");
  expect(plainMissing.message).not.toContain("읽을 수 없는 영역");

  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "");
    frame.srcdoc = "<button>샌드박스 단추</button>";
    document.querySelector("main")!.append(frame);
  });
  expect(await adapter.hasOpaqueContent!()).toBe(true);
  const opaqueMissing = await session.deps.web.followLink("없는 항목", ctx());
  expect(opaqueMissing.status).toBe("needs-clarification");
  expect(opaqueMissing.message).toContain("읽을 수 없는 영역");
});
