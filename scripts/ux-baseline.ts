import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { chromium, expect, type Page } from "@playwright/test";
import { z } from "zod";
import { REPO_ROOT, webStatic } from "../src/core/assets.ts";
import { startUi } from "../tests/e2e/web-ui-fixtures.ts";
import { ensureMockSite } from "./mock-site.ts";
import { main as withPortLock } from "./with-port-lock.ts";

const scenarios = ["typed", "stop", "approval", "progress", "typing-100", "typing-1000", "typing-5000"] as const;
type Scenario = typeof scenarios[number];
const metrics: Record<Scenario, string> = {
  typed: "요청 처리 시작 → 결과 반영", stop: "멈춰 → 중단됨 상태 표시", approval: "승인 선택 → 결과 반영",
  progress: "30초 작업 중 진행 요청 사이의 평균 간격", "typing-100": "키 입력 → 화면 갱신 (100개)",
  "typing-1000": "키 입력 → 화면 갱신 (1,000개)", "typing-5000": "키 입력 → 화면 갱신 (5,000개)",
};
const eventsSchema = z.object({ events: z.array(z.object({
  actionType: z.string(), success: z.boolean(), latencyMs: z.number().nonnegative(),
})) });
const sampleSchema = z.object({
  ms: z.number().nonnegative(), longTasks: z.number().int().nonnegative(), commits: z.number().int().nonnegative(),
  polls: z.number().int().nonnegative(), stages: z.array(z.object({ stage: z.string(), durationMs: z.number() })),
});
type Sample = z.infer<typeof sampleSchema>;
const groupSchema = z.object({ samples: z.array(sampleSchema), server: eventsSchema.shape.events });
type Group = z.infer<typeof groupSchema>;
const reportDir = join(REPO_ROOT, "reports/ux");

function distribution(values: number[]) {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
  return { n: sorted.length, p50: at(0.50), p95: at(0.95), min: sorted[0]!, max: at(1) };
}

async function send(page: Page, text: string) {
  const command = page.locator("#command");
  await expect(page.locator("#send")).toBeEnabled();
  await command.fill(text);
  await command.press("Enter");
}

async function seedTranscript(page: Page, count: number) {
  await page.route(url => url.pathname === "/src/conversation.ts" && !url.searchParams.has("seed"), route =>
    route.fulfill({ contentType: "text/javascript", body: `
      export * from "/src/conversation.ts?seed";
      import { snapshot } from "/src/conversation.ts?seed";
      const messages = snapshot().messages;
      for (let i = 0; i < ${count}; i++) {
        messages.push({ id: "sample-" + i, role: "assistant", who: "청음", text: "연습 메시지 " + i });
      }` }));
}

async function scenario(page: Page, name: Scenario) {
  if (name === "typed") {
    await send(page, "장애인연금 신청 도와줘");
    await expect(page.locator("#fields")).toContainText("성명");
    return;
  }
  if (name === "approval") {
    const reply = page.waitForResponse(r => r.url().endsWith("/confirm"));
    await page.locator("#confirm-yes").click();
    assert((await reply).ok());
    await expect(page.locator("#confirm-panel")).toBeHidden();
    return;
  }
  if (name === "stop" || name === "progress") {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/turn", async route => {
      const response = await route.fetch();
      await held;
      await route.fulfill({ response });
    });
    const sent = page.waitForRequest(r => r.url().endsWith("/api/turn"));
    const complete = page.waitForResponse(r => r.url().endsWith("/api/turn"), { timeout: 60_000 });
    try {
      await send(page, "장애인연금 얼마 받아?");
      await sent;
      if (name === "stop") {
        await page.locator("#stop-all").click();
        await expect(page.locator("#st-state")).toHaveAttribute("data-state", "STOPPED");
      } else await delay(30_000);
    } finally { release(); }
    assert((await complete).ok());
    await expect(page.locator("#send")).toBeEnabled();
    return;
  }
  const input = page.locator("#command");
  await input.focus();
  const interval = await input.evaluateHandle(el => ({
    nextPaint: new Promise<number>(resolve => {
      el.addEventListener("keydown", () => {
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - start)));
      }, { once: true });
    }),
  }));
  await page.keyboard.press("a");
  await expect(input).toHaveValue("a");
  return interval.evaluate(probe => probe.nextPaint);
}

async function sample(page: Page, url: string, name: Scenario): Promise<Sample> {
  const count = name.startsWith("typing-") ? Number(name.slice(7)) : 0;
  if (count > 0) await seedTranscript(page, count);
  await page.goto(url + "?perf=1");
  await expect(page.locator("#send")).toBeEnabled({ timeout: 30_000 });
  if (count > 0) await expect(page.locator("#log > li")).toHaveCount(count);
  if (name === "approval") {
    await send(page, "내 이름은 구름별이라고 저장해줘");
    await expect(page.locator("#confirm-yes")).toBeEnabled();
  }
  const times: number[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.endsWith("/progress")) times.push(performance.now()); });
  const observation = await page.evaluateHandle(() => {
    const data = window.cheongeumPerf;
    if (data === undefined || !PerformanceObserver.supportedEntryTypes.includes("longtask")) throw new Error("측정 기능을 사용할 수 없습니다.");
    let longTasks = 0;
    const count = (entries: PerformanceEntry[]) => { longTasks += entries.filter(e => e.duration > 50).length; };
    const observer = new PerformanceObserver(list => count(list.getEntries()));
    observer.observe({ type: "longtask" });
    const startCommits = data.commits, startRecords = data.records.length;
    return () => {
      count(observer.takeRecords());
      observer.disconnect();
      return { longTasks, commits: data.commits - startCommits, records: data.records.slice(startRecords) };
    };
  });
  const keyTime = await scenario(page, name);
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const { longTasks, commits, records } = await observation.evaluate(finish => finish());
  const stageTime = (stage: string) => {
    const record = records.find(r => r.stage === stage && !r.cancelled);
    assert(record, `누락된 단계: ${stage}`);
    return record.durationMs;
  };
  let ms: number;
  if (keyTime !== undefined) ms = keyTime;
  else if (name === "stop") {
    assert(records.some(r => r.stage === "turn-sent" && r.cancelled));
    ms = stageTime("stopped-state-paint");
  } else if (name === "progress") {
    assert(times.length >= 2, "진행 요청 간격을 측정할 수 없습니다.");
    ms = (times.at(-1)! - times[0]!) / (times.length - 1);
  } else ms = stageTime("turn-sent") + stageTime("result-applied");
  return { ms, commits, longTasks, polls: times.length, stages: records.map(({ stage, durationMs }) => ({ stage, durationMs })) };
}

async function runGroup(name: Scenario, runs: number): Promise<Group> {
  const ui = await startUi(false, { REQUIRE_CONSENT: "false", HEADLESS: "true" });
  try {
    const browser = await chromium.launch();
    const samples: Sample[] = [];
    try {
      for (let i = 0; i < runs; i++) {
        const page = await browser.newPage({ locale: "ko-KR" });
        try { samples.push(await sample(page, ui.url, name)); }
        finally { await page.close(); await ui.reset(); }
      }
    } finally { await browser.close(); }
    const response = await fetch(new URL("/api/events", ui.url));
    assert(response.ok);
    const { events } = eventsSchema.parse(await response.json());
    assert(events.every(e => e.success), "서버에 실패한 조작이 있습니다.");
    if (name === "typed") assert(events.length >= runs, "연습 신청서를 연 조작 기록이 부족합니다.");
    return { samples, server: events };
  } finally { await ui.close(); }
}

async function entries() {
  const result = [];
  for (const html of ["index.html", "avatar/index.html"]) {
    const source = await readFile(join(webStatic, html), "utf8");
    const path = source.match(/<script\b[^>]*\bsrc="([^"]+\.js)"/u)?.[1];
    assert(path !== undefined, `${html}의 번들을 찾을 수 없습니다.`);
    const bytes = await readFile(join(webStatic, path));
    result.push({ html, asset: path, bytes: bytes.length, gzip: gzipSync(bytes).length });
  }
  return result;
}

async function run() {
  const { values } = parseArgs({ options: { scenario: { type: "string" }, runs: { type: "string", default: "20" }, practice: { type: "string" } } });
  const runs = z.coerce.number().int().min(1).parse(values.runs);
  if (process.env.CHEONGEUM_UI_TEST_API_URL !== undefined) throw new Error("로컬 시험 서버를 사용해주세요.");
  await mkdir(reportDir, { recursive: true });
  if (values.practice !== undefined) {
    const mock = await ensureMockSite(5174);
    try { await writeFile(values.practice, JSON.stringify(await runGroup("typed", runs))); }
    finally { await mock?.close(); }
    return;
  }
  const names = values.scenario === undefined ? scenarios : [z.enum(scenarios).parse(values.scenario)];
  const groups = new Map<Scenario, Group>();
  for (const name of names) {
    if (name === "typed") {
      const result = join(reportDir, `typed-${process.pid}.json`);
      try {
        const code = await withPortLock(["--", process.execPath, import.meta.filename, "--practice", result, "--runs", String(runs)]);
        assert.equal(code, 0, "연습 사이트 측정 실패");
        groups.set(name, groupSchema.parse(JSON.parse(await readFile(result, "utf8"))));
      } finally {
        await rm(result, { force: true });
      }
    } else groups.set(name, await runGroup(name, runs));
    console.log(`${name}: ${runs}회 완료`);
  }
  const rows = [...groups].map(([name, g]) => ({
    name, metric: metrics[name], ...distribution(g.samples.map(s => s.ms)),
    longTasks: g.samples.reduce((n, s) => n + s.longTasks, 0), commits: g.samples.reduce((n, s) => n + s.commits, 0),
    polls: g.samples.reduce((n, s) => n + s.polls, 0),
  }));
  const actions = new Map<string, number[]>();
  for (const g of groups.values()) for (const e of g.server) {
    const values = actions.get(e.actionType) ?? [];
    values.push(e.latencyMs);
    actions.set(e.actionType, values);
  }
  const server = [...actions].map(([action, v]) => ({ action, ...distribution(v) }));
  const sizes = await entries(), head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const filename = values.scenario === undefined && runs === 20 ? "baseline" : `baseline-${values.scenario ?? "all"}-${runs}`;
  const format = (n: number) => n.toFixed(2);
  const report = ["# 청음 클라이언트 시간 기준선", "", `커밋 \`${head}\`. Vite 개발 모드, 헤드리스 Chromium, 로컬 모의 서비스. 각 표본은 새 창과 세션에서 실행했습니다. 입력·멈춤의 화면 갱신은 연속된 두 애니메이션 프레임으로 근사했습니다. 긴 작업·React 커밋·진행 요청은 측정 구간의 합계입니다.`, "",
    "| 동작 | 횟수 | p50 (ms) | p95 (ms) | 최솟값–최댓값 (ms) | 50 ms 초과 작업 | React 커밋 | 진행 요청 |",
    "|---|---:|---:|---:|---|---:|---:|---:|",
    ...rows.map(r => `| ${r.metric} | ${r.n} | ${format(r.p50)} | ${format(r.p95)} | ${format(r.min)}–${format(r.max)} | ${r.longTasks} | ${r.commits} | ${r.polls} |`),
    "", "## 서버 조작 시간", "", "로컬 /api/events에 기록된 latencyMs를 사용합니다.", "",
    "| 조작 | 횟수 | p50 (ms) | p95 (ms) | 최솟값–최댓값 (ms) |", "|---|---:|---:|---:|---|",
    ...server.map(r => `| ${r.action} | ${r.n} | ${r.p50} | ${r.p95} | ${r.min}–${r.max} |`),
    "", "## 배포 빌드 진입 파일", "", "| 화면 | 파일 | 바이트 | gzip 바이트 |", "|---|---|---:|---:|",
    ...sizes.map(s => `| ${s.html} | ${s.asset} | ${s.bytes} | ${s.gzip} |`), "",
  ].join("\n");
  await writeFile(join(reportDir, filename + ".json"), JSON.stringify({ head, rows, server, sizes, groups: Object.fromEntries(groups) }, null, 2));
  await writeFile(join(reportDir, filename + ".md"), report);
  console.log(report);
}

await run();
