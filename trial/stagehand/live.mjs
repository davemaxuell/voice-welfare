import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodeNetwork } from "./network.mjs";

// 공개 문서의 GET 응답만 받아 시험용 새 프로필에 표시한다. 원격 스크립트·모델·양식은 실행하지 않는다.
const getPublic = globalThis.fetch.bind(globalThis);
const sites = [
  ["복지로", "https://www.bokjiro.go.kr/"],
  ["MDN", "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe"],
];
async function publicDocument(start) {
  let url = new URL(start);
  const allowed = url.hostname;
  for (let i = 0; i < 5; i++) {
    assert(url.protocol === "https:" && url.hostname === allowed && !url.username && !url.password && !url.search);
    const response = await getPublic(url, { redirect: "manual", signal: AbortSignal.timeout(15000),
      headers: { "accept": "text/html" }, credentials: "omit" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get("location"), url);
      await response.body.cancel();
      continue;
    }
    assert(response.ok, "HTTP " + response.status);
    assert(/text\/html/i.test(response.headers.get("content-type") ?? ""));
    return { url: url.href, html: await response.text() };
  }
  throw new Error("문서 이동 횟수 초과");
}
// 공개 GET은 SDK를 불러오기 전에 완료한다. 이후 SDK와 브라우저에는 오프라인 시험과 같은 차단을 건다.
const pages = [];
for (const [site, address] of sites) {
  try { pages.push({ site, ...(await publicDocument(address)) }); }
  catch (error) { console.warn(site, "공개 문서 읽기 실패", error.message); process.exitCode = 1; }
}
const monitor = nodeNetwork();
const { chromium } = await import("playwright");
const { attached } = await import("./launch.mjs");
const { modelAt } = await import("./model.mjs");
const profile = await mkdtemp(join(tmpdir(), "cheongeum-b0-live-"));
let trial;
try {
  const callback = modelAt("http://127.0.0.1:9");
  trial = await attached(opts => chromium.launchPersistentContext(profile, opts), {}, { persistentDir: profile, model: callback.model });
  const page = trial.resource.pages()[0];
  for (const { site, url, html } of pages) {
    await page.route("**/*", route => {
      if (route.request().isNavigationRequest() && route.request().resourceType() === "document" && route.request().url() === url) {
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: html,
          headers: {"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src about:; sandbox allow-same-origin"} });
      }
      return route.abort();
    });
    await page.goto(url);
    const session = await trial.resource.newCDPSession(page);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const tab = (await trial.handle.context.pages()).find(p => p.pageId === targetInfo.targetId);
    assert(tab);
    const tree = await tab.snapshot({ includeIframes: true, timeout: 12000 });
    console.log("PUBLIC_DOCUMENT", JSON.stringify({ site, host: new URL(url).hostname,
      status: 200, title: await tab.title(), iframeElements: await page.locator("iframe").count(),
      snapshotNodes: Object.keys(tree.xpathMap).length, modelCalls: callback.calls }));
    await page.unrouteAll({ behavior: "wait" });
  }
  assert.equal(callback.calls, 0);
  assert.deepEqual(monitor.denied, []);
  const blocked = [...trial.proxy.attempts];
  console.log("PUBLIC_BLOCKED_CONNECTIONS", JSON.stringify(blocked));
  assert(blocked.every(host => ["www.bokjiro.go.kr", "developer.mozilla.org", "content-autofill.googleapis.com"].includes(host)));
} finally {
  if (trial) {
    await trial.detach();
    await trial.resource.close();
    await trial.proxy.close();
    await rm(trial.folder, {recursive: true, force: true});
  }
  monitor.close();
  await rm(profile, {recursive: true, force: true});
}
