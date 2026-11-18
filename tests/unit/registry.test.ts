import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { HELP_GROUPS, INTENTS, INTENT_TYPES, helpPages, parseIntent, type HelpGroup, type Intent } from "../../src/core/intents.ts";
import { SESSION_STATES, type SessionState } from "../../src/core/turn.ts";
import { INTENT_JSON_SCHEMA, LLM_INTENT_TYPES, flatToIntent, systemPrompt } from "../../src/understanding/llm_planner.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { practiceVocabulary } from "./understanding-rules-regex.ts";

const rules = new RuleBasedIntentProvider(practiceVocabulary);
const examples = INTENTS.flatMap(spec => spec.examples.map(example => ({ type: spec.type, ...example })));
const spoken = INTENTS.filter(spec => spec.help !== undefined).map(spec => ({ type: spec.type, text: spec.examples[0].text }));
const schema = INTENT_JSON_SCHEMA.schema;
const beforeConsent = new Set(INTENTS.filter(spec => spec.beforeConsent).map(spec => spec.type));
function parse(text: string, state: SessionState = "IDLE") { return rules.parseSync(text, { state }); }

it("test_one_row_per_type_with_two_examples", () => {
  expect(INTENTS).toHaveLength(37);
  expect(new Set(INTENT_TYPES).size).toBe(37);
  for (const spec of INTENTS) {
    expect(spec.examples.length).toBeGreaterThanOrEqual(2);
    if (spec.help !== undefined) expect(HELP_GROUPS).toContain(spec.help);
    for (const example of spec.examples) expect(SESSION_STATES).toContain(example.state);
  }
});

it.each(examples)("test_example_is_understood_by_rules", ({ type, text, state }) => {
  expect(parse(text, state).type, text).toBe(type);
});

it.each(spoken)("test_help_example_is_understood_on_any_screen", ({ type, text }) => {
  for (const state of ["IDLE", "BROWSING", "APPLICATION_OPEN"] as const) expect(parse(text, state).type, text).toBe(type);
});

it("test_fill_examples_name_practice_fields", () => {
  for (const example of examples.filter(x => x.type === "FILL")) {
    const result = parse(example.text, example.state);
    if (result.type !== "FILL") throw Error(example.text);
    for (const f of result.fills) expect(practiceVocabulary).toContain(f.fieldMention);
  }
});

it("test_derived_lists_follow_the_table", () => {
  expect(INTENT_TYPES).toEqual(INTENTS.map(spec => spec.type));
  expect(new Set(LLM_INTENT_TYPES)).toEqual(new Set(INTENT_TYPES.filter(kind => !["APPROVE", "STOP", "PROGRESS"].includes(kind))));
  expect(schema.properties.type.enum).toEqual(LLM_INTENT_TYPES);
  expect(beforeConsent).toEqual(new Set(["POLICY_QUESTION", "HELP_HUMAN", "STOP", "PROGRESS", "DISCOVER", "SERVICE_DETAIL",
    "PRECHECK", "PREPARE_APPLY", "WHAT_CAN_I_SAY"]));
});

it("test_planner_prompt_describes_exactly_the_llm_types", () => {
  const prompt = systemPrompt(practiceVocabulary);
  for (const spec of INTENTS) expect(prompt.includes(`- ${spec.type}: ${spec.describe}`)).toBe(spec.llm);
});

// PR8에서 실제 세션의 라우팅 표와 대조한다.
it("test_every_type_except_unknown_is_routed", () => {
  const path = new URL("../../src/orchestrator/session.ts", import.meta.url);
  const source = ts.createSourceFile("session.ts", readFileSync(path, "utf8"), ts.ScriptTarget.Latest);
  const routes = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isSwitchStatement(node) && node.expression.getText(source) === "intent.type") {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) routes.add(clause.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(routes).toEqual(new Set(INTENTS.map(spec => spec.type)));
});

const topicParams = new Set(["topic", "goal", "target", "name", "query", "service"]);
function flat(intent: Intent): Record<string, unknown> {
  const row: Record<string, unknown> = Object.fromEntries(schema.required.map(key => [key, null]));
  for (const [key, value] of Object.entries(intent)) row[topicParams.has(key) ? "topic" : key] = value;
  return row;
}

it.each(examples.filter(x => LLM_INTENT_TYPES.includes(x.type)))("test_planner_can_express_every_llm_type", ({ type, text, state }) => {
  const ruled = parse(text, state);
  const row = flat(ruled);
  expect(new Set(Object.keys(row))).toEqual(new Set(Object.keys(schema.properties)));
  for (const key of schema.required) {
    const value = row[key];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const allowed = schema.properties[key].type;
    expect(Array.isArray(allowed) ? allowed : [allowed]).toContain(actual);
  }
  if (ruled.type === "FILL") for (const f of ruled.fills) expect(new Set(Object.keys(f))).toEqual(new Set(["fieldMention", "value"]));
  expect(schema.properties.type.enum).toContain(type);
  expect(parseIntent(ruled)).toEqual(ruled);
  expect(flatToIntent(row, text)).toEqual(ruled);
});

it.each(["APPROVE", "STOP", "PROGRESS"])("test_planner_cannot_approve_stop_or_report_progress", type => {
  expect(schema.properties.type.enum).not.toContain(type);
  expect(flatToIntent({ ...flat({ type: "STOP" }), type }, "응")).toBeUndefined();
});

it("test_planner_more_and_site_slots", () => {
  const base = flat({ type: "STOP" });
  expect(flatToIntent({ ...base, type: "READ_MAIN" }, "더")).toEqual({ type: "READ_MAIN", more: false });
  expect(flatToIntent({ ...base, type: "LIST_LINKS", more: true }, "더")).toEqual({ type: "LIST_LINKS", more: true });
  expect(flatToIntent({ ...base, type: "SEARCH", topic: "기초연금", site: "복지로" }, "x"))
    .toEqual({ type: "SEARCH", query: "기초연금", site: "복지로" });
  expect(flatToIntent({ ...base, type: "FOLLOW_LINK" }, "가자")).toBeUndefined();
  expect(flatToIntent({ ...base, type: "SEARCH" }, "찾아")).toBeUndefined();
});

it("test_help_pages_read_every_example_once", () => {
  const leads: HelpGroup[][] = [["신청서"], ["웹 읽기"], ["시작", "복지 정보"]];
  for (const lead of leads) {
    const pages = helpPages(lead, true);
    const said = pages.flatMap(page => page.flatMap(([, texts]) => texts));
    expect(said.toSorted((a, b) => a.localeCompare(b))).toEqual(spoken.map(x => x.text).toSorted((a, b) => a.localeCompare(b)));
    for (const page of pages) {
      expect(page.length).toBeGreaterThan(0);
      expect(page.length).toBeLessThanOrEqual(3);
      expect(new Set(page.map(([group]) => group)).size).toBe(page.length);
      for (const [, texts] of page) expect([1, 2]).toContain(texts.length);
    }
  }
});

it("test_screen_group_leads_every_page_until_it_runs_out", () => {
  const pages = helpPages(["신청서"], true);
  const formPages = pages.filter(page => page.some(([group]) => group === "신청서"));
  expect(pages.slice(0, formPages.length)).toEqual(formPages);
  for (const page of formPages) expect(page[0]?.[0]).toBe("신청서");
});

it("test_help_before_consent_reads_only_what_runs_before_consent", () => {
  const said = helpPages(["시작", "복지 정보"], false).flatMap(page => page.flatMap(([, texts]) => texts));
  expect(said.length).toBeGreaterThan(0);
  for (const text of said) expect(beforeConsent.has(parse(text).type)).toBe(true);
});

it.each([["뭐라고 말하면 돼?", false], ["다른 말도 알려줘", true], ["도움말", false]] as const)(
  "test_phrases_the_help_tells_you_to_say", (text, more) => {
    expect(parse(text, "APPLICATION_OPEN")).toEqual({ type: "WHAT_CAN_I_SAY", more });
  },
);
