import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { escapeText } from "entities";
import { z } from "zod";
import { PlaywrightExecutionAdapter, stopPlaywright } from "../src/agents/web/browser/index.ts";
import { REPO_ROOT } from "../src/core/assets.ts";
import { OPENAI_BASE_URL } from "../src/core/llm.ts";
import { asciiDecimalDigits } from "../src/core/text.ts";
import { pngSize } from "../src/core/picture.ts";
import { AgentRuntime, loadConfig } from "../src/server/runtime.ts";
import { UNCHECKED_NUMBERS } from "../src/speech/picture.ts";

const pictureCase = z.object({
  id: z.string(), title: z.string(), body: z.string(), question: z.string(), offline_answer: z.string(),
  patterns: z.array(z.string()), numbers: z.array(z.string().regex(/^\d+$/u)), pick: z.string().nullable(),
  refuse: z.boolean(), min_height: z.number().optional(),
});
type Case = z.infer<typeof pictureCase>;
interface Row {
  case: string; requests: number; passed: boolean; expected_refusal: boolean; usage: unknown; cost_usd: number | null;
  dimensions?: [number, number]; latency_s?: number; speech?: string; number_check?: boolean | null; numbered_pick?: boolean;
}
export function pictureChoice(prompt: string, name: string): number | undefined {
  for (const line of prompt.split("\n")) {
    const match = /^(\p{Nd}+)\. (.*)$/u.exec(line);
    if (match?.[2] === name) return Number(asciiDecimalDigits(match[1]!));
  }
  return undefined;
}
export function reportsNumber(speech: string, digits: string) {
  return new RegExp("(?<!\\p{Nd})" + digits + "(?!\\p{Nd})", "u").test(speech);
}
const parts = z.tuple([z.object({ text: z.string() }), z.object({ image_url: z.object({ url: z.string() }) })]);
const request = z.object({ messages: z.array(z.object({ content: z.unknown() })) });

export async function evaluate(live: boolean, example?: string) {
  const cases = z.array(pictureCase).parse(JSON.parse(await readFile(join(REPO_ROOT, "tests/fixtures/picture_cases.json"), "utf8")));
  const config = loadConfig({ LLM_PROVIDER: "mock", PRACTICE_MODE: "false", HEADLESS: "true", REQUIRE_CONSENT: "false", PILOT_PROFILE: "shared" });
  if (live) {
    const dotenv = join(REPO_ROOT, ".env");
    if (existsSync(dotenv)) process.loadEnvFile(dotenv);
    const configured = loadConfig();
    config.llmVision = configured.llmVision;
    config.visionDetail = configured.visionDetail;
  } else config.llmVision = { provider: "openai", model: "offline", apiKey: "offline" };
  const rows: Row[] = [], hashes = new Set<string>();
  let active: { item: Case; row: Row; error?: unknown } | undefined;
  const inspect: typeof fetch = async (url, init) => {
    const context = active;
    assert(context, "Unexpected outgoing QA request");
    const { item, row } = context;
    try {
      row.requests++;
      assert(!item.refuse && row.requests === 1 && String(url) === OPENAI_BASE_URL + "/chat/completions");
      assert.equal(typeof init?.body, "string");
      const body = request.parse(JSON.parse(String(init?.body)));
      const [prompt, image] = parts.parse(body.messages.at(-1)?.content);
      assert(prompt.text.includes(item.question) && !/900101-1234567|비밀메모/u.test(prompt.text));
      const encoded = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(image.image_url.url)?.[1];
      assert(encoded !== undefined);
      const png = Buffer.from(encoded, "base64");
      assert.equal(png.toString("base64"), encoded);
      row.dimensions = pngSize(png);
      if (item.min_height !== undefined) {
        assert(row.dimensions[1] >= item.min_height);
        if (example !== undefined) { await mkdir(dirname(example), { recursive: true }); await writeFile(example, png); }
      }
      const digest = createHash("sha256").update(png).digest("hex");
      assert(!hashes.has(digest), "Different fixture pages produced identical captures");
      hashes.add(digest);
      if (live) {
        const response = await fetch(url, init);
        const parsed = z.object({ usage: z.looseObject({ cost: z.number().optional() }).optional() })
          .safeParse(await response.clone().json());
        if (parsed.success) { row.usage = parsed.data.usage ?? null; row.cost_usd = parsed.data.usage?.cost ?? null; }
        return response;
      }
      const pressable: number[] = [];
      if (item.pick !== null) {
        const choice = pictureChoice(prompt.text, item.pick);
        assert(choice !== undefined);
        pressable.push(choice);
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ screen: "normal", description: item.offline_answer, pressable }) } }] });
    } catch (error) { context.error = error; throw error; }
  };
  const runtime = await AgentRuntime.create(config, inspect);
  try {
    if (runtime.sessionModels().visionLlm === undefined) throw Error("Set LLM_VISION_PROVIDER=openai, LLM_VISION_MODEL and LLM_VISION_API_KEY.");
    const session = await runtime.createSession();
    try {
      const adapter = session.web.adapter;
      assert(adapter instanceof PlaywrightExecutionAdapter && adapter.page !== undefined);
      const page = adapter.page, origin = "http://picture-qa.test";
      await page.route("**/*", async route => {
        const item = cases.find(c => origin + "/" + c.id === route.request().url());
        if (item === undefined) { await route.abort(); return; }
        const title = escapeText(item.title);
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${title}</title><style>body{font:24px sans-serif;padding:32px}button,input{font:inherit}</style><main><h1>${title}</h1>${item.body}</main></html>` });
      });
      for (const item of cases) {
        await page.goto(origin + "/" + item.id);
        const row: Row = { case: item.id, requests: 0, passed: false, expected_refusal: item.refuse, usage: null, cost_usd: null };
        active = { item, row };
        const start = performance.now(), result = await session.handleTurn(item.question);
        if (active.error !== undefined) throw active.error;
        row.latency_s = Number(((performance.now() - start) / 1000).toFixed(3));
        row.speech = result.speech;
        row.number_check = item.numbers.length === 0 ? null : item.numbers.every(n => reportsNumber(result.speech, n)) && result.speech.includes(UNCHECKED_NUMBERS);
        row.passed = result.semanticAction === "describe-picture" && row.requests === Number(!item.refuse) &&
          item.patterns.every(pattern => new RegExp(pattern, "u").test(result.speech)) && row.number_check !== false && !result.speech.includes("900101-1234567");
        if (item.pick !== null) {
          await session.handleTurn("1번 눌러줘");
          if (active.error !== undefined) throw active.error;
          row.numbered_pick = await page.locator("dialog").count() === 0;
          row.passed &&= row.numbered_pick;
        }
        rows.push(row);
        active = undefined;
      }
    } finally { await session.close(); }
  } finally { await runtime.close(); await stopPlaywright(); }
  return { mode: live ? "live" : "local-scripted", model: config.llmVision.model, cases: rows };
}
async function main() {
  const { values } = parseArgs({ options: {
    live: { type: "boolean" }, report: { type: "string" }, example: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help === true) { console.log("node scripts/eval-pictures.ts [--live (paid)] [--report FILE] [--example PNG]"); return 0; }
  const report = await evaluate(values.live === true, values.example);
  const file = values.report ?? join(REPO_ROOT, "reports", "picture-qa-" + report.mode + ".json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  for (const row of report.cases) console.log(`${row.passed ? "PASS" : "FAIL"} ${row.case} (${row.requests} requests)`);
  console.log(file);
  return Number(report.cases.some(row => !row.passed));
}
if (import.meta.main) process.exitCode = await main();
