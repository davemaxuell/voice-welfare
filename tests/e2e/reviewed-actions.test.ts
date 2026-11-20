import type { Page } from "playwright";
import { expect, it } from "vitest";
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
