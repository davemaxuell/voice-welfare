import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { DialogueState } from "../../src/core/dialogue.ts";
import { SessionStateSchema } from "../../src/core/turn.ts";
import {
  GuardianDialogue, MESSAGE, PreviewSender, SolapiSender, guardianCommand, guardianSender, screenDigest,
  type Delivery, type GuardianSender,
} from "../../src/personal/guardian.ts";
import { PersonalStore } from "../../src/personal/store.ts";
import { fakeFetch } from "../helpers.ts";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "cheongeum-guardian-")); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllGlobals(); });

it("test_guardian_does_not_replace_user_phone_and_is_cleared_with_vault", () => {
  const path = join(directory, "vault.json");
  const store = new PersonalStore(path);
  const contact = { name: "홍길동", phone: "01011223344" };
  store.saveVault({ phone: "01022334455" });
  store.setGuardian(contact);
  const restored = new PersonalStore(path);
  expect(restored.guardian()).toEqual(contact);
  expect(restored.vault()).toEqual({ phone: "01022334455" });
  restored.clearVault();
  expect(new PersonalStore(path).guardian()).toBeUndefined();
});

it("test_explicit_sender_and_exact_request", () => {
  expect(guardianSender({ SOLAPI_API_KEY: "key" })).toBeInstanceOf(PreviewSender);
  expect(guardianSender({ GUARDIAN_SMS_PROVIDER: "solapi" })).toBeUndefined();
  expect(guardianCommand("보호자 김하늘 전화번호 010123456789 등록해줘")).toEqual({ kind: "guardian-help" });
  expect(guardianCommand("보호자한테 연락하지 마")).toBeUndefined();
  expect(guardianCommand("보호자 이름은 이진희이고 전화번호는 010-1122-3344 등록해줘")).toEqual({
    kind: "guardian-save", contact: { name: "이진희", phone: "01011223344" },
  });
});

function parseAuth(header: string | null): Record<string, string> {
  const pairs = (header ?? "").replace(/^HMAC-SHA256 /u, "").split(", ").map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const);
  return Object.fromEntries(pairs);
}
const solapi = () => guardianSender({
  GUARDIAN_SMS_PROVIDER: "solapi", SOLAPI_API_KEY: "key", SOLAPI_API_SECRET: "secret", SOLAPI_SENDER_NUMBER: "02-1234-5678",
});

it.each([
  [200, { failedMessageList: [], groupInfo: { count: { registeredSuccess: 1 } } }, "accepted"],
  [200, { failedMessageList: [{ statusCode: "3040" }] }, "failed"],
  [403, {}, "failed"], [500, {}, "unknown"], [200, {}, "unknown"],
] as const)("test_solapi_single_request_and_acceptance", async (status, body, expected) => {
  const fetcher = fakeFetch(() => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetcher);
  const sender = solapi();
  expect(await sender?.send("01012345678", MESSAGE)).toBe(expected);
  expect(fetcher.calls).toHaveLength(1);
  const request = fetcher.calls[0];
  expect(request?.url).toBe("https://api.solapi.com/messages/v4/send-many/detail");
  expect(request?.method).toBe("POST");
  expect(request?.redirect).toBe("manual");
  const auth = parseAuth(request?.headers.get("authorization") ?? null);
  expect(auth.apiKey).toBe("key");
  expect(auth.signature).toBe(createHmac("sha256", "secret").update(`${auth.date}${auth.salt}`).digest("hex"));
  expect(await request?.json()).toEqual({ messages: [{ from: "0212345678", to: "01012345678", text: MESSAGE, type: "SMS" }] });
});

it("접수 응답을 읽을 수 없거나 연결이 끊기면 보냈는지 모른다고 한다", async () => {
  const accepted = { failedMessageList: [], groupInfo: { count: { registeredSuccess: 1 } } };
  const answers: [Response | Error, Delivery][] = [
    [new Response("not json", { status: 200 }), "unknown"], [new Response("", { status: 200 }), "unknown"], [new Response("null", { status: 200 }), "unknown"],
    [new Response("[]", { status: 200 }), "unknown"], [Response.json({ failedMessageList: null }), "unknown"],
    [Response.json({ failedMessageList: [], groupInfo: null }), "unknown"], [Response.json({ failedMessageList: [], groupInfo: { count: {} } }), "unknown"],
    [Response.json({ failedMessageList: [], groupInfo: { count: { registeredSuccess: 0 } } }), "unknown"],
    [Response.json({ failedMessageList: [], groupInfo: { count: { registeredSuccess: 2 } } }), "unknown"],
    [Response.json({ failedMessageList: [], groupInfo: { count: { registeredSuccess: "1" } } }), "unknown"],
    [Response.json({ failedMessageList: [], groupInfo: { count: { registeredSuccess: true } } }), "accepted"],
    [Response.json({ failedMessageList: [], groupInfo: { count: { registeredSuccess: 1.0 } } }), "accepted"],
    [Response.json({ failedMessageList: {}, groupInfo: { count: { registeredSuccess: 1 } } }), "accepted"],
    [Response.json({ failedMessageList: "", groupInfo: { count: { registeredSuccess: 1 } } }), "accepted"],
    [Response.json({ failedMessageList: 0, groupInfo: { count: { registeredSuccess: 1 } } }), "accepted"],
    [Response.json({ failedMessageList: "x" }), "failed"], [Response.json({ failedMessageList: 1 }), "failed"], [Response.json({ failedMessageList: { a: 1 } }), "failed"],
    [Response.json(accepted, { status: 302, headers: { location: "https://example.invalid/" } }), "unknown"],
    [new Response(null, { status: 204 }), "unknown"],
    [new Error("socket hang up"), "unknown"],
  ];
  for (const [answer, expected] of answers) {
    const fetcher = fakeFetch(() => { if (answer instanceof Error) throw answer; return answer.clone(); });
    vi.stubGlobal("fetch", fetcher);
    expect(await solapi()?.send("01012345678", MESSAGE), answer instanceof Error ? answer.message : `${answer.status}`).toBe(expected);
    expect(fetcher.calls).toHaveLength(1);
  }
});

it("보낸 문자 내용과 비밀은 발송기를 출력해도 드러나지 않는다", () => {
  const sender = new SolapiSender("api-key-value", "secret-value", "0212345678");
  const printed = [JSON.stringify(sender), String(sender), JSON.stringify(Object.entries(sender))].join(" ");
  expect(printed).not.toContain("api-key-value");
  expect(printed).not.toContain("secret-value");
  expect(printed).not.toContain("0212345678");
});

// 기대값은 pyref(77aad3e)의 cheongeum.personal.guardian을 같은 입력에 돌린 결과다. 만드는 법은 tests/fixtures/personal/generate.py.
const contact = z.object({ name: z.string(), phone: z.string() });
const commandResult = z.union([z.object({ kind: z.enum(["guardian-send", "guardian-clear", "guardian-help"]) }), z.object({ kind: z.literal("guardian-save"), contact })]);
const view = z.record(z.string(), z.unknown());
const question = z.union([
  z.object({ kind: z.literal("guardian-help") }), z.object({ kind: z.enum(["guardian-save", "guardian-clear", "guardian-send"]), contact: contact.optional() }),
]);
const pending = z.union([
  z.object({ kind: z.enum(["guardian-save", "guardian-clear"]), contact, at: z.number(), resume: SessionStateSchema }),
  z.object({ kind: z.literal("guardian-send"), contact, at: z.number(), resume: SessionStateSchema, message: z.string(), screen: z.string() }),
]);
const fixture = z.object({
  commands: z.array(z.tuple([z.string(), commandResult.nullable()])),
  commandsCorpus: z.array(z.tuple([z.string(), commandResult])),
  senders: z.array(z.tuple([z.record(z.string(), z.string()), z.union([
    z.object({ kind: z.literal("preview") }),
    z.object({
      kind: z.literal("solapi"), key: z.string(), secret: z.string(), number: z.string(),
      send: z.object({ result: z.enum(["preview", "accepted", "failed", "unknown"]), calls: z.number() }),
    }),
  ]).nullable()])),
  digests: z.array(z.tuple([view, z.string()])),
  scenarios: z.array(z.object({
    name: z.string(), guardian: contact.nullable(), sender: z.enum(["none", "preview", "live"]), result: z.enum(["preview", "accepted", "failed", "unknown"]),
    steps: z.array(z.object({
      ask: question.optional(), view: view.nullable().optional(), now: z.number().optional(), resume: SessionStateSchema.optional(),
      take: z.literal(true).optional(), taken: pending.nullable().optional(),
      approve: z.object({ view, now: z.number(), ttl: z.number() }).optional(),
      setGuardian: contact.nullable().optional(), askVault: z.object({ kind: z.literal("vault-clear") }).optional(),
      draft: z.json().optional(), state: z.string(), pending: z.json(), guardian: contact.nullable(), calls: z.array(z.tuple([z.string(), z.string()])).nullable(),
    })),
  })),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/personal/guardian.json", import.meta.url), "utf8")));
const corpus = z.array(z.string()).parse(JSON.parse(readFileSync(new URL("../fixtures/regex/corpus.json", import.meta.url), "utf8")));

it("보호자 명령을 기록한 Python 답과 같게 알아본다", () => {
  expect(fixture.commands.length).toBeGreaterThan(1000);
  const different = fixture.commands.flatMap(([text, expected]) => {
    const actual = guardianCommand(text) ?? null;
    return isDeepStrictEqual(actual, expected) ? [] : [{ text, expected, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it("말뭉치에서는 Python이 답한 문장에만 보호자 명령으로 답한다", () => {
  const recorded = new Map(fixture.commandsCorpus);
  const different = corpus.flatMap(text => {
    const actual = guardianCommand(text) ?? null;
    const expected = recorded.get(text) ?? null;
    return isDeepStrictEqual(actual, expected) ? [] : [{ text, expected, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it("환경 변수로 고른 발송기가 기록한 Python과 같다", async () => {
  for (const [env, expected] of fixture.senders) {
    const sender = guardianSender(env);
    if (expected === null) { expect(sender, JSON.stringify(env)).toBeUndefined(); continue; }
    if (expected.kind === "preview") { expect(sender, JSON.stringify(env)).toBeInstanceOf(PreviewSender); continue; }
    expect(sender, JSON.stringify(env)).toBeInstanceOf(SolapiSender);
    const fetcher = fakeFetch(() => Response.json({ failedMessageList: [], groupInfo: { count: { registeredSuccess: 1 } } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await sender?.send("01012345678", "m"), JSON.stringify(env)).toBe(expected.send.result);
    expect(fetcher.calls, JSON.stringify(env)).toHaveLength(expected.send.calls);
    const request = fetcher.calls[0];
    if (request === undefined) continue;
    const auth = parseAuth(request.headers.get("authorization"));
    const body = z.object({ messages: z.array(z.object({ from: z.string() })) }).parse(await request.json());
    expect({
      key: auth.apiKey, number: body.messages[0]?.from, signed: auth.signature === createHmac("sha256", expected.secret).update(`${auth.date}${auth.salt}`).digest("hex"),
    }, JSON.stringify(env)).toEqual({ key: expected.key, number: expected.number, signed: true });
  }
});

it("화면 지문이 기록한 Python과 같다", () => {
  for (const [value, expected] of fixture.digests) expect(screenDigest(value), JSON.stringify(value)).toBe(expected);
  expect(screenDigest(undefined)).toBe(screenDigest({}));
});

/** 금고 질문에는 실행마다 다른 확인 번호(actionId)가 붙어 있어 기록과 비교하기 전에 뺀다. */
function plainPending(value: DialogueState["vaultConfirm"]) {
  if (value === undefined) return null;
  const { confirmation, ...rest } = value;
  if (confirmation === undefined) return rest;
  const { actionId: _id, ...fixed } = confirmation;
  return { ...rest, confirmation: fixed };
}

class RecordingSender implements GuardianSender {
  readonly preview: boolean;
  readonly result: Delivery;
  readonly calls: [string, string][] = [];
  constructor(preview: boolean, result: Delivery) {
    this.preview = preview;
    this.result = result;
  }
  async send(phone: string, message: string): Promise<Delivery> {
    this.calls.push([phone, message]);
    return this.result;
  }
}

it.each(fixture.scenarios.map(scenario => [scenario.name, scenario] as const))("보호자 대화 시나리오: %s", async (_name, scenario) => {
  const store = new PersonalStore(join(directory, "personal.json"));
  if (scenario.guardian !== null) store.setGuardian(scenario.guardian);
  const sender = scenario.sender === "none" ? undefined : new RecordingSender(scenario.sender === "preview", scenario.sender === "preview" ? "preview" : scenario.result);
  const state = new DialogueState("IDLE");
  const talk = new GuardianDialogue(store, state, sender);
  let taken: ReturnType<GuardianDialogue["takePending"]>;
  for (const [index, step] of scenario.steps.entries()) {
    const actual: Record<string, unknown> = {};
    if (step.ask !== undefined && step.now !== undefined && step.resume !== undefined) actual.draft = talk.ask(step.ask, step.view ?? undefined, step.now, step.resume);
    else if (step.take !== undefined) {
      taken = talk.takePending();
      actual.taken = taken ?? null;
    } else if (step.approve !== undefined) {
      if (taken === undefined) throw new Error("승인할 대기가 없습니다");
      actual.draft = await talk.approved(taken, step.approve.view, step.approve.now, step.approve.ttl);
    } else if (step.setGuardian !== undefined) store.setGuardian(step.setGuardian ?? undefined);
    else if (step.askVault !== undefined) state.askVaultConfirm(step.askVault);
    actual.state = state.state;
    actual.pending = plainPending(state.vaultConfirm);
    actual.guardian = store.guardian() ?? null;
    actual.calls = sender?.calls ?? null;
    const { ask: _ask, view: _view, now: _now, resume: _resume, take: _take, approve: _approve, setGuardian: _set, askVault: _askVault, ...expected } = step;
    expect(actual, `${scenario.name} step ${index + 1}`).toEqual(expected);
  }
});
