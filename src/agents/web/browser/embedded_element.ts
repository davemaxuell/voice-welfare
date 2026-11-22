import { randomUUID } from "node:crypto";
import type { Frame, Page } from "playwright";
import type { ActionTarget } from "../../../core/actions.ts";
import { AdapterError, call, type ResolvedElement } from "./driver.ts";
import { framesOf } from "./frame_controls.ts";
import { observePage } from "./observe.ts";
import type { DocumentStamp } from "./document_stamp.ts";

export const isEmbeddedRef = (ref?: string) => ref?.startsWith("f-") === true || /^s\d+-/u.test(ref ?? "");

/** 실제 포인터가 닿은 안쪽 문서에서 이름·역할·ref를 다시 대조한다. 문서 교체 시 잡아 둔 요소도 사라진다. */
export function embeddedElement(page: Page, target: ActionTarget, signal: AbortSignal, timeout: number, host: ResolvedElement, topStamp?: DocumentStamp,
  nativeClick?: (marker: string) => Promise<void>): ResolvedElement {
  const registry = framesOf(page);
  const topId = registry.documentId();
  const topUrl = topStamp?.url ?? page.url();
  const refused = async (): Promise<never> => { throw new AdapterError("NOT_SUPPORTED"); };
  return {...host, fill:refused, check:refused, select:refused, press:refused, toggleDisclosure:refused,
    async read() { signal.throwIfAborted(); return target.name ?? ""; },
    async click(evidence) {
      const grants = evidence?.grants;
      if (evidence?.inspection !== undefined || target.ref === undefined || (grants !== undefined &&
        (grants.requestedClick === undefined || grants.native !== undefined || grants.notice !== undefined || grants.plan !== undefined))) return refused();
      const owner = registry.owner(target.ref);
      const loc = await registry.locator(target.ref);
      if (owner === undefined || loc === undefined || await loc.count() !== 1) throw new AdapterError("VERIFY_FAILED");
      const url = owner.frame.url();
      const current = () => registry.documentId() === topId && page.url() === topUrl && registry.owner(target.ref!)?.frame === owner.frame && owner.frame.url() === url;
      const node = await call(signal, () => loc.elementHandle({timeout, signal}));
      try {
        if (!current()) throw new AdapterError("VERIFY_FAILED");
        const expected = {...target, ref:owner.local};
        const script = "(" + embeddedClickCheck.toString() + ")(" + observePage.toString() + "," + JSON.stringify(expected) + "," + JSON.stringify({url, topUrl, topStamp, login:evidence?.login}) + ")";
        const check = await owner.frame.evaluateHandle<(revoke?: boolean) => boolean>(script);
        const marker = "data-cheongeum-act-" + randomUUID();
        const clearMarker = () => node.evaluate((el, name) => el.removeAttribute(name), marker).catch(() => {});
        const revoke = () => {
          void check.evaluate(update => update(true)).catch(() => {});
          if (nativeClick) void clearMarker();
        };
        // 출처가 달라 안쪽에서 읽을 수 없는 상위 문서의 변경도 기다리는 포인터에 알린다.
        const ancestors = new Set<Frame>();
        for (let frame: Frame | null = owner.frame; frame !== null; frame = frame.parentFrame()) ancestors.add(frame);
        const navigated = (frame: Frame) => {
          if (ancestors.has(frame)) revoke();
        };
        page.on("framenavigated", navigated);
        signal.addEventListener("abort", revoke, {once:true});
        let rejected = false;
        try {
          if (!current()) throw new AdapterError("VERIFY_FAILED");
          if (nativeClick) {
            await call(signal, () => node.evaluate((el, name) => el.setAttribute(name, ""), marker));
            await call(signal, () => nativeClick(marker));
          } else await call(signal, () => node.click({timeout, signal}));
        } finally {
          signal.removeEventListener("abort", revoke);
          page.off("framenavigated", navigated);
          if (nativeClick) await clearMarker();
          rejected = await check.evaluate(cleanup => cleanup()).catch(() => false);
          await check.dispose().catch(() => {});
        }
        if (rejected) throw new AdapterError("VERIFY_FAILED");
      } finally { await node.dispose().catch(() => {}); }
    },
  };
}

function embeddedClickCheck(observe: typeof observePage, expected: ActionTarget, screen: {url: string; topUrl: string; topStamp?: DocumentStamp; login?:string}) {
  const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  let rejected = false, revoked = false, clicked = false;
  const sameDocument = () => {
    if (revoked || location.href !== screen.url) return false;
    try {
      const top = window.top;
      if (top?.location.href !== screen.topUrl) return false;
      const saved = screen.topStamp, actual = top.document.__cheongeumDocument;
      return saved === undefined || actual?.id === saved.id && actual.revision === saved.revision;
    } catch { return true; }
  };
  const check = (event: Event) => {
    if (!event.isTrusted) return;
    if (clicked) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    try {
      const window = observe({ref:expected.ref, limit:1, embedded:true, loginSubmit:screen.login !== undefined});
      const item = "items" in window ? window.items?.[0] : undefined;
      if (!rejected && sameDocument() && item !== undefined && item.ref === expected.ref && item.role === expected.role && item.name === expected.name &&
          !item.disabled && (screen.login === undefined || item.loginSubmit?.signature === screen.login && item.loginSubmit.filled) &&
          event.composedPath().some(el => el instanceof Element && el.getAttribute("data-cheongeum-ref") === item.ref)) {
        if (event.type === "click") clicked = true;
        return;
      }
    } catch { /* 재관찰하지 못하면 이 포인터 입력의 후속 이벤트도 막는다. */ }
    rejected = true;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of events) window.addEventListener(type, check, true);
  return (revoke = false) => {
    if (revoke) { revoked = true; return rejected; }
    for (const type of events) window.removeEventListener(type, check, true);
    return rejected || !clicked;
  };
}
