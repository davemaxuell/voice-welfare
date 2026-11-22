import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  FileAttachment, ModelConnections, OPENAI_BASE_URL, OpenAIStructuredLlm, OpenAIVisionLlm, REASONING_EFFORT_OVERRIDE,
  chatCompletion, createStructuredLlm, createVisionLlm, messageContent, postJson, resolveReasoningEffort, type LlmConfig,
} from "../../src/core/llm.ts";
import { MODEL_STATUS } from "../../src/core/model_status.ts";
import { MaskReport, PICTURE_SCHEMA, PICTURE_SCHEMA_NAME, Picture } from "../../src/core/picture.ts";
import { fakeFetch } from "../helpers.ts";
import { fixtureText } from "./redacted-fixture.ts";

// 사진 모델 호출: 사진은 가린 Picture 한 장만, OpenAI로만 간다. (test_vision_llm.py 가운데 core/llm.py만 쓰는 시험)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const ANSWER = { screen: "normal", description: "안내문이 보여요.", pressable: [1] };
const picture = () => Picture._sealed(PNG, { source: "web", width: 1, height: 1, masks: new MaskReport(0, 0, 0, false) });
const reply = (content: string | null, extra: Record<string, unknown> = {}) =>
  Response.json({ choices: [{ message: { content, ...extra } }] });

function vision(fetcher: ReturnType<typeof fakeFetch>, options: { detail?: string } = {}) {
  return new OpenAIVisionLlm({ model: "vision-model", baseUrl: OPENAI_BASE_URL, apiKey: "sk-test", pool: new ModelConnections(fetcher), ...options });
}

const seeArgs = () => ({ system: "설명한다", user: fixtureText("1. 닫기"), picture: picture(), schemaName: PICTURE_SCHEMA_NAME, schema: PICTURE_SCHEMA });

it("test_see_sends_one_masked_image_and_a_strict_schema", async () => {
  const fetcher = fakeFetch(() => reply(JSON.stringify(ANSWER)));
  await expect(vision(fetcher).see(seeArgs())).resolves.toEqual(ANSWER);
  expect(fetcher.calls).toHaveLength(1);
  const [request] = fetcher.calls;
  expect(request?.url).toBe("https://api.openai.com/v1/chat/completions");
  expect(request?.headers.get("authorization")).toBe("Bearer sk-test");
  const body = z.object({
    response_format: z.unknown(),
    messages: z.tuple([z.unknown(), z.object({ content: z.array(z.looseObject({ type: z.string() })) })]),
  }).parse(await request?.json());
  expect(body.response_format).toEqual({ type: "json_schema", json_schema: { name: PICTURE_SCHEMA_NAME, strict: true, schema: PICTURE_SCHEMA } });
  expect(body.messages[0]).toEqual({ role: "system", content: "설명한다" });
  const images = body.messages[1].content.filter(part => part.type === "image_url");
  expect(images).toHaveLength(1);
  const image = z.object({ image_url: z.object({ url: z.string(), detail: z.string() }) }).parse(images[0]);
  expect(image.image_url.detail).toBe("high");
  const comma = image.image_url.url.indexOf(",");
  expect(image.image_url.url.slice(0, comma)).toBe("data:image/png;base64");
  expect(Buffer.from(image.image_url.url.slice(comma + 1), "base64").equals(PNG)).toBe(true);
  expect(body.messages[1].content.filter(part => part.type !== "image_url")).toEqual([{ type: "text", text: "1. 닫기" }]);
});

it("test_detail_comes_from_config", async () => {
  const fetcher = fakeFetch(() => reply(JSON.stringify(ANSWER)));
  await vision(fetcher, { detail: "low" }).see(seeArgs());
  const body = z.object({ messages: z.tuple([z.unknown(), z.object({ content: z.tuple([z.unknown(), z.object({ image_url: z.object({ detail: z.string() }) })]) })]) })
    .parse(await fetcher.calls[0]?.json());
  expect(body.messages[1].content[1].image_url.detail).toBe("low");
});

it.each([
  [() => Response.json({ error: "boom" }, { status: 500 })],
  [() => reply(null, { refusal: "no" })],
  [() => reply("{not json")],
])("test_failed_call_returns_none", async makeResponse => {
  await expect(vision(fakeFetch(makeResponse)).see(seeArgs())).resolves.toBeUndefined();
});

it("test_see_takes_only_a_sealed_picture", async () => {
  const fetcher = fakeFetch(() => reply(JSON.stringify(ANSWER)));
  for (const notAPicture of [PNG, "data:image/png;base64,AAAA", "C:/shot.png", Object.create(Picture.prototype)]) {
    await expect(Reflect.apply(vision(fetcher).see, vision(fetcher), [{ ...seeArgs(), picture: notAPicture }])).rejects.toThrow(TypeError);
  }
  expect(fetcher.calls).toEqual([]);
});

it("test_text_model_still_sends_plain_text_and_cannot_see", async () => {
  const fetcher = fakeFetch(() => reply('{"text": "네"}'));
  const llm = new OpenAIStructuredLlm({ model: "text-model", baseUrl: "http://localhost:11434/v1", provider: "openai-compatible", pool: new ModelConnections(fetcher) });
  await expect(llm.generate({ system: "s", user: fixtureText("안녕"), schemaName: "t", schema: { type: "object" } })).resolves.toEqual({ text: "네" });
  expect(z.object({ messages: z.unknown() }).parse(await fetcher.calls[0]?.json()).messages)
    .toEqual([{ role: "system", content: "s" }, { role: "user", content: "안녕" }]);
  expect("see" in llm).toBe(false);
  expect("generate" in vision(fetcher)).toBe(false);
});

const noVision: LlmConfig[] = [
  { provider: "mock" },
  { provider: "ollama", model: "qwen2.5vl" },
  { provider: "openai-compatible", model: "qwen-vl", baseUrl: "https://example.com/v1", apiKey: "k" },
  { provider: "openai", model: undefined, apiKey: "k" },
  { provider: "openai", model: "vision-model", apiKey: undefined },
];
it.each(noVision)("test_no_vision_client_unless_openai_with_model_and_key", cfg => {
  expect(createVisionLlm(cfg)).toBeUndefined();
});

it("test_openai_builds_a_vision_client", () => {
  const llm = createVisionLlm({ provider: "OpenAI", model: "vision-model", apiKey: "k" }, { detail: "low" });
  expect(llm).toBeInstanceOf(OpenAIVisionLlm);
  expect([llm?.model, llm?.baseUrl, llm?.detail]).toEqual(["vision-model", "https://api.openai.com/v1", "low"]);
  expect(llm?.apiKey).toBe("k");
});

// 아래는 pyref(77aad3e)의 cheongeum.core.llm이 같은 설정에서 만든 것과 맞춘다. 만드는 법은 tests/fixtures/core/generate.py.
const nullable = z.string().nullable();
const part = z.record(z.string(), z.unknown());
const fixture = z.object({
  endpoints: z.array(z.tuple([nullable, nullable, nullable, nullable, z.array(z.string()).nullable(), z.array(z.string()).nullable()])),
  options: z.array(z.tuple([z.enum(["text", "vision"]), z.string(), nullable, z.number().nullable(), z.array(z.union([z.string(), z.number(), z.null()]))])),
  effort: z.array(z.tuple([z.array(z.string()).nullable(), z.string(), z.string(), nullable, nullable])),
  parts: z.array(z.tuple([z.string(), z.string(), z.string(), part])),
  recipients: z.array(z.tuple([z.string(), z.string()])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/llm.json", import.meta.url), "utf8")));
const orUndefined = <T>(value: T | null): T | undefined => value ?? undefined;

it("지원하는 공급자의 글·사진 모델은 설정마다 Python과 같은 이름·주소로 만들어진다", () => {
  expect(fixture.endpoints.length).toBeGreaterThan(200);
  const different = fixture.endpoints.flatMap(([provider, model, baseUrl, apiKey, text, sight]) => {
    const cfg: LlmConfig = { provider: orUndefined(provider), model: orUndefined(model), baseUrl: orUndefined(baseUrl), apiKey: orUndefined(apiKey) };
    const madeText = createStructuredLlm(cfg), madeVision = createVisionLlm(cfg);
    const actual = {
      text: madeText === undefined ? null : [madeText.name, madeText.baseUrl, madeText.provider],
      vision: madeVision === undefined ? null : [madeVision.name, madeVision.baseUrl, madeVision.detail],
    };
    return JSON.stringify(actual) === JSON.stringify({ text, vision: sight }) ? [] : [{ cfg, expected: { text, vision: sight }, actual }];
  });
  expect(different.slice(0, 5)).toEqual([]);
});

it("추론량과 제한 시간은 공급자·값마다 Python과 같다", () => {
  for (const [kind, provider, effort, timeout, expected] of fixture.options) {
    const cfg: LlmConfig = kind === "text"
      ? { provider, model: "m", baseUrl: "https://example.com/v1", apiKey: "k", reasoningEffort: orUndefined(effort), timeoutMs: orUndefined(timeout) }
      : { provider, model: "m", apiKey: "k", reasoningEffort: orUndefined(effort), timeoutMs: orUndefined(timeout) };
    const made = kind === "text" ? createStructuredLlm(cfg) : createVisionLlm(cfg, { detail: "low" });
    const actual = made === undefined ? undefined
      : made instanceof OpenAIVisionLlm ? [made.reasoningEffort ?? null, made.timeoutMs, made.detail] : [made.reasoningEffort ?? null, made.timeoutMs];
    expect(actual, JSON.stringify([kind, provider, effort, timeout])).toEqual(expected);
  }
});

it("위임한 턴이 정한 추론량은 모델 계열과 OpenAI 주소에만 적용된다", () => {
  expect(fixture.effort.length).toBeGreaterThan(100);
  const different = fixture.effort.flatMap(([override, model, baseUrl, fallback, expected]) => {
    const actual = override === null ? REASONING_EFFORT_OVERRIDE.run(null, () => resolveReasoningEffort(model, baseUrl, orUndefined(fallback)))
      : REASONING_EFFORT_OVERRIDE.run([override[0] ?? "", override[1] ?? ""], () => resolveReasoningEffort(model, baseUrl, orUndefined(fallback)));
    return (actual ?? null) === expected ? [] : [{ override, model, baseUrl, fallback, expected, actual }];
  });
  expect(different.slice(0, 5)).toEqual([]);
  expect(resolveReasoningEffort("gpt-6.2-sol", OPENAI_BASE_URL, "medium")).toBe("medium");
});

it("첨부 파일은 PDF면 file, 그 밖이면 image_url 조각이 된다", () => {
  for (const [name, mime, base64, expected] of fixture.parts) {
    expect(new FileAttachment(name, mime, Buffer.from(base64, "base64")).contentPart(), name).toEqual(expected);
  }
});

it("파일을 받는 곳 이름은 OpenAI이거나 설정한 서버의 호스트다", () => {
  for (const [baseUrl, expected] of fixture.recipients) {
    expect(new OpenAIStructuredLlm({ model: "m", baseUrl }).fileRecipient, baseUrl).toBe(expected);
  }
});

it("전용 Ollama 공급자는 없다: 이름이 ollama이거나 모르는 공급자면 주소·키가 있어도 모델을 만들지 않는다", () => {
  for (const provider of ["ollama", "OLLAMA", "foo", "local"]) {
    for (const extra of [{}, { baseUrl: "http://localhost:11434/v1" }, { baseUrl: "https://example.com/v1", apiKey: "k" }]) {
      expect(createStructuredLlm({ provider, model: "qwen2.5:7b", ...extra }), provider).toBeUndefined();
      expect(createVisionLlm({ provider, model: "qwen2.5:7b", ...extra }), provider).toBeUndefined();
    }
  }
});

it("로컬 서버는 키 없이도 openai-compatible과 qwen으로 쓰고, 다른 서버는 키가 있어야 한다", () => {
  const local = createStructuredLlm({ provider: "openai-compatible", model: "qwen2.5:7b", baseUrl: "http://localhost:11434/v1" });
  expect([local?.name, local?.baseUrl, local?.timeoutMs]).toEqual(["openai-compatible(qwen2.5:7b)", "http://localhost:11434/v1", 30_000]);
  expect(createStructuredLlm({ provider: "Qwen", model: "q", baseUrl: "http://127.0.0.1:8000/v1" })?.name).toBe("qwen(q)");
  expect(createStructuredLlm({ provider: "qwen", model: "q", baseUrl: "https://dashscope.example/v1" })).toBeUndefined();
  expect(createStructuredLlm({ provider: "qwen", model: "q", baseUrl: "https://dashscope.example/v1", apiKey: "k" })?.name).toBe("qwen(q)");
  expect(createStructuredLlm({ provider: "openai-compatible", model: "q" })).toBeUndefined();
  expect(createStructuredLlm({ provider: "openai", model: "m" })).toBeUndefined();
  // Python 원문 그대로: 주소 어디에나 localhost가 들어 있으면 로컬로 본다
  expect(createStructuredLlm({ provider: "qwen", model: "q", baseUrl: "http://localhost.evil.test/v1" })).toBeDefined();
});

const request = { system: "지시", user: fixtureText("입력"), schemaName: "answer", schema: { type: "object" } };
const body = async (call: Request | undefined) => z.record(z.string(), z.unknown()).parse(await call?.json());

it("모델 호출마다 횟수와 토큰 수를 센다", async () => {
  const answers = [
    Response.json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    Response.json({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1.5, completion_tokens: "3" } }),
    Response.json({ error: "boom" }, { status: 500 }),
  ];
  const llm = createStructuredLlm({ provider: "openai", model: "m", apiKey: "k" }, { pool: new ModelConnections(fakeFetch(() => answers.shift() ?? Response.error())) });
  for (let round = 0; round < 3; round++) await llm?.generate(request);
  expect(llm?.usage).toEqual({ calls: 3, inputTokens: 11, outputTokens: 7 });
});

it("추론량은 OpenAI 호출에만 실리고 위임한 턴이 한 모델 계열만 바꾼다", async () => {
  const fetcher = fakeFetch(() => reply("{}"));
  const pool = new ModelConnections(fetcher);
  const sol = createStructuredLlm({ provider: "openai", model: "gpt-6.2-sol", apiKey: "k", reasoningEffort: "low" }, { pool });
  const luna = createStructuredLlm({ provider: "openai", model: "gpt-6-luna", apiKey: "k", reasoningEffort: "none" }, { pool });
  const other = createStructuredLlm({ provider: "openai-compatible", model: "gpt-6.2-sol", baseUrl: "http://localhost:1/v1", reasoningEffort: "high" }, { pool });
  await REASONING_EFFORT_OVERRIDE.run(["gpt-6.2-sol", "medium"], async () => {
    await sol?.generate(request);
    await luna?.generate(request);
    await other?.generate(request);
  });
  await sol?.generate(request);
  const efforts = await Promise.all(fetcher.calls.map(async call => (await body(call)).reasoning_effort));
  expect(efforts).toEqual(["medium", "none", undefined, "low"]);
});

it("파일을 붙인 호출은 OpenAI에만 간다", async () => {
  const fetcher = fakeFetch(() => reply("{}"));
  const pool = new ModelConnections(fetcher);
  const attachment = new FileAttachment("document.pdf", "application/pdf", Buffer.from("%PDF"));
  const compatible = createStructuredLlm({ provider: "openai-compatible", model: "m", baseUrl: "http://localhost:1/v1" }, { pool });
  await expect(compatible?.generate({ ...request, attachment })).resolves.toBeUndefined();
  expect(fetcher.calls).toHaveLength(0);
  const openai = createStructuredLlm({ provider: "openai", model: "m", apiKey: "k" }, { pool });
  await openai?.generate({ ...request, attachment });
  const messages = z.object({ messages: z.tuple([z.unknown(), z.object({ content: z.array(z.unknown()) })]) }).parse(await body(fetcher.calls[0]));
  expect(messages.messages[1].content).toEqual([
    { type: "text", text: "입력" },
    { type: "file", file: { filename: "document.pdf", file_data: "data:application/pdf;base64,JVBERg==" } },
  ]);
});

it("연결 묶음을 닫으면 진행 중인 요청을 끊고 결과를 비운다", async () => {
  const fetcher = fakeFetch(req => new Promise((_resolve, reject) => {
    req.signal.addEventListener("abort", () => { reject(req.signal.reason); }, { once: true });
  }));
  const pool = new ModelConnections(fetcher);
  const pending = createStructuredLlm({ provider: "openai", model: "m", apiKey: "k" }, { pool })?.generate(request);
  expect(fetcher.calls).toHaveLength(1);
  await pool.close();
  await expect(pending).resolves.toBeUndefined();
  expect(fetcher.calls[0]?.signal.aborted).toBe(true);
});

it("postJson은 성공한 JSON만 돌려주고 실패·중단·시간 초과는 비운다", async () => {
  const url = "https://example.test/x";
  const ok = new ModelConnections(fakeFetch(() => Response.json({ a: 1 })));
  await expect(postJson(url, {}, { q: "한글" }, 5, undefined, ok)).resolves.toEqual({ a: 1 });
  await expect(postJson(url, {}, {}, 5, undefined, new ModelConnections(fakeFetch(() => Response.json({}, { status: 404 }))))).resolves.toBeUndefined();
  await expect(postJson(url, {}, {}, 5, undefined, new ModelConnections(fakeFetch(() => { throw new Error("offline"); })))).resolves.toBeUndefined();
  const aborted = new AbortController();
  aborted.abort();
  await expect(postJson(url, {}, {}, 5, aborted.signal, ok)).resolves.toBeUndefined();
  const slow = new ModelConnections(fakeFetch(req => new Promise((_resolve, reject) => {
    req.signal.addEventListener("abort", () => { reject(req.signal.reason); }, { once: true });
  })));
  await expect(postJson(url, {}, {}, 0.05, undefined, slow)).resolves.toBeUndefined();
});

it("모델 답에서 글을 꺼낼 때 비었거나 거절한 답은 버린다", () => {
  const wrap = (message: unknown) => ({ choices: [{ message }] });
  expect(messageContent(wrap({ content: "{}" }))).toBe("{}");
  expect(messageContent(wrap({ content: "" }))).toBeUndefined();
  expect(messageContent(wrap({ content: "{}", refusal: "안 돼" }))).toBeUndefined();
  expect(messageContent(wrap({ content: "{}", refusal: "" }))).toBe("{}");
  expect(messageContent(wrap({ content: null }))).toBeUndefined();
  expect(messageContent({ choices: [] })).toBeUndefined();
  expect(messageContent("choices")).toBeUndefined();
  expect(messageContent(undefined)).toBeUndefined();
});

it("직접 만든 모델도 제한 시간 0이나 빈 공급자 이름은 기본값으로 읽는다", () => {
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: "https://example.test/v1", provider: "", timeoutMs: 0 });
  expect([llm.name, llm.provider, llm.timeoutMs]).toEqual(["openai(m)", "openai", 30_000]);
  expect(new OpenAIVisionLlm({ model: "v", baseUrl: OPENAI_BASE_URL, timeoutMs: 7000 }).timeoutMs).toBe(7000);
});

it("delivers the first complete status during generation and retains the strict answer and usage", async () => {
  const seen: string[] = [];
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const fetcher = fakeFetch(() => new Response(stream.readable, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(fetcher) });
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const pending = MODEL_STATUS.run({
    language: "en", begin(name, fallback) { seen.push(name, fallback ?? ""); return line => { seen.push(line); }; },
  }, () => llm.generate({ ...request, schemaName: "public_search_answer", schema }));
  const sent = await fetcher.calls[0]?.json();
  expect(sent.stream).toBe(true);
  expect(sent.stream_options).toEqual({ include_usage: true });
  expect(sent.messages[0].content).toBe(request.system);
  const wireSchema = sent.response_format.json_schema.schema;
  expect(Object.keys(wireSchema.properties)).toEqual(["backend_status", "answer"]);
  expect(wireSchema.required).toEqual(["backend_status", "answer"]);
  expect(schema.required).toEqual(["answer"]);
  expect(seen[0]).toBe("public_search_answer");
  expect(seen[1]).toMatch(/[a-z]/iu);
  const event = (data: unknown) => new TextEncoder().encode("data: " + JSON.stringify(data) + "\r\n\r\n");
  const delta = (content: string) => event({ choices: [{ index: 0, delta: { content } }] });
  const first = delta('{"backend_status":"');
  await writer.write(first.slice(0, 12));
  await writer.write(first.slice(12));
  await writer.write(delta("I’m comparing application "));
  expect(seen).toHaveLength(2);
  await writer.write(delta('instructions.","answer":"'));
  await expect.poll(() => seen.slice(2)).toEqual(["I’m comparing application instructions."]);
  await writer.write(delta('yes"}'));
  await writer.write(event({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 9 } }));
  await writer.write(new TextEncoder().encode("data: [DONE]\n\n"));
  await writer.close();
  await expect(pending).resolves.toEqual({ answer: "yes" });
  expect(seen).toHaveLength(3);
  expect(llm.usage).toEqual({ calls: 1, inputTokens: 11, outputTokens: 9 });
  expect(fetcher.calls).toHaveLength(1);
});

it("restricts private, unknown, file and vision activity even when the endpoint ignores its schema", async () => {
  const fetcher = fakeFetch(() => reply('{"backend_status":"The private value is Fern.","answer":"yes"}'));
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(fetcher) });
  const seen: string[] = [];
  const results = await MODEL_STATUS.run({ language: "ja", begin: () => line => { seen.push(line); } }, () => Promise.all([
    llm.generate({ ...request, schemaName: "personal_answer_check" }),
    llm.generate({ ...request, schemaName: "an_unknown_task" }),
    llm.generate({ ...request, schemaName: "public_search_answer", attachment: new FileAttachment("private.pdf", "application/pdf", PNG) }),
    vision(fetcher).see(seeArgs()),
  ]));
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ answer: "yes" })));
  expect(seen).toEqual([]);
  for (const call of fetcher.calls) {
    const choices: string[] = (await call.json()).response_format.json_schema.schema.properties.backend_status.enum;
    expect(choices.length).toBeGreaterThan(1);
    expect(choices.every(line => /[ぁ-ん]/u.test(line))).toBe(true);
  }
});

it("protects caller-owned status fields and isolates status listener failures from answers", async () => {
  const output = { _backend_status: "I’m comparing instructions.", backend_status: { ok: true } };
  const fetcher = fakeFetch(() => reply(JSON.stringify(output)));
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(fetcher) });
  const schema = { type: "object", properties: { backend_status: { type: "object" } }, required: ["backend_status"] };
  await expect(MODEL_STATUS.run({ language: "en", begin: () => () => { throw Error("listener closed"); } },
    () => llm.generate({ ...request, schemaName: "public_search_answer", schema }))).resolves.toEqual({ backend_status: { ok: true } });
  expect(Object.keys((await fetcher.calls[0]?.json()).response_format.json_schema.schema.properties)).toEqual(["_backend_status", "backend_status"]);
});

it("keeps JSON mode for the standalone intent pass and strips its scoped status", async () => {
  const fetcher = fakeFetch(() => reply('{"backend_status":"I’m reading the request.","type":"UNKNOWN"}'));
  const seen: string[] = [];
  const result = await MODEL_STATUS.run({ language: "en", begin: name => { seen.push(name); return line => { seen.push(line); }; } },
    () => chatCompletion({ model: "m", baseUrl: "http://localhost/v1" }, { ...request, format: { type: "json_object" } }, fetcher));
  expect(result).toEqual({ type: "UNKNOWN" });
  expect(seen).toEqual(["intent", "I’m reading the request."]);
  const sent = await fetcher.calls[0]?.json();
  expect(sent.response_format).toEqual({ type: "json_object" });
  expect(sent.messages[0].content).toContain("backend_status");
  expect(sent.stream).toBeUndefined();
});

it.each([
  ['{"answer":"yes"}', "public_search_answer", []],
  ['{"answer":"yes","backend_status":"I’m checking the guidance."}', "public_search_answer", ["I’m checking the guidance."]],
  ['{"backend_status":["I’m checking"],"answer":"yes"}', "public_search_answer", []],
  ['{"backend_status":"I’m reading a private note.","answer":"yes"}', "personal_answer_check", []],
] as const)("retains the streamed answer when its status is missing, late, invalid, or private (%s)", async (content, schemaName, expected) => {
  const data = JSON.stringify({ choices: [{ index: 0, delta: { content } }] });
  const fetcher = fakeFetch(() => new Response("data: " + data + "\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  const seen: string[] = [];
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(fetcher) });
  await expect(MODEL_STATUS.run({ language: "en", begin: () => line => { seen.push(line); } },
    () => llm.generate({ ...request, schemaName }))).resolves.toEqual({ answer: "yes" });
  expect(seen).toEqual(expected);
});

it("never promotes a truncated stream to an answer or an incomplete status to activity", async () => {
  const data = JSON.stringify({ choices: [{ delta: { content: '{"backend_status":"partial' } }] });
  const fetcher = fakeFetch(() => new Response("data: " + data + "\n\n", { headers: { "Content-Type": "text/event-stream" } }));
  const seen: string[] = [];
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(fetcher) });
  await expect(MODEL_STATUS.run({ language: "en", begin: () => line => { seen.push(line); } },
    () => llm.generate({ ...request, schemaName: "public_search_answer" }))).resolves.toBeUndefined();
  expect(seen).toEqual([]);
});

it("cancels the status stream during a read and skips already-aborted work", async () => {
  const stopped = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const fetcher = fakeFetch(() => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
  const seen: string[] = [];
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(fetcher) });
  await MODEL_STATUS.run({ language: "en", begin: name => { seen.push(name); return line => { seen.push(line); }; } }, async () => {
    const args = { ...request, schemaName: "public_search_answer", signal: stopped.signal };
    const pending = llm.generate(args);
    await expect.poll(() => stream.locked).toBe(true);
    stopped.abort();
    await expect(pending).resolves.toBeUndefined();
    await expect.poll(() => cancelled).toBe(true);
    await expect(llm.generate(args)).resolves.toBeUndefined();
    expect(seen).toEqual(["public_search_answer"]);
    expect(fetcher.calls).toHaveLength(1);
  });
});

it("isolates concurrent sessions sharing a model connection", async () => {
  let release = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fetcher = fakeFetch(async req => {
    const user: string = (await req.json()).messages[1].content;
    if (user === "first") await hold;
    return reply(JSON.stringify({ backend_status: user === "first" ? "안내를 확인하고 있어요." : "I’m reading the guidance.", answer: user }));
  });
  const llm = new OpenAIStructuredLlm({ model: "m", baseUrl: OPENAI_BASE_URL, pool: new ModelConnections(fetcher) });
  const korean: string[] = [], english: string[] = [];
  const run = (language: "ko" | "en", user: string, seen: string[]) => MODEL_STATUS.run({
    language, begin: () => line => { seen.push(line); },
  }, () => llm.generate({ ...request, user: fixtureText(user), schemaName: "public_search_answer" }));
  const first = run("ko", "first", korean);
  await expect(run("en", "second", english)).resolves.toEqual({ answer: "second" });
  release();
  await expect(first).resolves.toEqual({ answer: "first" });
  expect(korean).toEqual(["안내를 확인하고 있어요."]);
  expect(english).toEqual(["I’m reading the guidance."]);
});

it("연결 묶음을 닫으면 본문을 받는 중인 요청도 끊는다", async () => {
  const fetcher = fakeFetch(req => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        req.signal.addEventListener("abort", () => { controller.error(req.signal.reason); }, { once: true });
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/json" } });
  });
  const pool = new ModelConnections(fetcher);
  const pending = postJson("https://example.test/x", {}, {}, 5, undefined, pool);
  await new Promise(resolve => setTimeout(resolve, 50));
  const closed = performance.now();
  await pool.close();
  await expect(pending).resolves.toBeUndefined();
  expect(performance.now() - closed).toBeLessThan(1000);
});
