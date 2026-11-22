import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { afterAll, expect } from "vitest";
import { chromium } from "playwright";
import { attached } from "./launch.mjs";
import { modelAt } from "./model.mjs";

// 원본 테스트와 앱이 쓰는 동일한 Playwright 객체의 시작/종료만 이 작업자에서 감싼다.
const launch = chromium.launch.bind(chromium);
const persistent = chromium.launchPersistentContext.bind(chromium);
const active = new Set();
let launches = 0, closed = 0, seen = 0, hidden = 0;
async function inspectPage(page, handle) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    const pages = await handle.context.pages();
    if (pages.some(p => p.pageId === targetInfo.targetId)) seen++;
    else hidden++;
  } finally { await cdp.detach(); }
}
async function withStagehand(start, options, persistentDir) {
  const callback = modelAt("http://127.0.0.1:9");
  const trial = await attached(start, options ?? {}, { persistentDir, model: callback.model });
  active.add(trial);
  launches++;
  const { resource, handle } = trial;
  function watch(context) {
    const newPage = context.newPage.bind(context);
    context.newPage = async (...args) => {
      const page = await newPage(...args);
      await inspectPage(page, handle);
      return page;
    };
  }
  if (resource.newContext) {
    const newContext = resource.newContext.bind(resource);
    resource.newContext = async (...args) => {
      const context = await newContext(...args);
      watch(context);
      return context;
    };
  } else {
    watch(resource);
    for (const page of resource.pages()) await inspectPage(page, handle);
  }
  const close = resource.close.bind(resource);
  let closing;
  resource.close = (...args) => closing ??= (async () => {
    try {
      assert(trial.stagehand.initialized && handle.connected);
      await trial.stagehand.metrics();
      assert.equal(callback.calls, 0);
      await trial.detach();
    } finally {
      await close(...args);
      await trial.proxy.close();
      await rm(trial.folder, { recursive: true, force: true });
      active.delete(trial);
      closed++;
    }
  })();
  return resource;
}
chromium.launch = options => withStagehand(launch, options);
chromium.launchPersistentContext = (dir, options) => withStagehand(opts => persistent(dir, opts), options, dir);
afterAll(async () => {
  try {
    await Promise.all([...active].map(trial => trial.resource.close()));
    process.stderr.write("B0.2 runtime " + JSON.stringify({ suite: expect.getState().testPath, launches, closed, visibleTargets: seen, hiddenTargets: hidden }) + "\n");
    assert(launches > 0 && closed === launches && seen + hidden > 0);
  } finally {
    chromium.launch = launch;
    chromium.launchPersistentContext = persistent;
  }
});
