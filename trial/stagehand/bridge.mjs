import assert from "node:assert/strict";
import { observePage } from "../../src/agents/web/browser/observe.ts";

// 시험에서 관찰된 절대 XPath만 허용한다. iframe은 해당 Frame에서 다시 관찰한다.
export async function readObservedSelector(page, selector) {
  assert.match(selector, /^xpath=(?:\/[a-z][a-z\d-]*(?:\[\d+\])?)+$/iu);
  const steps = selector.slice("xpath=/".length).split("/");
  let frame = page.mainFrame(), path = "";
  for (const [i, step] of steps.entries()) {
    path += "/" + step;
    if (i < steps.length - 1 && /^(?:iframe|frame)(?:\[|$)/i.test(step)) {
      const owner = frame.locator("xpath=" + path);
      assert.equal(await owner.count(), 1);
      const element = await owner.elementHandle();
      frame = await element.contentFrame();
      await element.dispose();
      assert(frame);
      path = "";
    }
  }
  const target = frame.locator("xpath=" + path);
  assert.equal(await target.count(), 1);
  await frame.evaluate(observePage, null);
  const ref = await target.getAttribute("data-cheongeum-ref");
  assert(ref);
  const { items } = await frame.evaluate(observePage, { ref });
  assert.equal(items.length, 1);
  assert.equal(items[0].ref, ref);
  return { frame, ref, role: items[0].role, name: items[0].name };
}
