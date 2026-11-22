import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { ActionTarget, ExecuteGrants } from "../../../core/actions.ts";
import { strip } from "../../../core/text.ts";
import type { InspectionBinding } from "../../../safety/guard.ts";
import { AdapterError, call, cssEscape, observeWith, playwrightElement, playwrightTarget, type PageDriver } from "./driver.ts";
import { observePage } from "./observe.ts";
import { stagehandTab } from "./stagehand_browser.ts";

export interface ClickEvidence { grants?: ExecuteGrants; inspection?: InspectionBinding }

// Stagehand의 fill은 초점을 준 뒤 현재 초점에 키 입력을 보낸다. 입력 값은 이 요소의 한 번짜리
// 함수에만 두고, Stagehand에는 이를 부를 표지만 건넨다. 멈춤·교체·초점 이동 시에는 값에 손대지 않는다.
function armFill(el: Element, { value, token }: { value: string; token: string }) {
  let applied = false;
  function write() {
    if (!(el instanceof HTMLElement) || !el.isConnected || el.matches(':disabled, [readonly], [aria-disabled="true"], [inert], input[type="password" i], [autocomplete="one-time-code" i]')) return;
    el.focus();
    if (document.activeElement !== el || !el.isConnected || el.matches(':disabled, [readonly], input[type="password" i], [autocomplete="one-time-code" i]')) return;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el instanceof HTMLInputElement && !["", "text", "search", "url", "tel", "email", "number", "date", "time", "datetime-local", "month", "week", "range", "color"].includes(el.type)) return;
      const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter === undefined) return;
      setter.call(el, value);
    } else if (el.isContentEditable) el.textContent = value;
    else return;
    applied = true;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (el instanceof HTMLInputElement && ["date", "time", "datetime-local", "month", "week", "range", "color"].includes(el.type)) {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  el.addEventListener(token, write, { once: true });
  return () => { el.removeEventListener(token, write); return applied; };
}

// 마지막 실제 포인터 입력은 중단 신호와 적중 검사를 지원하는 Playwright에 맡긴다.
// 누르는 도중 사이트가 같은 요소를 바꾸는 경우에는 해당 문서의 이벤트 시점에도 청음의 관찰 규칙으로 확인한다.
function installClickCheck(observe: typeof observePage, expected: ActionTarget, evidence: ClickEvidence) {
  const { ref, role, name } = expected;
  const { grants, inspection } = evidence;
  let rejected = false;
  const matches = (event: Event) => {
    const fresh = observe({ ref, limit: 1, inspection: inspection?.kind === "control" || grants?.plan !== undefined,
      notice: grants?.notice !== undefined });
    const item = "items" in fresh ? fresh.items?.[0] : undefined;
    let valid = item !== undefined && item.ref === ref && item.role === role && item.name === name && !item.disabled &&
      event.composedPath().some(node => node instanceof Element && node.getAttribute("data-cheongeum-ref") === ref);
    if (inspection?.kind === "control") valid &&= location.href === inspection.url && item?.inspection?.signature === inspection.control.signature;
    if (grants?.native !== undefined) valid &&= location.href === grants.native.url;
    if (grants?.plan !== undefined) valid &&= location.href === grants.plan.url &&
      item?.planSignature === (JSON.parse(grants.plan.signature) as unknown[])[2];
    if (grants?.notice !== undefined) {
      const { signature, shadows: _shadows, ...facts } = grants.notice.facts;
      const notice = item?.notice;
      valid &&= location.href === grants.notice.url && notice !== undefined &&
        notice.signature === (JSON.parse(signature) as unknown[])[2] &&
        Object.entries(facts).every(([key, value]) => JSON.stringify(notice[key as keyof typeof notice]) === JSON.stringify(value));
    }
    return valid;
  };
  const check = (event: Event) => {
    if (!event.isTrusted) return;
    try { rejected ||= !matches(event); } catch { rejected = true; }
    if (rejected) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const events = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const name of events) window.addEventListener(name, check, true);
  return () => {
    for (const name of events) window.removeEventListener(name, check, true);
    return rejected;
  };
}

export function stagehandDriver(page: Page, timeout: number): PageDriver {
  const selected = () => stagehandTab(page);
  const run = async <T>(script: string) => (await selected()).tab.evaluate<T>(script);
  return {
    ...observeWith(run),
    scroll: signal => call(signal, async () => {
      const { tab } = await selected();
      signal.throwIfAborted();
      await tab.scroll(0, 0, 0, 600);
    }),
    // SDK에는 접근성 이름의 정확 일치 검색이 없다. 기존 이름의 판정만 호스트에서 가져온다.
    hasVisibleLink: (name, signal) => call(signal, async () => (await page.getByRole("link", { name, exact: true }).filter({ visible: true }).count()) > 0),
    async hiddenLinkUrls(name, signal) {
      const { tab } = await call(signal, selected);
      return call(signal, () => tab.evaluate(wanted => {
        const compact = (text: string | null) => (text ?? "").replace(/\s+/gu, "");
        return [...new Set(Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .filter(a => compact(a.textContent) === compact(wanted) && (a.getClientRects().length === 0 || getComputedStyle(a).visibility === "hidden"))
          .map(a => a.href))].slice(0, 2);
      }, name));
    },
    async resolve(target, signal) {
      const { tab } = await call(signal, selected);
      const hostLocator = target.ref === undefined ? await playwrightTarget(page, target, signal)
        : page.locator('[data-cheongeum-ref="' + cssEscape(target.ref) + '"]').filter({ visible: true });
      const host = playwrightElement(hostLocator, signal, timeout);
      // 입력 칸·기존 label/nth 대상에도 한 번 찾은 DOM 요소만 가리키는 표지를 붙인다.
      const selector = target.ref !== undefined ? '[data-cheongeum-ref="' + cssEscape(target.ref) + '"]'
        : await call(signal, () => hostLocator.evaluate((el, id) => {
          const existing = el.getAttribute("data-cheongeum-ref");
          if (existing !== null && existing !== "") return '[data-cheongeum-ref="' + CSS.escape(existing) + '"]';
          el.setAttribute("data-cheongeum-element", id);
          return '[data-cheongeum-element="' + id + '"]';
        }, randomUUID()));
      const locator = tab.locator(selector);
      const opts = { timeout };
      if (await call(signal, () => locator.count(opts)) !== 1) throw new AdapterError("AMBIGUOUS_TARGET");
      const safeSelector = selector + ':not(input[type="password" i], [autocomplete="one-time-code" i])';
      const fieldType = () => call(signal, () => tab.evaluate(sel => document.querySelector(sel)?.getAttribute("type")?.toLowerCase() ?? null, selector));
      const inputValue = () => call(signal, () => tab.locator(safeSelector).inputValue(opts));
      const selectedLabel = () => call(signal, async () => strip(await tab.locator(selector + " option:checked").textContent(opts)));
      const isChecked = () => call(signal, () => locator.isChecked(opts));
      return {
        ...host, fieldType, inputValue, selectedLabel, isChecked,
        async click(evidence = {}) {
          signal.throwIfAborted();
          if (target.ref === undefined) return host.click();
          const script = "(" + installClickCheck.toString() + ")(" + observePage.toString() + "," + JSON.stringify(target) + "," + JSON.stringify(evidence) + ")";
          const check = await page.evaluateHandle<() => boolean>(script);
          let rejected = false;
          try { await host.click(); }
          finally {
            rejected = await check.evaluate(cleanup => cleanup()).catch(() => false);
            await check.dispose().catch(() => {});
          }
          if (rejected) throw new AdapterError("VERIFY_FAILED");
        },
        async scroll() {
          await call(signal, () => tab.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: "nearest", inline: "nearest" }), selector));
        },
        async focus() {
          await call(signal, () => tab.evaluate(sel => {
            const el = document.querySelector(sel);
            if (!(el instanceof HTMLElement || el instanceof SVGElement)) throw new Error("초점을 옮길 대상이 없어요.");
            el.focus();
          }, selector));
        },
        async fill(value) {
          if (await call(signal, () => tab.locator(safeSelector).count(opts)) !== 1) throw new AdapterError("NOT_SUPPORTED");
          const token = "cheongeum-" + randomUUID();
          const handle = await hostLocator.evaluateHandle(armFill, { token, value }, { timeout, signal });
          const cancel = () => { void handle.evaluate(revoke => revoke()).catch(() => {}); };
          signal.addEventListener("abort", cancel, { once: true });
          let applied = false;
          try {
            await call(signal, () => tab.evaluate(({ selector, token }) => {
              document.querySelector(selector)?.dispatchEvent(new Event(token));
            }, { selector: safeSelector, token }));
          } finally {
            signal.removeEventListener("abort", cancel);
            applied = await handle.evaluate(revoke => revoke()).catch(() => false);
            await handle.dispose().catch(() => {});
          }
          if (!applied) throw new AdapterError("VERIFY_FAILED");
        },
        async select(label) {
          // SDK는 옵션의 label 또는 value가 같은 모든 항목을 고른다. 값 충돌·중복 이름만 정확한 label 선택에 맡긴다.
          const unique = await call(signal, () => tab.evaluate(({ selector, label }) => {
            const el = document.querySelector(selector);
            if (!(el instanceof HTMLSelectElement) || el.disabled) return false;
            const matches = [...Array.from(el.options)].filter(o => [o.label.trim(), o.value.trim()].includes(label.trim()));
            return matches.length === 1 && matches[0]?.label === label && !matches[0].disabled;
          }, { selector, label }));
          if (!unique) return host.select(label);
          await call(signal, () => locator.selectOption(label, opts));
        },
        async read() {
          const type = await fieldType();
          if (type === "password" || await call(signal, () => tab.locator(safeSelector).count(opts)) !== 1) return "";
          if (type === "checkbox") return await isChecked() ? "예" : "아니오";
          const value = await inputValue();
          return value.length > 0 && await call(signal, () => tab.locator(selector + " option").count(opts)) > 0 ? selectedLabel() : value;
        },
      };
    },
  };
}
