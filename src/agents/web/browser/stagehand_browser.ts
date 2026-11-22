import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Stagehand, localBrowser, type ClientLLM, type Page as StagehandPage } from "@browserbasehq/stagehand";
import { z } from "zod";
import type { Browser, LaunchOptions, Page } from "playwright";
import type { StructuredLlm } from "../../../core/llm.ts";
import { redactPictureText } from "../../../safety/privacy.ts";
import { selectObservedControl, type SemanticObservation } from "./semantic_observation.ts";
import { framesOf } from "./frame_controls.ts";
import { AdapterError, observeWith, passwordSelector } from "./driver.ts";

export type BrowserDriver = "playwright" | "stagehand";
export function browserDriver(value = process.env.BROWSER_DRIVER): BrowserDriver {
  return value === "playwright" ? "playwright" : "stagehand";
}

const unavailable = () => new AdapterError("NOT_SUPPORTED", "이 탭에서 브라우저 조작 도구에 연결하지 못했어요.");
const extension = () => realpath(join(dirname(fileURLToPath(import.meta.resolve("@browserbasehq/stagehand"))), "extension"));
function originId(path: string) {
  const digest = createHash("sha256").update(Buffer.from(path + sep, process.platform === "win32" ? "utf16le" : "utf8")).digest("hex");
  return [...digest.slice(0, 32)].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

export async function stagehandLaunchOptions(): Promise<LaunchOptions> {
  return { ignoreDefaultArgs: ["--disable-extensions"], args: [
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--enable-automation", "--enable-unsafe-extension-debugging",
    "--remote-allow-origins=chrome-extension://" + originId(await extension()),
  ] };
}

interface Inference {
  instruction: string;
  labels: Set<string>;
  llm: StructuredLlm;
  signal: AbortSignal;
  semantic?: SemanticObservation;
}

// 한 브라우저에서 여러 세션이 동시에 관찰해도, 추론은 해당 요청의 모델과 중단 신호만 쓴다.
// 원시 접근성 트리에는 입력값이 섞일 수 있어 모델에는 동작 가능한 항목의 번호와 가린 이름만 건넨다.
function clientModel(pending: Map<string, Inference>): ClientLLM {
  return { async generate(input) {
    const format = input.responseFormat;
    if (format?.type !== "json_schema" || format.name !== "Observation" || typeof format.schema !== "object" || format.schema === null) throw unavailable();
    const parts = input.messages.flatMap(message => message.content);
    if (parts.some(part => part.type !== "text")) throw unavailable();
    const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    const token = /^instruction: (청음-[a-f0-9-]+)$/mu.exec(text)?.[1];
    const request = token === undefined ? undefined : pending.get(token);
    if (request === undefined) throw unavailable();
    request.signal.throwIfAborted();
    if (request.semantic !== undefined) {
      const ids = await selectObservedControl(text, request.semantic, request.signal);
      request.signal.throwIfAborted();
      return {role:"assistant", content:[], outputFormat:"json_schema", structuredContent:{elements:
        (ids ?? []).map(elementId => ({elementId, method:"click", arguments:[], description:"고른 항목"}))}};
    }
    const labels = text.split("\n").flatMap(line => {
      const item = /^\s*\[(\d+-\d+)\] (button|link|tab|menuitem|menuitemcheckbox|menuitemradio): (.{1,512})$/u.exec(line);
      return item === null || !request.labels.has(item[3]!) ? [] : ["[" + item[1] + "] " + item[2] + ": " + redactPictureText(item[3]!)];
    }).slice(0, 600);
    const result = await request.llm.generate({ system: "사용자가 찾는 항목의 목록 번호를 골라 주세요. 누르거나 값을 입력하지 마세요.",
      user: redactPictureText(request.instruction + "\n" + labels.join("\n")), schema: format.schema, schemaName: format.name,
      signal: request.signal });
    request.signal.throwIfAborted();
    if (result == null) throw unavailable();
    return { role: "assistant", content: [], outputFormat: "json_schema", structuredContent: z.json().parse(result) };
  } };
}

interface Connection { sdk: Stagehand; pending: Map<string, Inference>; disconnecting?: Promise<void> }
const connections = new WeakMap<Browser, Connection>();
const tabs = new WeakMap<Page, Promise<{ connection: Connection; tab: StagehandPage }>>();

export function attachedDriver(page: Page): BrowserDriver {
  const browser = page.context().browser();
  return browser !== null && connections.has(browser) ? "stagehand" : "playwright";
}

// Playwright의 파이프가 먼저 준비될 수 있다. 이 크롬의 프로필에 포트와 브라우저 식별자가 모두 기록될 때까지 기다린다.
async function localEndpoint(browser: Browser, profile: string): Promise<string> {
  const marker = join(profile, "DevToolsActivePort");
  const deadline = performance.now() + 5000;
  do {
    let record = "";
    try { record = await readFile(marker, "utf8"); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const match = /^([1-9]\d{0,4})\r?\n(\/devtools\/browser\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})(?:\r?\n)?$/iu.exec(record);
    if (match !== null && Number(match[1]) <= 65535) return "ws://127.0.0.1:" + match[1] + match[2];
    if (!browser.isConnected() || performance.now() >= deadline) throw unavailable();
    await delay(50);
  } while (true);
}

export async function attachStagehand(browser: Browser, isolatedContexts: boolean): Promise<void> {
  const cdp = await browser.newBrowserCDPSession();
  let handle: Awaited<ReturnType<typeof localBrowser.connect>> | undefined;
  try {
    const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
    const profile = args.find(arg => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
    if (profile === undefined || !args.includes("--remote-debugging-address=127.0.0.1") || !args.includes("--remote-debugging-port=0")) throw unavailable();
    const cdpUrl = await localEndpoint(browser, profile);
    const path = await extension();
    const installed = await cdp.send("Extensions.loadUnpacked", { path: path + sep, enableInIncognito: isolatedContexts });
    if (installed.id !== originId(path)) throw unavailable();
    handle = await localBrowser.connect({ cdpUrl });
    const pending = new Map<string, Inference>();
    const sdk = await Stagehand.create({ browser: handle, model: clientModel(pending), selfHeal: false, cache: false,
      logging: { level: "off" } });
    connections.set(browser, { sdk, pending });
    browser.once("disconnected", () => { void detachStagehand(browser).catch(() => {}); });
  } catch (error) {
    await handle?.disconnect().catch(() => {});
    throw error;
  } finally { await cdp.detach().catch(() => {}); }
}

// 크롬이 아직 응답할 때 확장의 세션을 닫고 SDK의 CDP 웹소켓도 해제한다.
export function detachStagehand(browser: Browser): Promise<void> {
  const connection = connections.get(browser);
  if (connection === undefined) return Promise.resolve();
  connection.pending.clear();
  return connection.disconnecting ??= connection.sdk.browser.disconnect().finally(() => connections.delete(browser));
}

export function stagehandTab(page: Page) {
  let bound = tabs.get(page);
  if (bound === undefined) {
    bound = (async () => {
      const browser = page.context().browser();
      const connection = browser === null ? undefined : connections.get(browser);
      if (connection === undefined) throw unavailable();
      const session = await page.context().newCDPSession(page);
      let id: string;
      try { id = (await session.send("Target.getTargetInfo")).targetInfo.targetId; }
      finally { await session.detach(); }
      const until = Date.now() + 2000;
      do {
        const pages = await connection.sdk.browser.context.pages();
        const tab = pages.find(candidate => candidate.pageId === id);
        if (tab !== undefined) return { connection, tab };
        await delay(40);
      } while (!page.isClosed() && Date.now() < until);
      throw unavailable();
    })().catch((error: unknown) => { tabs.delete(page); throw error; });
    tabs.set(page, bound);
  }
  return bound;
}

// 셀렉터만 돌려준다. 모델이 붙인 이름·설명은 승인이나 정책에 쓰지 않는다.
export async function observedSelectors(page: Page, instruction: string, llm: StructuredLlm, signal: AbortSignal, semantic?: SemanticObservation): Promise<string[]> {
  const { connection, tab } = await stagehandTab(page);
  signal.throwIfAborted();
  const token = "청음-" + randomUUID();
  const controls = semantic?.controls ?? (await observeWith(script => tab.evaluate(script)).controlWindow({ limit: 600 })).items;
  signal.throwIfAborted();
  const labels = new Set(controls.filter(item => !item.disabled && item.pictureMasked !== true).map(item => item.name));
  connection.pending.set(token, { instruction, llm, signal, labels, semantic });
  try {
    const mask = 'input, textarea, select, [contenteditable], [role=textbox], [role=combobox], [role=searchbox], object, embed';
    const excluded = semantic === undefined ? [mask + ', iframe, frame'] :
      await framesOf(page).ignoredSelectors(mask + ', [inert], [hidden], [aria-hidden="true"], form:has(' + passwordSelector + ')');
    signal.throwIfAborted();
    const { data } = await connection.sdk.observe(token, { page: tab, timeout: 10_000,
      ignoreLocators: excluded.map(selector => tab.locator(selector)) });
    signal.throwIfAborted();
    return data.map(action => action.selector);
  } finally { connection.pending.delete(token); }
}
