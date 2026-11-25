import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeNetwork, chromeAudit } from "./network.mjs";

const isolated = process.argv.includes("--isolated");
const monitor = nodeNetwork();
const { chromium } = await import("playwright");
const { attached } = await import("./launch.mjs");
const { modelAt, fixtureAnswer, modelDescription, phone } = await import("./model.mjs");
const { readObservedSelector } = await import("./bridge.mjs");
const profile = await mkdtemp(join(tmpdir(), "cheongeum-b0-profile-"));
let httpError, modelRequests = 0, trial;
const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      modelRequests++;
      await fixtureAnswer(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url === "/inside" ? "<button>안쪽 안내</button>" :
      "<title>B0</title><p>연락처 " + phone + "</p><button>바깥 안내</button><iframe src='/inside'></iframe>");
  } catch (error) { httpError = error; res.writeHead(500).end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = "http://127.0.0.1:" + server.address().port;
const model = modelAt(origin + "/v1");
try {
  trial = isolated
    ? await attached(options => chromium.launch(options), {}, { model: model.model })
    : await attached(options => chromium.launchPersistentContext(profile, options), {}, { persistentDir: profile, model: model.model });
  console.log("B0.1 PASS");
  const { PlaywrightExecutionAdapter } = await import("../../src/agents/web/browser/index.ts");
  const adapter = new PlaywrightExecutionAdapter({ ...(isolated ? { browser: trial.resource } : { context: trial.resource }), allowedOrigins: [origin] });
  await adapter.start();
  const page = adapter.page;
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  await page.goto(origin);
  await page.frameLocator("iframe").getByRole("button").waitFor();
  const tabs = await trial.handle.context.pages();
  const matched = [];
  for (const tab of tabs) if (tab.pageId === targetInfo.targetId) matched.push(tab);
  assert.equal(matched.length, 1);
  const tab = matched[0];
  const { data } = await trial.stagehand.observe("두 안내 단추를 찾아 주세요.", { page: tab, timeout: 12000 });
  assert.equal(data.length, 2);
  const items = [];
  for (const found of data) {
    assert.equal(found.description, modelDescription);
    const { frame, ...item } = await readObservedSelector(page, found.selector);
    if (frame === page.mainFrame()) {
      const fresh = await adapter.controlWindow("", 0, { ref: item.ref });
      assert(fresh.items.some(x => x.ref === item.ref && x.name === item.name && x.role === item.role));
    }
    const scope = frame === page.mainFrame() ? "top" : "iframe";
    items.push({ ...item, frame: scope });
    console.log("REF_BRIDGE", JSON.stringify({ scope, selector: found.selector, ...item }));
  }
  assert.deepEqual(items.map(i => [i.frame, i.role, i.name]), [["top", "button", "바깥 안내"], ["iframe", "button", "안쪽 안내"]]);
  assert(model.calls > 0 && model.calls === modelRequests);
  console.log("B0.3 PASS", JSON.stringify(items), "redacted model calls", model.calls);
  for (const [index, found] of data.entries()) {
    try { assert.equal(await tab.locator(found.selector).count(), 1); }
    catch (error) { throw new Error("Stagehand locator " + items[index].frame + " " + found.selector, { cause: error }); }
  }
  console.log("STAGEHAND_LOCATORS PASS", items.map(item => item.frame).join(","));
  await adapter.close();
} catch (error) {
  console.error(httpError ?? error);
  process.exitCode = 1;
} finally {
  try {
    if (trial) {
      await trial.detach();
      await trial.resource.close();
      await trial.proxy.close();
      const chrome = await chromeAudit(trial.netLog);
      const evidence = { nodeDestinations: [...monitor.local], nodeExternal: monitor.denied,
        nodeRequests: monitor.requests.length, nodeTelemetry: monitor.requests.filter(r => r.telemetry).length,
        proxyExternal: [...trial.proxy.attempts], chrome };
      console.log("B0.4 evidence", JSON.stringify(evidence));
      assert(chrome.requests && chrome.urls && chrome.extensionSocket && monitor.requests.length);
      assert.deepEqual([...new Set([...monitor.denied, ...trial.proxy.attempts, ...chrome.external, ...chrome.telemetry])], []);
      assert.equal(evidence.nodeTelemetry, 0);
      assert(model.calls > 0 && modelRequests === model.calls, "모델 응답이 있어야 완료된 로컬 관찰로 셈");
      console.log("B0.4 PASS");
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    monitor.close();
    await rm(profile, {recursive: true, force: true});
    if (trial) await rm(trial.folder, {recursive: true, force: true});
  }
}
