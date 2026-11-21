import { expect, it, vi } from "vitest";
import { z } from "zod";
import { AdapterError } from "../../src/agents/web/browser/index.ts";
import { ModelConnections, OPENAI_BASE_URL, OpenAIVisionLlm } from "../../src/core/llm.ts";
import { pngSize } from "../../src/core/picture.ts";
import { ActionLog } from "../../src/personal/action_log.ts";
import { HISTORY_DESCRIBED, UNCHECKED_NUMBERS } from "../../src/speech/picture.ts";
import { fakeFetch, FakeLlm } from "../helpers.ts";
import { browserCases, latch } from "./browser-cases.ts";

const open = browserCases(), home = "http://localhost:5174";
const question = "스크린샷으로 접수 마감과 누를 수 있는 것을 알려줘", description = "접수가 23일에 끝나요.";
const textReader = (decision: string, answer = "", evidence: string[] = []) => new FakeLlm({ screen_text_decision: { decision, answer, evidence } });
const payload = z.object({ response_format: z.object({ json_schema: z.object({ name: z.string() }) }),
  messages: z.tuple([z.unknown(), z.object({ content: z.tuple([z.object({ text: z.string() }), z.object({ image_url: z.object({ url: z.string() }) })]) })]) });
async function picture(status = 200) {
  const log = new ActionLog();
  const opened = await open({ actionLog: log });
  await opened.page.goto(home + "/picture.html");
  const http = fakeFetch(request => {
    expect(request.url).toBe(OPENAI_BASE_URL + "/chat/completions");
    return Response.json({ choices: [{message: {content: JSON.stringify({screen: "normal", description, pressable: [999, 1]})}}] }, { status });
  });
  opened.session.deps.visionLlm = new OpenAIVisionLlm({model: "test", baseUrl: OPENAI_BASE_URL, apiKey: "fixture", pool: new ModelConnections(http)});
  async function sent(i = 0) {
    const item = payload.parse(await http.calls[i]!.clone().json());
    expect(item.response_format.json_schema.name).toBe("screen_picture");
    const [prompt, image] = item.messages[1].content;
    const url = image.image_url.url;
    return { prompt: prompt.text, url, size: pngSize(Buffer.from(url.split(",")[1]!, "base64")) };
  }
  return { ...opened, log, calls: http.calls, sent };
}

it.each([false, true])("test_numbered_followup_uses_the_control_that_was_described", async replace => {
  const { session, page, log, calls, sent } = await picture();
  session.deps.webLlm = textReader("answer", "이미지를 생략합니다.", ["닫기"]);
  await page.locator("#close").evaluate(el => el.setAttribute("onclick", "this.remove()"));
  const before = log.recent().length;
  const response = await session.handleTurn(question);
  expect(response.semanticAction).toBe("describe-picture");
  expect(session.deps.webLlm).toMatchObject({calls: []});
  const { prompt, size } = await sent();
  expect(prompt).toContain(question);
  expect(prompt).toContain("1. 닫기");
  expect(prompt).not.toContain("900101-1234567");
  expect(size).toEqual([1100, 860]);
  expect(response.actions).toMatchObject([{ action: {type: "capture"}, policy: {allowed: true} }]);
  expect(log.recent().slice(before).map(row => row.phase)).toEqual(["before", "after"]);
  expect(JSON.stringify(response)).not.toContain("base64");
  for (const fragment of [description, UNCHECKED_NUMBERS, "1번 '닫기'"]) expect(response.speech).toContain(fragment);
  expect(session.exportHistory().at(-1)?.text).toBe(HISTORY_DESCRIBED);
  if (replace) await page.locator("#close").evaluate(el => el.replaceWith(el.cloneNode(true)));
  const follow = await session.handleTurn("1번 눌러줘");
  expect(await page.locator("#close").count()).toBe(Number(replace));
  if (replace) expect(follow.speech).toContain("바뀌었어요");
  expect(calls).toHaveLength(1);
});

it("test_compound_turn_does_not_put_picture_text_into_planner_history", async () => {
  const { session, calls, sent } = await picture();
  const result = await session.handleTurn(question + " 그리고 화면 설명해줘");
  expect(result.speech).toContain(description);
  expect(calls.length).toBeGreaterThan(0);
  for (let i = 0; i < calls.length; i++) expect((await sent(i)).prompt).not.toContain(description);
  expect(session.exportHistory().at(-1)?.text).not.toContain(description);
});

it("test_selected_passage_is_explained_without_a_screenshot", async () => {
  const { session, adapter, page, calls } = await picture();
  const selected = "대기 접수는 빈자리가 생기면 연락을 드립니다.", answer = "지금은 대기 명단에 올라가고, 자리가 나면 연락이 온다는 뜻이에요.";
  await page.setContent("<main><h1>신청 종류</h1><p>즉시 접수는 오늘 처리합니다.</p><p id='wait'>" + selected + "</p></main>");
  await page.locator("#wait").evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  });
  const model = textReader("answer", answer, [selected]);
  session.deps.webLlm = model;
  const capture = vi.spyOn(adapter, "capture");
  expect((await session.handleTurn("이 부분이 무슨 뜻이야?")).speech).toContain(answer);
  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]?.user).toContain(selected);
  expect(capture).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it("test_unspecified_part_prompts_for_a_target", async () => {
  const { session, adapter, page, calls } = await picture();
  await page.setContent("<main><p>일반 접수</p><p>대기 접수</p></main>");
  session.deps.webLlm = textReader("clarify", "어느 부분인지 알려 주시겠어요?");
  const capture = vi.spyOn(adapter, "capture");
  expect((await session.handleTurn("이 부분이 무슨 뜻이야?")).speech).toMatch(/어느|어떤|선택|가리/u);
  expect(capture).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it("test_focused_input_uses_its_label_without_sending_the_value", async () => {
  const { session, page, calls } = await picture();
  await page.setContent("<main><label for=\"desk\">방문 창구</label><input id=\"desk\" value=\"private-fixture\"></main>");
  await page.locator("input").focus();
  const model = textReader("answer", "방문할 창구를 적는 곳이에요.", ["방문 창구"]);
  session.deps.webLlm = model;
  expect((await session.handleTurn("이 부분이 무슨 뜻이야?")).speech).toContain("방문할 창구");
  expect(model.calls).toHaveLength(1);
  const user = model.calls[0]!.user;
  expect(JSON.parse(user)).toMatchObject({ screenTarget: {label: "방문 창구"} });
  expect(user).not.toContain("private-fixture");
  expect(calls).toHaveLength(0);
});

it("test_chart_with_a_text_equivalent_can_answer_without_vision", async () => {
  const { session, page, calls, adapter } = await picture();
  const equivalent = "파란 창구는 운영 중이고 초록 창구는 점심시간입니다.";
  await page.setContent('<main><h1>창구 현황</h1><canvas aria-label="' + equivalent + '"></canvas></main>');
  const model = textReader("answer", "파란 창구가 운영 중이에요.", [equivalent]), capture = vi.spyOn(adapter, "capture");
  session.deps.webLlm = model;
  expect((await session.handleTurn("화면 설명해줘")).speech).toContain("파란 창구가 운영 중이에요");
  expect(model.calls[0]?.user).toContain(equivalent);
  expect(capture).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it("글이 없는 캔버스에서 화면 전체를 물으면 글 모델이 포기해도 사진을 확인한다", async () => {
  const { session, page, calls } = await picture();
  await page.setContent("<main><canvas width=400 height=120></canvas></main>");
  await page.evaluate(() => document.querySelector("canvas")?.getContext("2d")?.fillText("접수 마감 23일", 10, 40));
  session.deps.webLlm = textReader("clarify", "어느 부분인가요?");
  const reading = await session.handleTurn("본문 읽어줘");
  expect(reading.speech).toContain("화면 설명해줘");
  expect(calls).toHaveLength(0);
  const result = await session.handleTurn("화면 설명해줘");
  expect(calls).toHaveLength(1);
  expect(result.speech).toContain(description);
});

it("test_visual_screen_description_sends_one_masked_page_with_recent_user_context", async () => {
  const { session, page, calls, adapter, sent } = await picture();
  const recent = "신청 마감일을 찾고 있어요.", privateName = "시험용김별님", old = "오래된 입력은 보내지 않아요.";
  session.personal.saveVault({name: privateName});
  // Populate the same bounded history through ordinary turns.
  await session.handleTurn(old);
  for (let i = 0; i < 17; i++) await session.handleTurn("도움말");
  await session.handleTurn("내 이름은 " + privateName);
  await session.handleTurn(recent);
  await page.setContent("<style>body{margin:0}input{width:300px;height:40px}</style>\n        <title>신청 접수 안내</title><main><h1>민원 공고문</h1><p>접수 기한은 안내표에 나와 있습니다.</p>\n        <canvas aria-label=\"접수 일정표\"></canvas><p>주민등록번호 900101-1234567</p><div style=\"height:1200px\"></div>\n        <input aria-label=\"메모\" value=\"synthetic-field-content\"></main>");
  await page.evaluate(() => document.querySelector("canvas")?.getContext("2d")?.fillText("접수 마감 23일", 10, 40));
  const model = textReader("visual"), capture = vi.spyOn(adapter, "capture");
  session.deps.webLlm = model;
  const result = await session.handleTurn("화면 설명해줘");
  expect(result.semanticAction).toBe("describe-screen");
  expect(result.speech).toContain(description);
  expect(capture).toHaveBeenCalledTimes(1);
  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]?.schemaName).toBe("screen_text_decision");
  expect(calls).toHaveLength(1);
  const { prompt, url, size } = await sent(), user = model.calls[0]!.user;
  for (const fragment of [recent, "접수 기한은 안내표"]) { expect(user).toContain(fragment); expect(prompt).toContain(fragment); }
  for (const secret of [privateName, "900101-1234567", "synthetic-field-content", old, "base64"]) {
    expect(user).not.toContain(secret); expect(prompt).not.toContain(secret);
  }
  expect(prompt).toContain("민원 공고문");
  expect(prompt).toContain("화면 설명해줘");
  expect(size[1]).toBe(await page.evaluate(() => document.documentElement.scrollHeight));
  expect(size[1]).toBeGreaterThan(1200);
  const pixel = await page.locator("input").evaluate(async (el, src) => {
    const im = new Image(); im.src = src; await im.decode();
    const ctx = document.createElement("canvas").getContext("2d")!, box = el.getBoundingClientRect();
    ctx.drawImage(im, box.left + 10, box.top + scrollY + 10, 1, 1, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, url);
  expect(pixel).toEqual([0, 0, 0, 255]);
  expect(JSON.stringify(result)).not.toContain("base64");
  expect(session.exportHistory().at(-1)?.text).not.toContain(description);
});

it("test_text_only_commands_skip_image_capture", async () => {
  const { session, page, adapter, calls } = await picture();
  session.deps.webLlm = textReader("visual");
  await page.setContent("<main><h1>월별 통계</h1><canvas aria-label=\"통계 차트\"></canvas></main>");
  const capture = vi.spyOn(adapter, "capture");
  for (const speech of ["본문 읽어줘", "도움말", "스크린샷 말고 화면을 설명해줘", "스크린샷 없이 차트를 알려줘"]) await session.handleTurn(speech);
  session.deps.visionLlm = undefined;
  expect((await session.handleTurn(question)).speech).toContain("모델이 설정되지");
  expect(capture).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it("test_semantic_read_skill_honors_capture_exclusion", async () => {
  const { session, adapter, calls } = await picture();
  session.deps.webLlm = textReader("visual");
  const model = new FakeLlm({public_service_decision: {kind: "read_skill", skill: "DESCRIBE_SCREEN", source: null, agency: null, subject: null, goal: null,
    requestedFacts: [], exclusions: ["screen_capture"], searchMode: null, continuation: false, question: null, choices: [], reply: null}});
  session.deps.llm = model;
  const capture = vi.spyOn(adapter, "capture");
  const result = await session.handleTurn("이 페이지 구성을 글 위주로 한번 짚어 주실래요?");
  expect(model.calls[0]?.schemaName).toBe("public_service_decision");
  expect(result.semanticAction).toBe("describe-screen");
  expect(result.speech).toBeTruthy();
  expect(capture).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it.each(["password", "provider"])("test_screen_description_uses_text_when_the_image_is_unavailable", async failure => {
  const { session, page, calls } = await picture(503);
  session.deps.webLlm = textReader("visual");
  await page.setContent('<title>공고 안내문</title><main><h1>공고 안내문</h1><p>접수 안내입니다.</p><canvas aria-label="일정표"></canvas>' +
    (failure === "password" ? '<input type="password">' : "") + "</main>");
  const result = await session.handleTurn("화면 설명해줘");
  if (failure === "password") {
    expect(["describe-screen", "auth-handoff"]).toContain(result.semanticAction);
    expect(result.speech).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(result.actions.map(a => a.action.type)).not.toContain("capture");
  } else {
    expect(result.semanticAction).toBe("describe-screen");
    expect(result.speech).toContain("공고 안내문");
    expect(calls.length).toBeGreaterThan(0);
    expect(session.exportHistory().every(row => !row.text.includes("base64"))).toBe(true);
  }
});

it.each([question, "화면 설명해줘"])("test_declined_consent_refuses_before_observing_or_capturing", async utterance => {
  const { session, adapter } = await open({requireConsent: true});
  await session.consentTo(false);
  const observe = vi.spyOn(adapter, "observe");
  expect((await session.handleTurn(utterance)).semanticAction).toBe("consent");
  expect(observe).not.toHaveBeenCalled();
});

it("test_capture_failure_does_not_contact_provider", async () => {
  const { session, adapter, calls } = await picture();
  vi.spyOn(adapter, "capture").mockRejectedValue(new AdapterError("TIMEOUT"));
  expect((await session.handleTurn(question)).speech).toContain("찍지 못했어요");
  expect(calls).toHaveLength(0);
});

it.each(["quota", "audit"])("test_capture_requires_action_budget_and_working_audit_log", async failure => {
  const { session, adapter, calls, log } = await picture();
  if (failure === "quota") session.web.guard.config.maxActionsPerTurn = 0;
  else vi.spyOn(log, "append").mockImplementation(() => { throw new Error("test audit write failure"); });
  const capture = vi.spyOn(adapter, "capture");
  expect((await session.handleTurn(question)).speech).toContain(failure === "quota" ? "횟수" : "기록");
  expect(capture).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it("test_lazy_footer_is_in_one_full_page_request_and_its_button_can_be_pressed", async () => {
  const { session, page, sent, calls } = await picture();
  await page.setContent("<body style=\"margin:0\"><header>안내문</header><div style=\"height:2400px\"></div>\n        <footer id=\"end\" style=\"height:150px\"></footer><script>\n        const footer = document.querySelector('#end');\n        new IntersectionObserver(([entry], io) => {\n            if (!entry.isIntersecting) return;\n            footer.innerHTML = '<button onclick=\"this.remove()\">일정 자세히</button>';\n            io.disconnect();\n        }).observe(footer);\n        </script></body>");
  await page.evaluate(() => scrollTo(0, 400));
  const previous = await page.evaluate(() => scrollY);
  expect(await page.locator("button").count()).toBe(0);
  expect((await session.handleTurn(question)).speech).toContain("1번 '일정 자세히'");
  expect(calls).toHaveLength(1);
  const { prompt, size } = await sent();
  expect(prompt).toContain("일정 자세히");
  expect(size[1]).toBe(await page.evaluate(() => document.documentElement.scrollHeight));
  expect(size[1]).toBeGreaterThan(2400);
  expect(await page.evaluate(() => scrollY)).toBe(previous);
  await session.handleTurn("1번 눌러줘");
  expect(await page.locator("button").count()).toBe(0);
});

it("test_scrollable_main_panel_restores_its_position_and_masks_its_footer", async () => {
  const { session, page, sent, calls } = await picture();
  await page.setContent("<style>*{box-sizing:border-box}body{margin:0;overflow:hidden}\n        main{height:100vh;overflow:auto}p{margin:0;height:85px;background:#ffcc00}</style>\n        <main><div style=\"height:1800px\">위쪽 안내</div><p>계좌번호 110-123-456789</p></main>");
  await page.locator("main").evaluate(el => { el.scrollTop = 460; });
  await session.handleTurn(question);
  expect(calls).toHaveLength(1);
  const { size, url } = await sent();
  expect(size).toEqual([1100, 1885]);
  const pixel = await page.evaluate(async src => {
    const im = new Image(); im.src = src; await im.decode();
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.drawImage(im, 500, 1840, 1, 1, 0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, url);
  expect(pixel).toEqual([0, 0, 0, 255]);
  expect(await page.locator("main").evaluate(el => [el.scrollTop, el.clientHeight])).toEqual([460, 860]);
});

it("test_oversize_page_is_refused_before_any_screenshot_or_upload", async () => {
  const { session, page, calls } = await picture();
  await page.setContent("<main style=\"height:80000px\">아주 긴 목록</main>");
  const screenshot = vi.spyOn(page, "screenshot");
  expect((await session.handleTurn(question)).speech).toContain("너무 크거나");
  expect(screenshot).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it.each(["stop", "navigate"])("test_interrupted_text_decision_does_not_capture_the_new_screen", async interrupt => {
  const { session, page, adapter, calls } = await picture();
  await page.setContent("<main><h1>일정표</h1><canvas aria-label=\"접수 일정표\"></canvas></main>");
  const ready = latch(), release = latch();
  session.deps.webLlm = new FakeLlm(async () => { ready.resolve(); await release.promise; return {decision: "visual", answer: "", evidence: []}; });
  const capture = vi.spyOn(adapter, "capture");
  const pending = session.handleTurn("화면 설명해줘");
  try {
    await ready.promise;
    if (interrupt === "stop") await session.handleTurn("멈춰");
    else await page.goto(home);
  } finally { release.resolve(); }
  const result = await pending;
  if (interrupt === "stop") expect(result.state).toBe("STOPPED");
  expect(capture).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
});

it("test_interrupt_while_capturing_discards_the_picture", async () => {
  const { session, adapter, calls } = await picture();
  const ready = latch(), release = latch(), capture = adapter.capture.bind(adapter);
  vi.spyOn(adapter, "capture").mockImplementation(async (...args) => {
    const shot = await capture(...args); ready.resolve(); await release.promise; return shot;
  });
  const pending = session.handleTurn(question);
  try { await ready.promise; await session.handleTurn("멈춰"); }
  finally { release.resolve(); }
  expect((await pending).state).toBe("STOPPED");
  expect(calls).toHaveLength(0);
});
