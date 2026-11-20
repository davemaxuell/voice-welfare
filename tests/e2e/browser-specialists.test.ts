import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { VisionModel } from "../../src/agents/web/visual_step.ts";
import { FakeLlm, PORTAL, scripted, step, withLlm } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const goal = PORTAL + "에서 장애인연금 안내 기사 내용 알려줘";
const link = "장애인연금 안내";
const answer = step("answer", null, "두 번째 페이지라는 안내 기사예요.", ["두 번째 페이지입니다"]);
const openPortal = step("open_url", "http://" + PORTAL);

it.each(["approve", "reject", "changed", "ambiguous", "invented"])("test_visual_recovery_requires_consent_and_a_stable_unique_control", async path => {
  const { session, page } = await open();
  const missing = step("click", "장애인연금 이미지 메뉴");
  scripted(session, [openPortal, missing, missing, answer]);
  const see = vi.fn<VisionModel["see"]>(async req => {
    expect(req.schemaName).toBe("visual_navigation_control");
    const { controls } = z.object({ controls: z.array(z.string()) }).parse(JSON.parse(req.user));
    expect(controls).toContain(link);
    expect(controls).not.toContain("보내기");
    if (path === "ambiguous") await page.getByText(link, { exact: true }).first().evaluate(el => el.after(el.cloneNode(true)));
    return { control: path === "invented" ? "로그인" : link };
  });
  session.deps.visionLlm = { see };
  const first = await session.handleTurn(goal);
  expect(first.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(first.pendingConfirmation?.kind).toBe("visual-navigation");
  expect(first.actions.map(a => a.action.type)).not.toContain("capture");
  expect(see).not.toHaveBeenCalled();
  if (path === "changed") await page.getByText(link, { exact: true }).first().evaluate(el => el.setAttribute("href", "/elsewhere"));
  const result = await session.confirm(path !== "reject", first.pendingConfirmation?.actionId);
  if (path === "approve") {
    expect(result.speech).toBe(answer.answer);
    expect(result.actions.map(a => a.action.type)).toEqual(["capture", "click"]);
    expect(result.actions[1]?.result?.verified).toBe(true);
  } else {
    expect(result.actions.map(a => a.action.type)).not.toContain("click");
  }
  expect(see).toHaveBeenCalledTimes(Number(path !== "changed" && path !== "reject"));
  expect(result.pendingConfirmation).toBeUndefined();
});

it.each([true, false])("test_two_grounding_failures_escalate_once_and_reverify", async repair => {
  const { session } = await open();
  const bad = step("answer", null, "기간은 399일이에요.", ["이런 안내는 본문에 없어요"]);
  scripted(session, [openPortal, step("click", link), bad, bad, bad]);
  const reviewer = new FakeLlm({ browse_step: repair ? answer : bad });
  session.deps.recoveryLlm = reviewer;
  const result = await session.handleTurn(goal);
  expect(reviewer.calls).toHaveLength(1);
  const { history } = z.object({ history: z.array(z.string()) }).parse(JSON.parse(reviewer.calls[0]!.user));
  expect(history.filter(row => row.includes("검증 실패"))).toHaveLength(2);
  expect(result.speech).not.toContain("399");
  expect(result.speech === answer.answer).toBe(repair);
});

it("test_routine_verified_request_skips_specialists", async () => {
  const { session } = await open();
  scripted(session, [openPortal, step("click", link), answer]);
  const recovery = new FakeLlm(), see = vi.fn();
  session.deps.recoveryLlm = recovery;
  session.deps.visionLlm = { see };
  expect((await session.handleTurn(goal)).speech).toBe(answer.answer);
  expect(recovery.calls).toHaveLength(0);
  expect(see).not.toHaveBeenCalled();
});

it("test_public_visual_continuation_keeps_prior_cited_passage", async () => {
  const { session, page } = await open();
  const documents = "방문 신청자는 신분증과 신청서를 지참합니다.", fee = "방문 신청 수수료는 400원입니다.";
  const pages: string[][] = [];
  withLlm(session, new FakeLlm(({ schemaName, user }) => {
    if (schemaName === "public_service_decision") return { kind: "find_information", source: "browser", agency: "정부24", subject: "주민등록등본",
      goal: "등본 방문 발급 서류와 수수료 확인", requestedFacts: ["documents", "amount"], exclusions: [], continuation: false, question: null, choices: [] };
    if (schemaName !== "public_browse_step") return undefined;
    const { missingFacts } = z.object({ missingFacts: z.array(z.string()) }).parse(JSON.parse(user));
    pages.push(missingFacts);
    return pages.length <= 2 ? { action: "click", target: "수수료 메뉴", claims: [{ fact: "documents", quote: documents }] } :
      { action: "answer", claims: [{ fact: "amount", quote: fee }] };
  }));
  session.deps.visionLlm = { async see() { return { control: "방문 안내" }; } };
  await page.route("https://www.gov.kr/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: "<title>정부24</title><main><p>" + (route.request().url().endsWith("/fees") ? fee : documents + "<a href='/fees'>방문 안내</a>") + "</p></main>" }));
  const first = await session.handleTurn("정부24에서 등본 방문 발급 서류와 수수료를 찾아줘");
  expect(first.pendingConfirmation).toBeDefined();
  const resumed = await session.confirm(true, first.pendingConfirmation?.actionId);
  expect(pages).toEqual([["documents", "amount"], ["amount"], ["amount"]]);
  expect(resumed.speech).toContain(documents);
  expect(resumed.speech).toContain(fee);
  expect(resumed.sources).toHaveLength(2);
  expect(resumed.actions.map(a => a.action.type)).toEqual(["capture", "click"]);
});

it("test_observed_passages_preserve_conditions_and_split_unrelated_footer_entries", async () => {
  const { page, adapter } = await open();
  await page.setContent(`<main><dl><dt>절차</dt><dd><ul><li>온라인 신청</li><li>가구원동의<br>(배우자)
    <p>해당자는 서류 제출</p></li></ul></dd></dl></main>
    <footer><address>사무실 위치</address><ul><li>전산 문의 <a href="tel:1234">1234</a></li>
    <li>제도 문의 5678</li></ul><p>이용약관</p></footer>`);
  const { outline } = await adapter.observe();
  expect(outline?.mainText).toContain("온라인 신청 가구원동의 (배우자) 해당자는 서류 제출");
  expect(outline?.footerText?.split("\n")).toEqual(["사무실 위치", "전산 문의 1234", "제도 문의 5678", "이용약관"]);
});
