import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import type { InteractiveItem, ObservedField } from "../../src/core/actions.ts";
import type { StructuredLlm } from "../../src/core/llm.ts";
import { draft, type DraftAction, type SourceCitation } from "../../src/core/turn.ts";
import {
  REVIEW_SYSTEM, coverage, evidenceFromDraft, inspectionEvidence, location, pageMatches, repetitions, reviewBeforeOutput, reviewEvidence, reviewPatterns, safe,
  type ReviewEvidence,
} from "../../src/orchestrator/task_review.ts";
import { FakeLlm } from "../helpers.ts";

const REQUEST = "Fill the applicant name, open the visit guide, and find the deadline.";
const REQUIREMENTS = ["Fill the applicant name", "open the visit guide", "find the deadline"];
const RECORDS = [
  reviewEvidence("action", "fill Applicant name"),
  reviewEvidence("page", "https://office.example/visits · Visit guide"),
  reviewEvidence("fact", "Applications close on November 28."),
];
const KINDS = ["action", "arrival", "fact"];

it("페이지 제목을 공지의 제목과 구분하고 현재 문서의 제목만 증거로 인정한다", async () => {
  const title = "보행 자료관", notice = "금요일 특별 개관";
  const request = "열린 탭 제목을 읽어 주세요";
  const evidence = [reviewEvidence("page", `https://archive.go.kr/ · ${title} · ${notice}`, {documentTitle: title, pageKey: "a"}),
    reviewEvidence("fact", notice)];
  const review = (id: number, value: string) => reviewBeforeOutput(answering({checks: [check(request, "document_title", id, value)],
    nextRoute: null, answer: value}), request, evidence, new AbortController().signal, {requiredDocumentTitle: true});
  expect((await review(1, notice)).status).not.toBe("complete");
  expect((await review(0, notice)).status).not.toBe("complete");
  expect((await review(0, title)).answer).toContain(title);
});

interface Check { request: string; kind: string; citations: { id: unknown; quote: string }[] }
interface Verdict { checks: Check[]; nextRoute: string | null; answer: string }

function check(request: string, kind: string, index?: number, quote = ""): Check {
  return { request, kind, citations: index === undefined ? [] : [{ id: index, quote }] };
}

function complete(): Verdict {
  return {
    checks: REQUIREMENTS.map((request, i) => check(request, KINDS[i] ?? "", i, RECORDS[i]?.text)),
    nextRoute: null, answer: "I filled the applicant name and opened the visit guide. Applications close on November 28.",
  };
}

function answering(raw: unknown): StructuredLlm {
  return { name: "fake", generate: async () => raw };
}

const idle = () => new AbortController().signal;

function decide(raw: unknown, { evidence = RECORDS, request = REQUEST, requirements = REQUIREMENTS }:
  { evidence?: readonly ReviewEvidence[]; request?: string; requirements?: readonly string[] } = {}) {
  return reviewBeforeOutput(answering(raw), request, evidence, idle(), { language: "en", requirements });
}

function field(fieldId: string, extra: Partial<ObservedField> = {}): ObservedField {
  return { fieldId, label: "", type: "text", required: false, visible: true, value: "", filled: false, invalid: false, sensitive: false, ...extra };
}

function view(url: string, title: string, extra: { fields?: ObservedField[]; items?: InteractiveItem[] } = {}) {
  return {
    platform: "pc" as const, pageId: "external", url, title, fields: extra.fields ?? [], errors: [], dialogs: [], capturedAt: "2026-11-20T00:00:00.000Z",
    outline: { headings: [], notices: [], steps: [], buttons: [], links: [], items: extra.items ?? [] },
  };
}

function action(kind: DraftAction["action"]["type"], target: DraftAction["action"]["target"],
  { allowed = true, ok = true, verified = true, resultId = "a", value = "" } = {}): DraftAction {
  return {
    agent: "web", policy: { allowed, code: "", reason: "" },
    action: { id: "a", type: kind, target, value, reason: "test", risk: "low", requiresConfirmation: false },
    result: { actionId: resultId, ok, verified, readValue: value, latencyMs: 0 },
  };
}

function source(url: string, title = "", note?: string): SourceCitation {
  return { title, url, lastCheckedAt: "2026-11-20", ...(note === undefined ? {} : { note }) };
}

it("test_review_releases_only_the_completed_grounded_result", async () => {
  const raw = complete();
  const verdict = await decide(raw);
  expect(verdict.status).toBe("complete");
  expect(verdict.answer).toBe(raw.answer);
  expect(verdict.nextRoute).toBeUndefined();
});

it("개인 결과를 요청하면 현재 탭에서 확인한 사실을 근거로 요구한다", async () => {
  const request = "접수한 민원 상태를 알려줘";
  const status = "담당자가 검토 중입니다.";
  const url = "https://portal.example/private/member-row?account=private-key";
  const tab = (name: string) => {
    const page = view(url, "민원함", {items: [{ref: "tab", name, role: "tab", region: "main", selected: true, disabled: false}]});
    return {...page, outline: {...page.outline, mainText: status}};
  };
  const current = tab("최근 접수");
  const evidence = await inspectionEvidence({view: current, reviewQuotes: [status, "접수 취소됨"]});
  const confirm = (kind: string, id: number, quote: string, answer = quote) => reviewBeforeOutput(answering({
    checks: [check(request, kind, id, quote)], nextRoute: null, answer,
  }), request, evidence, idle(), {inspection: "answer"});
  expect(evidence.map(row => row.text).join(" ")).not.toMatch(/member-row|private-key|접수 취소됨/u);
  expect((await confirm("arrival", 0, "민원함")).status).not.toBe("complete");
  const verdict = await confirm("fact", 1, status);
  expect(verdict.status).toBe("complete");
  expect((await confirm("fact", 1, status, "승인되었습니다.")).answer).toBe(status);
  const translation = "The case is under review.";
  const english = new FakeLlm(({schemaName}) => schemaName === "personal_answer_check" ? {faithful: true} :
    {checks: [check(request, "fact", 1, status)], nextRoute: null, answer: translation});
  expect((await reviewBeforeOutput(english, request, evidence, idle(), {inspection: "answer", language: "en"})).answer).toBe(translation);
  expect(english.calls.map(call => call.schemaName)).toEqual(["review_before_output", "personal_answer_check"]);
  expect((await confirm("fact", 1, "검토")).status).not.toBe("complete");
  const changed = {...current, outline: {...current.outline, mainText: "이전 기록: " + status}};
  expect((await inspectionEvidence({view: changed, reviewQuotes: [status]})).some(e => e.kind === "fact")).toBe(false);
  expect(pageMatches(verdict, current, [], true)).toBe(true);
  expect(pageMatches(verdict, tab("지난 접수"), [], true)).toBe(false);
});

it("test_partial_review_retries_only_the_unanswered_original_fact", async () => {
  const raw = complete();
  const last = raw.checks.at(-1);
  if (last === undefined) throw new Error("빈 검토");
  last.citations = [];
  raw.nextRoute = "browser";
  raw.answer = "";
  const verdict = await decide(raw, { evidence: RECORDS.slice(0, 2) });
  expect([verdict.status, verdict.answer, verdict.nextRoute, verdict.missing]).toEqual(["retry", "", "browser", ["find the deadline"]]);
  last.request = "submit a new application";
  expect((await decide(raw)).status).toBe("incomplete");
});

it.each(["missing", "merged", "wrong-kind", "fabricated-quote", "partial-action", "unsupported-number", "unsupported-small-number",
  "nominal-id", "unknown-route"])("test_review_does_not_publish_invalid_evidence_or_claims", async change => {
  const raw = complete();
  const [first, second, third] = raw.checks;
  if (first === undefined || second === undefined || third === undefined) throw new Error("빈 검토");
  if (change === "missing") raw.checks.pop();
  else if (change === "merged") raw.checks = [check(REQUEST, "fact", 2, RECORDS[2]?.text)];
  else if (change === "wrong-kind") first.citations = second.citations;
  else if (change === "fabricated-quote") third.citations = [{ id: 2, quote: "Applications close on May 30." }];
  else if (change === "partial-action") first.citations = [{ id: 0, quote: "Applicant name" }];
  else if (change === "unsupported-number") raw.answer += " The deadline is the 27th.";
  else if (change === "unsupported-small-number") raw.answer += " You have 3 days.";
  else if (change === "nominal-id") first.citations = [{ id: false, quote: first.citations[0]?.quote ?? "" }];
  else raw.nextRoute = "submit_form";
  const verdict = await decide(raw);
  expect(verdict.status).toBe("incomplete");
  expect(verdict.answer).toBe("");
  expect(verdict.nextRoute).toBeUndefined();
});

it("test_last_arrival_must_match_current_page_including_repeat_visits", async () => {
  const raw = complete();
  const arrival = raw.checks[1];
  const visited = RECORDS[1];
  if (arrival === undefined || visited === undefined) throw new Error("빈 검토");
  const records = [...RECORDS, reviewEvidence("page", "https://office.example/ · Welcome")];
  expect((await decide(raw, { evidence: records })).status).toBe("incomplete");
  arrival.citations.push({ id: 3, quote: "Welcome" });
  expect((await decide(raw, { evidence: records })).status).toBe("incomplete");
  arrival.citations.pop();
  // 다시 방문한 화면이 처음 봤던 화면이어도 최종 위치 확인에 쓸 수 있다.
  records.push(visited);
  arrival.citations = [{ id: 4, quote: visited.text }];
  expect((await decide(raw, { evidence: records })).status).toBe("complete");
});

it("test_requested_order_of_two_page_visits_requires_chronological_observations", async () => {
  const parts = ["Visit Eligibility", "visit Service details"];
  const request = parts.join(" then ");
  const records = [reviewEvidence("page", "Eligibility selected"), reviewEvidence("page", "Service details selected")];
  const checks = parts.map((part, index) => check(part, "visit", index, records[index]?.text));
  const raw = { checks, nextRoute: null, answer: "I visited Eligibility and then Service details." };
  expect((await decide(raw, { evidence: records, request, requirements: parts })).status).toBe("complete");
  checks[0] = check(parts[0] ?? "", "visit", 1, records[0]?.text);
  checks[1] = check(parts[1] ?? "", "visit", 0, records[1]?.text);
  const wrongOrder = await decide(raw, { evidence: records.toReversed(), request, requirements: parts });
  expect(wrongOrder.status).toBe("incomplete");
  expect(wrongOrder.repairReason).toBe("sequence");
});

it("test_receipts_require_success_permission_and_matching_id_and_never_contain_field_values", () => {
  const secret = "Marina Example";
  const fields = [field("n", { label: "Applicant name", value: secret })];
  const base = {
    researchEvidence: "I got a receipt.",
    actions: [
      action("fill", { fieldId: "n" }, { value: secret }), action("click", { name: "Rejected" }, { allowed: false }),
      action("click", { name: "Failure" }, { ok: false }), action("click", { name: "Unverified" }, { verified: false }),
      action("click", { name: "Stale" }, { resultId: "other" }),
    ],
    reviewQuotes: ["Applications close on Friday."],
  };
  const page = "https://office.example/start?token=private-link-token";
  const rows = evidenceFromDraft(draft("IDLE", "none", "I submitted everything.", { ...base, view: view(page, "Visit guide", { fields }) }));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(reviewEvidence("action", "fill Applicant name", { receiptId: "a", valueVerified: true }));
  expect(rows[1]?.text).toBe("https://office.example/start · Visit guide");
  expect(rows[1]?.kind).toBe("page");
  const sources = [source("https://office.example/visit", "Schedule")];
  const cited = evidenceFromDraft(draft("IDLE", "none", "I submitted everything.", { ...base, sources, view: view(page, "Visit guide", { fields }) }));
  expect(cited.at(-1)).toEqual(reviewEvidence("fact", "Applications close on Friday.", {
    sources: ["Schedule · https://office.example/visit"], sourceUrls: ["https://office.example/visit"],
  }));
  const locked = view(page, "Visit guide", { fields: [...fields, field("p", { type: "password" })] });
  expect(evidenceFromDraft(draft("IDLE", "none", "I submitted everything.", { ...base, sources, view: locked })).map(row => row.kind)).not.toContain("page");
});

it("test_twice_needs_two_distinct_matching_action_receipts", async () => {
  const request = "Click Next twice.";
  const first = reviewEvidence("action", "click Next", { receiptId: "local-1" });
  const second = reviewEvidence("action", "click Next", { receiptId: "local-2" });
  const c = check(request, "action", 0, first.text);
  const raw = { checks: [c], nextRoute: null, answer: "I clicked Next 2 times." };
  expect((await decide(raw, { evidence: [first], request, requirements: [] })).status).toBe("incomplete");
  c.citations.push({ id: 1, quote: first.text });
  expect((await decide(raw, { evidence: [first, first], request, requirements: [] })).status).toBe("incomplete");
  expect((await decide(raw, { evidence: [first, second], request, requirements: [] })).status).toBe("complete");
});

it("test_actions_in_a_sequence_cannot_consume_an_old_receipt_twice_or_out_of_order", async () => {
  const request = "Click Next and click Next.";
  const cite = (id: number) => [{ id, quote: "click Next" }];
  const c1 = check("Click Next", "action", 0, "click Next"), c2 = check("click Next", "action", 0, "click Next");
  const raw = { checks: [c1, c2], nextRoute: null, answer: "I clicked both times." };
  const records = [1, 2].map(i => reviewEvidence("action", "click Next", { receiptId: `local-${i}` }));
  expect((await decide(raw, { evidence: records, request, requirements: [] })).status).toBe("incomplete");
  c1.citations = cite(1);
  expect((await decide(raw, { evidence: records, request, requirements: [] })).status).toBe("incomplete");
  c1.citations = cite(0);
  c2.citations = cite(1);
  expect((await decide(raw, { evidence: records, request, requirements: [] })).status).toBe("complete");
});

it("test_private_values_are_omitted_from_the_request_requirements_and_evidence", async () => {
  const model = new FakeLlm();
  const secret = "Name With Private Address";
  const request = `Fill name ${secret} on https://office.example/start?token=private-link-token`;
  await reviewBeforeOutput(model, request, [reviewEvidence("page", request)], idle(), { requirements: [request], privateValues: [secret] });
  const payload = model.calls[0]?.user ?? "";
  expect(payload).not.toContain(secret);
  expect(payload).not.toContain("private-link-token");
  expect(z.object({ requirements: z.array(z.string()).nonempty() }).parse(JSON.parse(payload)).requirements).toHaveLength(1);
});

it("test_only_the_verified_public_office_phone_can_be_spoken", async () => {
  const office = "02-1234-5678", personal = "010-1234-5678";
  const rows = evidenceFromDraft(draft("IDLE", "find-place", "", {
    sources: [source("https://www.data.go.kr/data/records/fileData.do", "기관 연락처", office)], reviewQuotes: [office, personal],
  }));
  expect(rows.map(row => row.text)).toEqual([office]);
  const request = "What is the official contact number?";
  const raw = { checks: [check(request, "fact", 0, office)], nextRoute: null, answer: office };
  expect((await decide(raw, { evidence: rows, request, requirements: [] })).answer).toBe(office);
});

it("test_each_quote_in_a_comparison_keeps_its_own_verified_source", () => {
  const urls = ["https://office.example/east", "https://office.example/west"];
  const quotes = ["East opens Monday.", "West opens Tuesday."];
  const compared = { sources: urls.map(url => source(url)), reviewQuotes: quotes };
  const reviewQuoteSources = Object.fromEntries(quotes.map((quote, i) => [quote, [urls[i] ?? ""]]));
  expect(evidenceFromDraft(draft("IDLE", "web-answer", "", { ...compared, reviewQuoteSources })).map(row => [row.text, row.sources]))
    .toEqual(quotes.map((quote, i) => [quote, [urls[i]]]));
  expect(evidenceFromDraft(draft("IDLE", "web-answer", "", compared))).toEqual([]);
});

it("test_page_visits_and_displayed_tab_contents_follow_actual_clicks", async () => {
  const original = "https://office.example/details?record=summer";
  const tab: InteractiveItem = { ref: "r1-aa", role: "tab", name: "Documents", region: "main", disabled: false, selected: true };
  const seen = view(original, "Details", { items: [tab] });
  const records = evidenceFromDraft(draft("BROWSING", "goal", "", {
    actions: [action("click", { name: "Documents" })],
    reviewPages: [
      { url: "https://office.example/home", urlKey: "home", title: "Agency", afterActionId: "", headings: [], selected: [], text: "Welcome" },
      { url: "https://office.example/details", urlKey: "details", title: "Details", afterActionId: "a", headings: [],
        selected: ["Documents"], text: "Bring a signed copy of the application." },
    ],
    view: seen,
  }));
  expect(records.map(row => row.kind)).toEqual(["page", "fact", "action", "page", "fact", "page"]);
  expect(records[3]?.text).toContain("Documents");
  expect(records[4]?.text).toContain("signed copy");
  const request = "Open Documents.";
  const opened = check(request, "arrival", 5, "Documents");
  opened.citations.push({ id: 2, quote: "click Documents" });
  const result = await decide({ checks: [opened], nextRoute: null, answer: "I opened Documents." }, { evidence: records, request, requirements: [] });
  expect(result.status).toBe("complete");
  expect(pageMatches(result, seen)).toBe(true);
  expect(pageMatches(result, { ...seen, url: original.replace("summer", "winter") })).toBe(false);
  expect(pageMatches(result, view(original, "Details"))).toBe(false);
  expect(JSON.stringify(result)).not.toContain("record=summer");
});

it("test_tab_visit_with_page_corroboration_and_verified_markdown_reference", async () => {
  const request = "Read the requirements and tell me the deadline.";
  const parts = ["Read the requirements", "tell me the deadline"];
  const page = "https://office.example/program/53021";
  const rows = [
    reviewEvidence("page", page + " · Help"), reviewEvidence("action", "click Requirements", { receiptId: "ui" }),
    reviewEvidence("page", page + " · Requirements selected"), reviewEvidence("fact", "Filing closes on Monday.", { sources: [page] }),
  ];
  const visit = check(parts[0] ?? "", "visit", 0, "Help");
  visit.citations.push({ id: 1, quote: "click Requirements" }, { id: 2, quote: "Requirements selected" }, { id: 3, quote: "Filing closes on Monday." });
  const fact = check(parts[1] ?? "", "fact", 3, rows[3]?.text);
  fact.citations.push({ id: 2, quote: "Requirements selected" });
  const raw = { checks: [visit, fact], nextRoute: null, answer: `On [the requirements page](${page}), filing closes on Monday.` };
  const result = await decide(raw, { evidence: rows, request, requirements: parts });
  expect(result.answer).toBe("On the requirements page, filing closes on Monday.");
  raw.answer = raw.answer.replace("53021", "99999");
  const invalid = await decide(raw, { evidence: rows, request, requirements: parts });
  expect(invalid.status).toBe("incomplete");
  expect(invalid.repairReason).toBe("answer");
});

it("test_locked_in_field_needs_exact_readback_to_emit_confirmation", () => {
  const first = action("fill", { name: "Nickname" }, { value: "private-nickname" });
  const wrong = { ...first, result: { actionId: "a", ok: true, verified: true, readValue: "different-nickname", latencyMs: 0 } };
  expect(evidenceFromDraft({ semanticAction: "fill", actions: [wrong] })).toEqual([]);
  const rows = evidenceFromDraft({ semanticAction: "fill", actions: [first] });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.valueVerified).toBe(true);
  expect(rows[0]?.text).toBe("fill Nickname");
});

it("test_stop_cancels_a_pending_review_without_returning_a_result", async () => {
  const controller = new AbortController();
  let started = () => {};
  const reached = new Promise<void>(resolve => { started = resolve; });
  const held: StructuredLlm = { name: "held", generate: () => { started(); return new Promise(() => {}); } };
  const pending = reviewBeforeOutput(held, REQUEST, RECORDS, controller.signal);
  await reached;
  controller.abort();
  const result = await pending;
  expect(result.status).toBe("incomplete");
  expect(result.answer).toBe("");
});

it("test_missing_provider_or_schema_failure_cannot_release_a_draft", async () => {
  const empty = await reviewBeforeOutput(undefined, REQUEST, RECORDS, idle());
  const failing: StructuredLlm = { name: "failing", generate: async () => { throw new Error("timeout"); } };
  const failed = await reviewBeforeOutput(failing, REQUEST, RECORDS, idle());
  const malformed = await decide({ answer: "All done." });
  for (const result of [empty, failed, malformed]) {
    expect(result.status).toBe("incomplete");
    expect(result.answer).toBe("");
  }
  expect([empty.repairReason, failed.repairReason, malformed.repairReason]).toEqual(["", "", "shape"]);
});

// 아래는 Python 77aad3e에서 잰 값과의 대조다(tests/fixtures/session/generate.py가 만든다).
const span = z.array(z.tuple([z.int(), z.int()]));
const table = z.object({
  systemHash: z.string(), texts: z.array(z.string()), credential: z.array(span), url: z.array(span), link: z.array(span),
  glue: z.array(z.boolean()), officePhone: z.array(z.boolean()), repetitions: z.array(z.int()), digits: z.array(z.array(z.string())),
  location: z.array(z.tuple([z.string(), z.string()])),
  safe: z.array(z.tuple([z.string(), z.array(z.string()), z.array(z.string()), z.string()])),
  coverage: z.array(z.tuple([z.string(), z.array(z.string()), z.boolean()])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/session/task-review.json", import.meta.url), "utf8")));

function spansFor(expression: RegExp, input: string) {
  const offsets = new Map([[0, 0]]);
  let units = 0;
  for (const character of input) {
    units += character.length;
    offsets.set(units, offsets.size);
  }
  return Array.from(input.matchAll(expression), match => [offsets.get(match.index), offsets.get(match.index + match[0].length)]);
}

it("검토 지시문은 Python과 같은 글이다", () => {
  expect(createHash("sha256").update(REVIEW_SYSTEM, "utf8").digest("hex")).toBe(table.systemHash);
});

it.each(["credential", "url", "link"] as const)("검토 정규식 %s의 일치 구간이 Python과 같다", name => {
  expect(table.texts.map(text => spansFor(reviewPatterns[name], text))).toEqual(table[name]);
});

it("검토의 낱말 판정이 Python과 같다", () => {
  expect(table.texts.map(text => reviewPatterns.glue.test(text))).toEqual(table.glue);
  expect(table.texts.map(text => reviewPatterns.officePhone.test(text))).toEqual(table.officePhone);
  expect(table.texts.map(repetitions)).toEqual(table.repetitions);
  expect(table.texts.map(text => text.match(reviewPatterns.digits) ?? [])).toEqual(table.digits);
  expect(table.coverage.map(([request, spans]) => [request, spans, coverage(request, spans)])).toEqual(table.coverage);
});

it("주소에서 쿼리와 계정을 빼는 규칙이 Python과 같다", () => {
  expect(table.location.map(([url]) => [url, location(url)])).toEqual(table.location);
});

it("모델에 보낼 글을 가리는 규칙이 Python과 같다", () => {
  expect(table.safe.map(([text, hidden, phones]) => [text, hidden, phones, safe(text, hidden, phones)])).toEqual(table.safe);
});
