import type { Page } from "playwright";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { FakeLlm, withLlm } from "../helpers.ts";
import { browserCases, flat } from "./browser-cases.ts";

const open = browserCases();
const parts = ["정부24를 열고", "방문 안내 링크를 누르고", "별칭 칸에 민들레를 입력하고", "이용 시간 안내 링크를 열어줘"];
const utterance = parts.join(" "), value = "민들레";
const answer = "방문 안내에서 별칭을 입력하고 이용 시간 안내 페이지를 열었어요.";
const proof = z.object({ requirements: z.array(z.string()), evidence: z.array(z.object({
  kind: z.string(), text: z.string(), id: z.number(), valueVerified: z.boolean().optional(),
})) });

async function installPages(page: Page) {
  const documents: string[] = [];
  const pages = new Map([
    ["/guide", ["방문 안내", '<label for="alias">별칭</label><input id="alias"><a href="/hours">이용 시간 안내</a>']],
    ["/hours", ["이용 시간 안내", "<p>운영 시간은 평일 오전부터입니다.</p>"]],
  ]);
  await page.context().route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "www.gov.kr" || route.request().resourceType() !== "document") return route.abort();
    documents.push(url.pathname);
    const [title, body] = pages.get(url.pathname) ?? ["정부24", '<a href="/guide">방문 안내</a>'];
    await route.fulfill({ contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="ko"><title>${title}</title><main><h1>${title}</h1>${body}</main>
        <script>document.addEventListener("input", event => {
          sessionStorage.setItem("alias", event.target.value);
          sessionStorage.setItem("inputs", String(Number(sessionStorage.getItem("inputs")) + 1));
        });</script></html>` });
  });
  return documents;
}

function plannedModel(afterReview?: () => Promise<unknown>) {
  return new FakeLlm(async ({ schemaName, user }) => {
    if (schemaName === "public_service_decision") return { kind: "review_before_output", agency: "정부24", source: null, searchMode: null,
      subject: "방문 안내", goal: "방문 안내를 열어 별칭 입력 후 이용 시간 안내를 연다", requestedFacts: [], exclusions: [], continuation: false,
      choices: [], question: null, skill: null, reply: null, difficulty: "medium", requirements: parts };
    if (schemaName === "intent_plan") return { steps: [flat("OPEN_SITE", { site: "정부24" }), flat("FOLLOW_LINK", { topic: "방문 안내" }),
      flat("FILL", { fills: [{ fieldMention: "별칭", value }] }), flat("FOLLOW_LINK", { topic: "이용 시간 안내" })] };
    if (schemaName !== "review_before_output") return undefined;
    expect(user).not.toContain(value);
    const { requirements, evidence } = proof.parse(JSON.parse(user));
    const checks = [["visit", "정부24"], ["action", "click 방문 안내"], ["action", "fill 별칭"], ["arrival", "/hours"]].map(([kind, marker], i) => {
      const row = evidence.find(e => e.kind === (kind === "action" ? "action" : "page") && e.text.includes(marker!));
      if (!row) throw new Error("Missing review evidence for " + marker);
      if (marker === "fill 별칭") expect(row.valueVerified).toBe(true);
      const citations = [{ id: row.id, quote: row.text }];
      if (kind === "arrival") {
        const click = evidence.find(e => e.text === "click 이용 시간 안내");
        if (!click) throw new Error("Missing last click");
        citations.unshift({ id: click.id, quote: click.text });
      }
      return { request: requirements[i], kind, citations };
    });
    await afterReview?.();
    return { checks, nextRoute: null, answer };
  });
}

it.each(["text", "approve", "exclude", "decline", "stale"])("reads the current tab and continues to the requested link during a reviewed voice turn (%s)", async decision => {
  const { session, page } = await open({practiceMode: false});
  const documents = await installPages(page);
  await page.goto("https://www.gov.kr/guide");
  await page.locator("main").evaluate(main => {
    const canvas = document.createElement("canvas");
    const ink = canvas.getContext("2d")!;
    ink.fillStyle = "gold";
    ink.font = "36px sans-serif";
    ink.fillText("➜", 10, 40);
    main.prepend(canvas);
  });
  const requests = [decision === "exclude" ? "지금 보고 있는 페이지의 안내를 글로만 읽어주고" : "지금 보고 있는 페이지의 안내를 읽어주고", "거기서 이용 시간 안내를 열어줘"];
  const description = "그림 속에 노란 화살표가 있어요.";
  const model = new FakeLlm(({schemaName, user}) => {
    if (schemaName === "public_service_decision") return {kind: "review_before_output", subject: "방문 안내",
      goal: "현재 화면 내용을 설명하고 이용 시간 안내를 연다", requestedFacts: [], exclusions: decision === "exclude" ? ["screen_capture"] : [], continuation: false,
      choices: [], difficulty: "medium", requirements: requests};
    if (schemaName === "intent_plan") return {steps: [flat("DESCRIBE_SCREEN"), flat("FOLLOW_LINK", {topic: "이용 시간 안내"})]};
    if (schemaName === "screen_text_decision") return {decision: decision === "text" ? "answer" : "visual", answer: "별칭 입력란이 있어요.", evidence: ["별칭"]};
    if (schemaName !== "review_before_output") return undefined;
    const {evidence} = proof.parse(JSON.parse(user));
    expect(user).not.toContain(description);
    const picture = evidence.find(row => row.kind === "action" && row.text.includes("음성 설명"));
    const fact = evidence.find(row => row.kind === "fact" && row.text.includes("별칭"));
    const arrival = evidence.find(row => row.kind === "page" && row.text.includes("/hours"));
    return {checks: [
      picture ? {request: requests[0], kind: "action", citations: [{id: picture.id, quote: picture.text}]}
        : {request: requests[0], kind: "fact", citations: fact ? [{id: fact.id, quote: "별칭"}] : []},
      {request: requests[1], kind: "arrival", citations: arrival ? [{id: arrival.id, quote: arrival.text}] : []},
    ], nextRoute: null, answer: picture && arrival ? "이용 시간 안내를 열었어요." : fact && arrival ? "방문 안내에는 별칭 입력란이 있어요. 이용 시간 안내를 열었어요." : ""};
  });
  const see = vi.fn(async () => ({screen: "normal", description, pressable: []}));
  session.deps.visionLlm = {see};
  withLlm(session, model);
  let result = await session.handleTurn(requests.join(" "), {fromVoice: true});
  expect(model.calls.some(call => call.schemaName === "screen_text_decision")).toBe(true);
  expect(see).not.toHaveBeenCalled();
  if (decision !== "text" && decision !== "exclude") {
    expect(documents).toEqual(["/guide"]);
    expect(result.state, result.speech).toBe("WAITING_FOR_USER_CONFIRMATION");
    expect(result.review?.status).toBe("needs_input");
    const id = result.pendingConfirmation!.actionId;
    if (decision === "stale") await page.evaluate(() => document.querySelector("h1")!.textContent = "다른 업무");
    result = await session.confirm(decision !== "decline", id);
    if (decision !== "approve") {
      expect(documents).toEqual(["/guide"]);
      expect(see).not.toHaveBeenCalled();
      expect(result.review?.status).not.toBe("completed");
      return;
    }
    expect(result.speech).toContain(description);
    expect(result.localSpeechOnly).toBe(true);
    expect(JSON.stringify(session.exportHistory())).not.toContain(description);
    await session.confirm(true, id);
    expect(see).toHaveBeenCalledTimes(1);
  } else expect(result.speech).toContain("별칭");
  expect(documents).toEqual(["/guide", "/hours"]);
  expect(result.review?.status, result.speech).toBe("completed");
});

it.each(["approve", "decline", "stale", "stop"])("test_reviewed_open_click_fill_click", async decision => {
  const { session, page } = await open();
  const documents = await installPages(page);
  const model = plannedModel();
  withLlm(session, model);
  const first = await session.handleTurn(utterance);
  expect(first.state, first.speech).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(first.review?.status).toBe("needs_input");
  const id = first.pendingConfirmation?.actionId;
  expect(await page.locator("#alias").inputValue()).toBe("");
  expect(documents.filter(u => u === "/guide")).toHaveLength(1);
  expect(documents).not.toContain("/hours");
  expect(model.calls.some(c => c.schemaName === "review_before_output")).toBe(false);
  if (decision === "stop") {
    expect((await session.handleTurn("멈춰")).state).toBe("STOPPED");
    await session.confirm(true, id);
  } else {
    if (decision === "stale") await page.evaluate(() => history.pushState({}, "", "?record=another"));
    const final = await session.confirm(decision !== "decline", id);
    if (decision === "approve") {
      expect(final.semanticAction, final.speech).toBe("review-before-output");
      expect(final.review, final.speech).toEqual({ status: "completed", difficulty: "medium", rounds: 1, maxRounds: 3, browserIterations: 0 });
      expect(final.speech).toBe(answer);
      expect(page.url()).toMatch(/\/hours$/u);
      expect(await page.evaluate(() => sessionStorage.getItem("alias"))).toBe(value);
      expect(await page.evaluate(() => sessionStorage.getItem("inputs"))).toBe("1");
      expect(documents.filter(u => u === "/guide")).toHaveLength(1);
      expect(documents.filter(u => u === "/hours")).toHaveLength(1);
      expect(model.calls.filter(c => c.schemaName === "review_before_output")).toHaveLength(1);
      return;
    }
  }
  expect(await page.evaluate(() => sessionStorage.getItem("alias"))).toBeNull();
  expect(documents.filter(u => u === "/guide")).toHaveLength(1);
  expect(documents).not.toContain("/hours");
});

it("test_final_arrival_is_checked_after_the_reviewer_replies", async () => {
  const { session, page } = await open();
  await installPages(page);
  withLlm(session, plannedModel(() => page.goto("https://www.gov.kr/guide")));
  const first = await session.handleTurn(utterance);
  const final = await session.confirm(true, first.pendingConfirmation?.actionId);
  expect(final.review?.status).toBe("incomplete");
  expect(final.speech).not.toContain(answer);
  expect(page.url()).toMatch(/\/guide$/u);
  expect(await page.evaluate(() => sessionStorage.getItem("inputs"))).toBe("1");
});
