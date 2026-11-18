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
const runtime = createTestRuntime();
const open = openBrowserTranscript(runtime);
export const openSlice = new Map<IndexEntry["slice"], OpenTranscript>([["PR8a", open], ["PR8b", open], ["PR8c", open], ["PR8d", open]]);
export const closeTranscriptRuntime = runtime.close;

export function loadTranscript(base: URL, entry: IndexEntry) {
  const rows = readFileSync(new URL(entry.file, base), "utf8").trimEnd().split("\n");
  const [first, ...rest] = rows;
  assert(first !== undefined, `missing session header in ${entry.file}`);
  const session = header.parse(JSON.parse(first));
  assert.equal(session.case, entry.case);
  assert.equal(rest.length, entry.turns);
  return { session, turns: rest.map(line => turn.parse(JSON.parse(line))) };
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
