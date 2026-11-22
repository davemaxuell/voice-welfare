import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createTestRuntime, openBrowserTranscript } from "./session-runtime.ts";

type Json = z.infer<ReturnType<typeof z.json>>;
const fields = z.record(z.string(), z.json());
const role = z.enum(["default", "goal", "web", "welfare"]);
const unstable = z.array(z.array(z.union([z.string(), z.number().int().nonnegative()]))).optional();
const outcome = {
  schemaName: z.string(), user: z.string(), systemHash: z.string().regex(/^[0-9a-f]{64}$/u),
};
const modelCall = z.union([
  z.object({ ...outcome, reply: z.object({ value: z.json().optional() }) }),
  z.object({ ...outcome, error: z.object({ name: z.string(), message: z.string() }) }),
]);
export const fixtureIndex = z.object({
  cases: z.array(z.object({
    case: z.string(), file: z.string().regex(/^[\w.-]+\.jsonl$/u),
    slice: z.enum(["PR8a", "PR8b", "PR8c", "PR8d"]), turns: z.number().int().positive(), excluded: z.string().optional(),
  })).nonempty(),
  exclusions: z.record(z.string(), z.string()),
});
const header = z.object({
  kind: z.literal("session"), case: z.string(), calendarDay: z.iso.date(), initialPersonal: fields,
  actionLogEnabled: z.boolean(),
  config: z.object({
    mockSiteUrl: z.url(), searchUrlTemplate: z.string(), requireConsent: z.boolean(),
    practiceMode: z.boolean(), readOnlyClicks: z.enum(["safe", "any"]), readOnlyWeb: z.boolean(),
  }),
});
const command = z.discriminatedUnion("method", [
  z.object({ method: z.literal("handle_turn"), args: z.tuple([z.string()]) }),
  z.object({ method: z.literal("confirm"), args: z.tuple([z.boolean()]) }),
  z.object({ method: z.literal("consent_to"), args: z.tuple([z.boolean()]) }),
  z.object({ method: z.literal("cancel"), args: z.tuple([]) }),
  z.object({ method: z.literal("set_language"), args: z.tuple([z.enum(["ko", "en", "zh", "ja"])]) }),
]);
const turn = z.object({
  kind: z.literal("turn"), call: command, roles: z.array(role), llm: z.array(modelCall),
  result: fields, slots: fields, personal: fields, actionLog: z.array(fields), unstable,
});

type Header = z.infer<typeof header>;
type Turn = z.infer<typeof turn>;
type IndexEntry = z.infer<typeof fixtureIndex>["cases"][number];
type Generate = (request: { schemaName: string; system: string; user: string }) => Json | undefined;

export interface TranscriptSession {
  bindModels(roles: Turn["roles"], generate: Generate): void;
  dispatch(call: Turn["call"]): Promise<unknown>;
  inspect(): { slots: unknown; personal: unknown; actionLog: unknown };
  close(): Promise<void>;
}
export type OpenTranscript = (options: Header) => Promise<TranscriptSession>;
const runtime = createTestRuntime({ browserDriver: "playwright" });
export const openRecordedSession = openBrowserTranscript(runtime);
export const closeTranscriptRuntime = runtime.close;

const publicTaskPrompt = "107a4430968baaa5a5663b5cfdda43a4a7a5ebf3e824d35cefaf0c9cbd8c4476";
// 원본 녹취에 쓰인 프롬프트만 새 해시로 옮긴다. 실제 호출의 프롬프트와 입력은 그대로 대조한다.
const promptRevisions = new Map([
  ["public_service_decision/22a52d57ec64dd88f4e0a766ac2e27544d66000b9d8d5de14575c47c23251d49", publicTaskPrompt],
  ["intent_plan/9988af5abe511f8995bb8c6bdd6ff2832a29c43c1e7752c5ae409301841ce207", "c50b20405167e18184eec4bba70d1d5b87f7ed362ec28fa208d0f7b2c90949a8"],
  ["chat_route/33f0972df08b71633d280e6cfec6e5b0105249faa7c431a2fa43210482b59647", "890f6da26354d9df3ddd113fc7ac96dcaf2a32c4a8323a92ae53a6d927e647e3"],
  ["chat_route/616694c49fa03cfe3a0afa238faceca5222cbee32f5626a93767b2c4077e7264", "7627c213c843b0bfcda12796c98873db0fd9e08a3a44db9256d2154e21338155"],
  ["browse_step/fcf351d87bcaabed87b5c73022947c1122b30946651164ce4b282e8cec5da833", "46e129981870f3a11c672d952a841b4b42c2e7bf8846c2fda748e01cac6e15e9"],
]);
const conversationCase = "tests/e2e/test_conversation.py::";
// 기존 답을 재생하기 전에 일반 탐색 명령을 해석하는 공공업무 모델 호출이 한 번 추가된다.
const browserIntakeTurns = new Map([
  ["probe/understanding_llm", 9],
  [conversationCase + "test_brief_screen_vs_detailed", 2],
  [conversationCase + "test_planner_understands_what_rules_miss[FOLLOW_LINK]", 4],
  [conversationCase + "test_planner_understands_what_rules_miss[LIST_LINKS]", 4],
  [conversationCase + "test_planner_understands_what_rules_miss[READ_MAIN]", 4],
  [conversationCase + "test_planner_understands_what_rules_miss[REPHRASE]", 4],
  [conversationCase + "test_rephrase_that_changes_a_number_repeats_the_original", 2],
  [conversationCase + "test_summary_with_unknown_number_dropped", 2],
]);

// 녹취의 외부 포털 주소는 실행·복구 검증에 그대로 두고, 모델 요청의 해당 필드만 출처로 옮긴다.
const recordedPortal = "http://127.0.0.1:5174";
function recordedModelUrls(value: Json): Json {
  if (typeof value === "string") return value.replace(/(?:http:\/\/)?127\.0\.0\.1:5174\/[A-Za-z0-9._~/?=&%#-]*/gu, recordedPortal);
  if (Array.isArray(value)) return value.map(recordedModelUrls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, recordedModelUrls(field)]));
}

function migrateRecordedModelUrls(call: Turn["llm"][number], hasSuppliedPage: boolean) {
  if (!call.user.includes("127.0.0.1:5174/")) return;
  if (call.schemaName === "translate_in" || call.schemaName === "translate_out" || call.schemaName === "simple") {
    call.user = String(recordedModelUrls(call.user));
    return;
  }
  const inputs = fields.parse(JSON.parse(call.user));
  if ((call.schemaName === "browse_step" || call.schemaName === "public_browse_step") && hasSuppliedPage) {
    call.user = JSON.stringify(recordedModelUrls(inputs));
    return;
  }
  const scoped = call.schemaName === "public_service_decision" && typeof inputs.utterance === "string" && inputs.utterance.includes("127.0.0.1:5174/");
  for (const name of ["utterance", "recent", "lastAssistant", "previousInputs", "savedNotes"]) {
    if (inputs[name] !== undefined) inputs[name] = recordedModelUrls(inputs[name]);
  }
  if (scoped) {
    assert.equal(call.systemHash, publicTaskPrompt);
    call.systemHash = "d662b20d708181f2827c5c812dc857236722666897647d92fa37bde5242e8358";
    call.user = JSON.stringify(Object.fromEntries(Object.entries(inputs).flatMap(([key, value]) => key === "task" ?
      [[key, value], ["suppliedPage", {origin: recordedPortal}]] : [[key, value]])));
  } else call.user = JSON.stringify(inputs);
}

export function loadTranscript(base: URL, entry: IndexEntry) {
  const rows = readFileSync(new URL(entry.file, base), "utf8").trimEnd().split("\n");
  const [first, ...rest] = rows;
  assert(first !== undefined, `missing session header in ${entry.file}`);
  const session = header.parse(JSON.parse(first));
  assert.equal(session.case, entry.case);
  assert.equal(rest.length, entry.turns);
  const turns = rest.map(line => turn.parse(JSON.parse(line)));
  // 과거 녹취의 화면 이동 안내는 누른 링크를 먼저 읽었다. 이동이 확인된 경우 원래 페이지 소개만 기대한다.
  let lastUrl: string | undefined;
  for (const row of turns) {
    const observation = z.object({url: z.string()}).safeParse(row.result.observation);
    const click = z.array(z.object({action: z.object({type: z.string(), target: z.object({name: z.string()}).optional()}),
      result: z.object({ok: z.boolean(), verified: z.boolean()}).optional()})).safeParse(row.result.actions);
    if (observation.success && lastUrl !== undefined && observation.data.url !== lastUrl && row.result.intentType === "FOLLOW_LINK" &&
        typeof row.result.speech === "string" && click.success) {
      const followed = click.data.find(a => a.action.type === "click" && a.result?.ok === true && a.result.verified);
      if (followed?.action.target !== undefined) {
        const receipt = `'${followed.action.target.name}' 링크를 열었습니다. `;
        assert(row.result.speech.startsWith(receipt), "기존 녹취의 이동 확인 문장");
        row.result.speech = row.result.speech.slice(receipt.length);
      }
    }
    if (observation.success) lastUrl = observation.data.url;
    for (const call of row.llm) {
      call.systemHash = promptRevisions.get(`${call.schemaName}/${call.systemHash}`) ?? call.systemHash;
      if (call.schemaName !== "chat_route" || !("reply" in call)) continue;
      const previous = call.reply.value;
      if (typeof previous === "object" && previous !== null && !Array.isArray(previous) && previous.route === "web_search" && typeof previous.searchQuery === "string") {
        const {searchQuery, ...reply} = previous;
        call.reply.value = {...reply, keywords: searchQuery.split(" ")};
      }
    }
    // 보관함 요청은 동의 대기나 중단 상태에서 거절할 때도 로컬에서만 읽는다.
    if ((row.result.state === "AWAITING_CONSENT" || row.result.state === "STOPPED") &&
        typeof row.result.intentType === "string" && row.result.intentType.startsWith("PERSONAL_VAULT_")) {
      row.result.localSpeechOnly = true;
    }
  }
  // 끝난 본문을 두 번 다시 읽던 녹취에서는 첫 실패 뒤 곧바로 링크를 확인한다.
  if (entry.case === "tests/e2e/test_autopilot.py::test_stops_when_looping") {
    const row = turns.at(-1);
    assert(row?.llm[5]?.schemaName === "browse_step" && row.llm.length === 7);
    row.llm.splice(5, 1);
    const last = row.llm.at(-1)!;
    const payload = z.object({history: z.array(z.string())}).passthrough().parse(JSON.parse(last.user));
    assert(payload.history[2]?.startsWith("3. read_more") === true && payload.history[3]?.startsWith("4. find_links") === true);
    const history = payload.history;
    const ordered = fields.parse(JSON.parse(last.user));
    ordered.history = [...history.slice(0, 2), history[3]!.replace("4. find_links", "3. find_links")];
    last.user = JSON.stringify(ordered);
    const trace = z.array(fields).parse(row.result.trace);
    assert.equal(trace[15]?.note, "자율 3: read_more ✗ 본문 끝이라 더 읽을 부분이 없음 → find로 낱말을 찾거나 답할 것");
    trace.splice(14, 2);
    for (const line of trace.slice(14)) if (typeof line.note === "string") line.note = line.note.replace("자율 4", "자율 3").replace("자율 5", "자율 4");
    row.result.trace = trace;
  }
  const intakeTurn = browserIntakeTurns.get(entry.case);
  if (intakeTurn !== undefined) {
    const row = turns[intakeTurn - 1];
    assert(row?.call.method === "handle_turn", `missing browser intake in ${entry.file} turn ${intakeTurn}`);
    row.llm.unshift({
      schemaName: "public_service_decision", systemHash: publicTaskPrompt, reply: {},
      user: JSON.stringify({
        utterance: row.call.args[0], replyLanguage: "ko", voice: false, koreaDate: session.calendarDay,
        task: { agency: null, subject: "", goal: "", requestedFacts: [], exclusions: [], pendingQuestion: "", choices: [], searchMode: null },
        selectedChoice: null, recent: [],
      }),
    });
    const trace = z.array(fields).parse(row.result.trace);
    trace.splice(1, 0, { agent: "orchestrator", phase: "PLANNING", note: "공공업무 결정" });
    row.result.trace = trace;
  }
  let hasSuppliedPage = false;
  for (const row of turns) {
    if (row.call.method === "handle_turn" && row.call.args[0].includes("127.0.0.1:5174/")) hasSuppliedPage = true;
    for (const call of row.llm) migrateRecordedModelUrls(call, hasSuppliedPage);
  }
  return { session, turns };
}

class Normalizer {
  ids = new Map<string, string>();
  refs = new Map<string, string>();

  ordinal(value: string, domain: Map<string, string>, prefix: string) {
    let alias = domain.get(value);
    if (alias === undefined) {
      alias = prefix + String(domain.size + 1);
      domain.set(value, alias);
    }
    return alias;
  }

  clean(value: unknown, key = ""): Json {
    if (key === "reply") return z.json().parse(value);
    if (typeof value === "string") {
      if (key === "id" && /^\d{13}$/u.test(value)) return this.ordinal(value, this.ids, "$id");
      return value.replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/giu, id => this.ordinal(id, this.ids, "$id"))
        .replace(/\b(?:r\d+|cheongeum-\d+)-[a-z0-9]{4}\b/gu, ref => this.ordinal(ref, this.refs, "$ref"))
        .replace(/MOCK-\d{8}-\d{4}/gu, "$receipt");
    }
    if (Array.isArray(value)) {
      const items = value.map(item => this.clean(item));
      if (key !== "trace") return items;
      return items.filter((item, i) => i === 0 || item === null || typeof item !== "object" ||
        Array.isArray(item) || item.phase !== "OBSERVING" || JSON.stringify(item) !== JSON.stringify(items[i - 1]));
    }
    if (value === null || typeof value !== "object") return z.json().parse(value);
    const fields = z.record(z.string(), z.unknown()).parse(value);
    const result: Record<string, Json> = {};
    for (const k of Object.keys(fields).sort((a, b) => a === b ? 0 : a < b ? -1 : 1)) {
      const v = fields[k];
      if (v !== null && v !== undefined && k !== "latencyMs" && k !== "atMs") result[k] = this.clean(v, k);
    }
    return result;
  }
}

function mask(root: Json, path: readonly (number | string)[]) {
  let node: Json | undefined = root;
  for (const [depth, part] of path.entries()) {
    const last = depth + 1 === path.length;
    if (Array.isArray(node) && typeof part === "number") {
      if (last) node[part] = null;
      node = node[part];
    } else if (node !== null && node !== undefined && typeof node === "object" && !Array.isArray(node) && typeof part === "string") {
      if (last) delete node[part];
      node = node[part];
    } else {
      return;
    }
  }
}

export async function replayTranscript(tape: { session: Header; turns: Turn[] }, open: OpenTranscript) {
  const session = await open(tape.session);
  const normal = new Normalizer();
  try {
    assert.deepEqual(normal.clean(session.inspect().personal), tape.session.initialPersonal,
      `${tape.session.case} initial personal store`);
    for (const [index, row] of tape.turns.entries()) {
      const actualCalls: Turn["llm"] = [];
      let consumed = 0;
      let extraCall = false;
      session.bindModels(row.roles, request => {
        const recorded = row.llm[consumed++];
        if (recorded === undefined) {
          extraCall = true;
          throw Error(`unexpected model call ${request.schemaName}`);
        }
        const meta = { schemaName: request.schemaName, user: request.user,
          systemHash: createHash("sha256").update(request.system, "utf8").digest("hex") };
        if ("error" in recorded) {
          actualCalls.push({ ...meta, error: recorded.error });
          const fault = new Error(recorded.error.message);
          fault.name = recorded.error.name;
          throw fault;
        }
        actualCalls.push({ ...meta, reply: recorded.reply });
        return recorded.reply.value;
      });
      const result = await session.dispatch(row.call);
      assert.equal(extraCall, false, "unexpected model call");
      assert.equal(consumed, row.llm.length, "missing model call");
      const { unstable: ignored = [], ...expectedRow } = row;
      const actual = normal.clean({
        kind: "turn", call: row.call, roles: row.roles, result,
        llm: actualCalls, ...session.inspect(),
      });
      const expected = z.json().parse(expectedRow);
      for (const path of ignored) {
        mask(actual, path);
        mask(expected, path);
      }
      assert.deepEqual(actual, expected, `${tape.session.case} turn ${index + 1}`);
    }
  } finally {
    await session.close();
  }
}
