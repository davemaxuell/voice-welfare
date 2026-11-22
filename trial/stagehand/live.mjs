import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { nodeNetwork } from "./network.mjs";
import { publicHost, mdnSample, startPublicProxy } from "./public-proxy.mjs";

const sites = [
  ["복지로", "https://www.bokjiro.go.kr/"],
  ["MDN", "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe"],
];
const docs = new Set(["/", "/ssis-tbu/", "/ssis-tbu/index.do", new URL(sites[1][1]).pathname]);
const blockedPath = /analytics|telemetry|\/log(?:ging|ger)?[/.]|beacon|collect|pixel|sentry|glean|gtag|autofill|\/(?:XecureKeyPad|raon|inca|anyid|netfunnel)\//i;
function allowed(request) {
  const url = new URL(request.url());
  if (request.method() !== "GET" || url.protocol !== "https:" || !publicHost(url.hostname) || blockedPath.test(url.pathname)) return false;
  if (url.username || url.password) return false;
  // MDN이 공개 예제의 주소를 만든다. 새 프로필의 예제 문서 GET 외에는 이 두 매개변수를 허용하지 않는다.
  if (mdnSample(url.hostname) && request.resourceType() === "document" && url.pathname.endsWith("/runner.html")) {
    return [...url.searchParams.keys()].every(k => ["uuid", "state"].includes(k));
  }
  if ([...url.searchParams.keys()].some(k => !["v", "version", "rev", "s", "_", "t", "sample"].includes(k))) return false;
  if (request.resourceType() === "document") return docs.has(url.pathname) || (url.hostname === "developer.mozilla.org" && /example|sample|live/i.test(url.pathname));
  return /\.(?:[cm]?js|css|woff2?|png|ico|svg|jpg|webp|xml|json|html)$/i.test(url.pathname) &&
    ["script", "stylesheet", "image", "font", "xhr", "fetch", "other"].includes(request.resourceType());
}

const proxy = await startPublicProxy();
const monitor = nodeNetwork();
const { chromium } = await import("playwright");
const { attached } = await import("./launch.mjs");
const { modelAt } = await import("./model.mjs");
const profile = await mkdtemp(join(tmpdir(), "cheongeum-b0-live-"));
let trial;
try {
  const callback = modelAt("http://127.0.0.1:9");
  trial = await attached(opts => chromium.launchPersistentContext(profile, opts),
    { serviceWorkers: "block", acceptDownloads: false }, { persistentDir: profile, model: callback.model, liveProxy: proxy });
  const context = trial.resource;
  const denied = new Map(), accepted = new Map(), deniedSamples = new Set();
  await context.route("**/*", async route => {
    const request = route.request(), host = new URL(request.url()).hostname;
    if (!allowed(request)) {
      denied.set(host, (denied.get(host) ?? 0) + 1);
      const url = new URL(request.url());
      if (mdnSample(host)) deniedSamples.add(JSON.stringify([request.method(), request.resourceType(), url.pathname.slice(0,120), [...url.searchParams.keys()]]));
      return route.abort();
    }
    accepted.set(host, (accepted.get(host) ?? 0) + 1);
    const headers = request.headers();
    for (const name of ["authorization", "cookie", "referer"]) delete headers[name];
    return route.continue({ headers });
  });
  await context.routeWebSocket("**/*", route => route.close());
  for (const [site, address] of sites) {
    const page = await context.newPage();
    try {
      const response = await page.goto(address, { waitUntil: "commit", timeout: 20000 });
      assert(response.ok(), "HTTP " + response.status());
      if (site === "복지로") {
        await page.waitForURL(/index\.do/, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForFunction(() => document.body.innerText.trim().length > 80, undefined, { timeout: 8000 });
      } else {
        await page.waitForLoadState("domcontentloaded");
        await page.evaluate(() => document.querySelector("iframe")?.scrollIntoView());
        for (let attempt = 0; attempt < 20; attempt++) {
          const sample = page.frames().find(frame => mdnSample(new URL(frame.url() || "about:blank").hostname));
          if (sample && await sample.evaluate(() => (document.body?.textContent.trim().length ?? 0) > 0).catch(() => false)) break;
          await delay(350);
        }
      }
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      await cdp.detach();
      const tab = (await trial.handle.context.pages()).find(p => p.pageId === targetInfo.targetId);
      assert(tab);
      const tree = await tab.snapshot({ includeIframes: true, timeout: 12000 });
      const frames = [];
      for (const frame of page.frames().slice(1)) {
        const nonempty = await frame.evaluate(() => (document.body?.innerText.trim().length ?? 0) > 0).catch(() => false);
        frames.push({ host: new URL(frame.url() || "about:blank").hostname || frame.url(), nonempty });
      }
      const snapshotNodes = Object.keys(tree.xpathMap).length;
      const bodyLength = await page.locator("body").innerText().then(t => t.trim().length);
      console.log("PUBLIC_NAVIGATION", JSON.stringify({ site, http: response.status(), host: new URL(page.url()).hostname,
        title: await tab.title(), snapshotNodes, bodyLength,
        frames, modelCalls: callback.calls }));
      assert(bodyLength > 80, `${site} 본문 미확인 (${bodyLength})`);
      assert(snapshotNodes > 0, `${site} 스냅샷 노드 미확인`);
      if (site === "MDN") assert(frames.some(f => mdnSample(f.host) && f.nonempty), "공개 예제 iframe 본문 미확인");
    } catch (error) { console.error(site, error.message); process.exitCode = 1; }
    finally { await page.close(); }
  }
  console.log("PUBLIC_ROUTE", JSON.stringify({ accepted: Object.fromEntries(accepted), blocked: Object.fromEntries(denied), deniedSamples: [...deniedSamples] }));
  assert.equal(callback.calls, 0);
  assert.deepEqual(monitor.denied, []);
} finally {
  if (trial) {
    await trial.detach();
    await trial.resource.close();
    await rm(trial.folder, {recursive: true, force: true});
  }
  console.log("PUBLIC_PROXY", JSON.stringify(await proxy.close()));
  monitor.close();
  await rm(profile, {recursive: true, force: true});
}
