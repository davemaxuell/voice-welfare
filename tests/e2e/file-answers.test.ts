import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, expect, it } from "vitest";
import { MAX_BYTES, MAX_PAGES } from "../../src/agents/web/file_answer.ts";
import { ModelConnections, OPENAI_BASE_URL, OpenAIStructuredLlm } from "../../src/core/llm.ts";
import { fakeFetch, FakeLlm } from "../helpers.ts";
import { browserCases, flat, latch } from "./browser-cases.ts";

const open = browserCases(), folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

async function files(answer = "신청 기한은 12월 31일이에요.", evidence: string[] = []) {
  const opened = await open(), store = opened.session.deps.downloads;
  if (!store) throw new Error("Browser session needs a download store");
  const http = fakeFetch(req => {
    expect(req.url).toBe(OPENAI_BASE_URL + "/chat/completions");
    return Response.json({choices: [{message: {content: JSON.stringify({answer, evidence})}}]});
  });
  opened.session.deps.fileLlm = new OpenAIStructuredLlm({model: "test-vision", apiKey: "fixture", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(http)});
  const folder = await mkdtemp(join(tmpdir(), "cheongeum-file-turn-")); folders.push(folder);
  const file = (name: string) => join(folder, name);
  return { ...opened, store, calls: http.calls, file };
}
function hwpx(text: string) { return zipSync({"Contents/section0.xml": strToU8("<r><t>" + text + "</t></r>")}); }

it("test_local_read_stays_private_after_another_plan_step", async () => {
  const { session, store, file } = await files();
  const marker = "노란 수첩에 적은 개인 메모", path = file("안내.hwpx");
  await writeFile(path, hwpx(marker)); store.remember(path);
  let steps = [flat("READ_DOWNLOAD"), flat("UNKNOWN", {text: "일주일은 며칠인가요?"})];
  const model = new FakeLlm(({ schemaName }) => schemaName === "intent_plan" ? {steps} :
    schemaName === "chat_route" ? {route: "general", reply: "7일이에요."} : undefined);
  session.deps.llm = model;
  const first = await session.handleTurn("받은 문서를 읽고 일주일이 며칠인지도 말해줘");
  expect(first.speech).toContain(marker); expect(first.speech).toContain("7일이에요");
  steps = [flat("UNKNOWN")];
  await session.handleTurn("그 밖에 또 무엇이 있을까?");
  expect(model.calls.filter(c => c.schemaName === "intent_plan")).toHaveLength(2);
  expect(model.calls.every(c => !c.user.includes(marker))).toBe(true);
});

it.each([false, true])("test_scan_upload_is_bound_to_one_confirmation", async button => {
  const { session, page, store, calls, file } = await files();
  const path = file("playwright-temporary-name");
  // Generate an image-only PDF with Chromium's print renderer.
  await page.setContent('<main style="width:100px;height:100px;background:#888"></main>');
  const bytes = await page.pdf({path, printBackground: true});
  store.remember(path, "안내문.pdf");
  expect((await session.handleTurn("받은 파일 그대로 읽어줘")).speech).toContain("글을 찾지 못했어요");
  const ask = await session.handleTurn("받은 PDF에서 신청 기한이 언제야?");
  expect(ask.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  for (const term of ["안내문.pdf", "OpenAI", "개인 정보"]) expect(ask.speech).toContain(term);
  expect(calls).toHaveLength(0);
  const id = ask.pendingConfirmation?.actionId;
  expect((await session.confirm(true, "file:other")).speech).toContain("바뀌었어요");
  expect(calls).toHaveLength(0);
  const result = button ? await session.confirm(true, id) : await session.handleTurn("네");
  expect(result.speech).toContain("AI가 이미지를"); expect(result.speech).toContain("12월 31일");
  await session.confirm(true, id);
  expect(calls).toHaveLength(1);
  const request: unknown = await calls[0]!.json();
  expect(request).toMatchObject({model: "test-vision", messages: [expect.anything(), {content: [
    {text: expect.stringContaining("신청 기한")}, {type: "file", file: {file_data: "data:application/pdf;base64," + bytes.toString("base64")}},
  ]}]});
});

it("test_file_replacement_refusal_stop_and_unrelated_speech", async () => {
  const { session, store, calls, file } = await files();
  const path = file("안내.png"); await writeFile(path, "first"); store.remember(path);
  await session.handleTurn("받은 파일 요약해줘"); await writeFile(path, "other");
  expect((await session.handleTurn("응")).speech).toContain("파일이 바뀌어서");
  for (const reply of ["아니요", "네이버", "멈춰"]) {
    expect((await session.handleTurn("받은 파일 요약해줘")).pendingConfirmation).toBeDefined();
    const response = await session.handleTurn(reply);
    if (reply === "멈춰") { expect(response.state).toBe("STOPPED"); expect(response.speech).toContain("파일을 보내지 않았어요"); }
    expect(session.dialogue.approval).toBeUndefined();
    await session.handleTurn("네");
  }
  expect(calls).toHaveLength(0);
});

it("test_queued_yes_and_new_download_with_same_name", async () => {
  const { session, store, calls, file } = await files();
  const a = file("A"), b = file("B"), second = Buffer.from("second-file");
  await writeFile(a, "first-file"); await writeFile(b, second); store.remember(a, "안내.png");
  const [prompt, premature] = await Promise.all([session.handleTurn("받은 파일 요약해줘"), session.handleTurn("네")]);
  expect(prompt.pendingConfirmation).toBeDefined(); expect(premature.speech).toContain("현재 안내"); expect(calls).toHaveLength(0);
  store.remember(b, "안내.png"); expect((await session.handleTurn("네")).speech).toContain("파일이 바뀌어서"); expect(calls).toHaveLength(0);
  await session.handleTurn("받은 파일 요약해줘");
  expect((await session.handleTurn("네")).speech).toContain("AI가 이미지를");
  expect(calls).toHaveLength(1);
  expect(await calls[0]!.json()).toMatchObject({messages: [expect.anything(), {content: [expect.anything(), {
    type: "image_url", image_url: {url: "data:image/png;base64," + second.toString("base64")},
  }]}]});
});

it("test_hwpx_grounding_and_local_fallback", async () => {
  const { session, store, calls, file } = await files("99만 원이에요.", ["교통비 12만 원"]);
  const path = file("안내.hwpx"); await writeFile(path, hwpx("교통비 12만 원")); store.remember(path);
  expect((await session.handleTurn("받은 파일 요약해줘")).speech).toContain("본문");
  expect((await session.handleTurn("예")).speech).toContain("근거를 확인하지 못했어요");
  expect(calls).toHaveLength(1);
  expect(await calls[0]!.json()).toMatchObject({messages: [expect.anything(), {content: expect.stringContaining("교통비 12만 원")}]});
  session.deps.fileLlm = undefined;
  const result = await session.handleTurn("받은 파일 요약해줘");
  expect(result.speech).toContain("원문"); expect(result.speech).toContain("교통비 12만 원"); expect(calls).toHaveLength(1);
});

it("test_size_and_page_limits_avoid_upload", async () => {
  const { session, page, store, calls, file } = await files();
  const path = file("big.pdf"); await writeFile(path, ""); await truncate(path, MAX_BYTES + 1); store.remember(path);
  const large = await session.handleTurn("받은 파일 요약해줘");
  expect(large.speech).toContain("20MB"); expect(large.pendingConfirmation).toBeUndefined();
  await page.setContent('<style>section:not(:last-child){break-after:page}</style>' + "<section>page</section>".repeat(MAX_PAGES + 1));
  await page.pdf({path}); await session.handleTurn("받은 파일 요약해줘");
  expect((await session.handleTurn("네")).speech).toContain("100쪽");
  expect(calls).toHaveLength(0);
});

it("test_stop_during_model_request_ends_progress", async () => {
  const { session, store, file } = await files();
  const started = latch(), waiting = latch();
  session.deps.fileLlm = Object.assign(new FakeLlm(async ({signal}) => {
    started.resolve(); signal?.addEventListener("abort", waiting.resolve, {once: true}); await waiting.promise;
    return {answer: "중단한 파일의 내용", evidence: []};
  }), {fileRecipient: "OpenAI"});
  const path = file("안내.png"); await writeFile(path, "image"); store.remember(path);
  await session.handleTurn("받은 파일 요약해줘");
  const pending = session.handleTurn("네");
  try {
    await started.promise;
    expect(session.progress.running).toBe(true); expect(session.progress.latest).toContain("파일을 읽는 중");
    expect((await session.handleTurn("멈춰")).state).toBe("STOPPED");
    const result = await pending;
    expect(result.state).toBe("STOPPED"); expect(result.speech).not.toContain("중단한 파일의 내용"); expect(session.progress.running).toBe(false);
  } finally { waiting.resolve(); await pending; }
});
