import type { Page } from "playwright";
import type { ActionTarget } from "../../../core/actions.ts";
import { AdapterError, call, type ResolvedElement } from "./driver.ts";
import { framesOf } from "./frame_controls.ts";
import { observePage } from "./observe.ts";

export const isEmbeddedRef = (ref?: string) => ref?.startsWith("f-") === true || /^s\d+-/u.test(ref ?? "");

/** 실제 포인터가 닿은 안쪽 문서에서 이름·역할·ref를 다시 대조한다. 문서 교체 시 잡아 둔 요소도 사라진다. */
export function embeddedElement(page: Page, target: ActionTarget, signal: AbortSignal, timeout: number, host: ResolvedElement): ResolvedElement {
  const registry = framesOf(page);
  const refused = async (): Promise<never> => { throw new AdapterError("NOT_SUPPORTED"); };
  return {...host, fill:refused, check:refused, select:refused, press:refused, toggleDisclosure:refused,
    async read() { signal.throwIfAborted(); return target.name ?? ""; },
    async click(evidence) {
      if (evidence?.grants !== undefined || evidence?.inspection !== undefined || target.ref === undefined) return refused();
      const owner = registry.owner(target.ref);
      const loc = await registry.locator(target.ref);
      if (owner === undefined || loc === undefined || await loc.count() !== 1) throw new AdapterError("VERIFY_FAILED");
      const node = await call(signal, () => loc.elementHandle({timeout, signal}));
      try {
        if (registry.owner(target.ref)?.frame !== owner.frame) throw new AdapterError("VERIFY_FAILED");
        const expected = {...target, ref:owner.local};
        const script = "(" + embeddedClickCheck.toString() + ")(" + observePage.toString() + "," + JSON.stringify(expected) + ")";
        const check = await owner.frame.evaluateHandle<() => boolean>(script);
        let rejected = false;
        try { await call(signal, () => node.click({timeout, signal})); }
        finally {
          rejected = await check.evaluate(cleanup => cleanup()).catch(() => false);
          await check.dispose().catch(() => {});
        }
        if (rejected) throw new AdapterError("VERIFY_FAILED");
      } finally { await node.dispose().catch(() => {}); }
    },
  };
}

function embeddedClickCheck(observe: typeof observePage, expected: ActionTarget) {
  const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  let rejected = false;
  const check = (event: Event) => {
    if (!event.isTrusted) return;
    try {
      const window = observe({ref:expected.ref, limit:1, embedded:true});
      const item = "items" in window ? window.items?.[0] : undefined;
      if (!rejected && item !== undefined && item.ref === expected.ref && item.role === expected.role && item.name === expected.name &&
          !item.disabled && event.composedPath().some(el => el instanceof Element && el.getAttribute("data-cheongeum-ref") === item.ref)) return;
    } catch { /* 재관찰하지 못하면 이 포인터 입력의 후속 이벤트도 막는다. */ }
    rejected = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of events) window.addEventListener(type, check, true);
  return () => {
    for (const type of events) window.removeEventListener(type, check, true);
    return rejected;
  };
}
