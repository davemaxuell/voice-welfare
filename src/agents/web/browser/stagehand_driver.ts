import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ElementHandle, JSHandle, Page } from "playwright";
import type { ActionTarget, ExecuteGrants } from "../../../core/actions.ts";
import { strip } from "../../../core/text.ts";
import { stampDocument, type DocumentStamp } from "./document_stamp.ts";
import type { InspectionBinding } from "../../../safety/guard.ts";
import { AdapterError, call, cssEscape, observeWith, playwrightElement, playwrightTarget, type PageDriver } from "./driver.ts";
import { observePage, type ControlQuery } from "./observe.ts";
import { observedSelectors, stagehandTab } from "./stagehand_browser.ts";
import { optionBindings, type ObservedOptions } from "./option_binding.ts";
import { framesOf } from "./frame_controls.ts";
import { embeddedElement, isEmbeddedRef } from "./embedded_element.ts";
import type { SemanticObservation } from "./semantic_observation.ts";

export interface ClickEvidence { grants?: ExecuteGrants; inspection?: InspectionBinding }

// 이 함수와 이를 부르는 입력·클릭 검사는 선택된 탭의 문서 안에서 실행한다.
function boundItem(observe: typeof observePage, query: ControlQuery, expected: ActionTarget, stamp: DocumentStamp, extra?: ControlQuery) {
  const current = document.__cheongeumDocument;
  if (current?.id !== stamp.id || current.revision !== stamp.revision || location.href !== stamp.url) return;
  const fresh = observe({ ...query, ...extra });
  if (!("items" in fresh) || (fresh.more === true && query.target?.nth === undefined)) return;
  const item = fresh.items?.[0];
  if (item !== undefined && item.ref === expected.ref && item.role === expected.role && item.name === expected.name && !item.disabled) return item;
}
type ReadBound = (extra?: ControlQuery) => ReturnType<typeof boundItem>;

// Stagehand의 fill은 초점을 준 뒤 현재 초점에 키 입력을 보낸다. 입력 값은 이 요소의 한 번짜리
// 함수에만 두고, Stagehand에는 이를 부를 표지만 건넨다. 멈춤·교체·초점 이동 시에는 값에 손대지 않는다.
function armFill(el: Element, { value, token, ref, read, safeSelector }: { value: string; token: string; ref: string; read: ReadBound; safeSelector: string }) {
  let applied = false;
  const writable = () => el.isConnected && el.matches(safeSelector) && !el.matches(':disabled, [readonly], [aria-disabled="true"], [inert]');
  function write() {
    if (!(el instanceof HTMLElement) || !writable()) return;
    if (!read() || window.__cheongeumElementRefs?.get(el)?.ref !== ref) return;
    el.focus();
    if (document.activeElement !== el || !writable() || !read()) return;
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

// SDK가 이미 찾은 요소에도 뒤늦게 선택을 보낼 수 있다. 같은 칸의 같은 옵션에만 한 번 선택을 허용한다.
function armSelect(el: Element, {read, safeSelector, token, label, choices, approved}: {
  read: ReadBound; safeSelector: string; token: string; label: string; choices: ObservedOptions; approved: string;
}) {
  if (!(el instanceof HTMLSelectElement)) return;
  let applied = false;
  const select = () => {
    const item = read();
    const option = choices.selected(el, label, approved);
    if (!item || !option || !el.isConnected || !el.matches(safeSelector) || window.__cheongeumElementRefs?.get(el)?.ref !== item.ref) return;
    el.selectedIndex = option.index;
    applied = true;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  el.addEventListener(token, select, { once: true });
  return () => { el.removeEventListener(token, select); return applied; };
}

// 마지막 실제 포인터 입력은 중단 신호와 적중 검사를 지원하는 Playwright에 맡긴다.
// 누르는 도중 사이트가 같은 요소를 바꾸는 경우에는 해당 문서의 이벤트 시점에도 청음의 관찰 규칙으로 확인한다.
function installInputCheck(read: ReadBound, ref: string, evidence: ClickEvidence, keyboard: boolean) {
  if (!read()) return undefined;
  const { grants, inspection } = evidence;
  let rejected = false;
  const matches = (event: Event) => {
    const item = read({ inspection: inspection?.kind === "control" || grants?.plan !== undefined, notice: grants?.notice !== undefined });
    let valid = item !== undefined && event.composedPath().some(node => (node instanceof HTMLElement || node instanceof SVGElement) &&
      window.__cheongeumElementRefs?.get(node)?.ref === ref && node.dataset.cheongeumRef === ref);
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
  const events = keyboard ? ["keydown", "keypress", "keyup"] : ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const name of events) window.addEventListener(name, check, true);
  return () => {
    for (const name of events) window.removeEventListener(name, check, true);
    return rejected;
  };
}

export function stagehandDriver(page: Page, timeout: number): PageDriver {
  const selected = () => stagehandTab(page);
  const bindOption = optionBindings(page);
  const run = async <T>(script: string) => (await selected()).tab.evaluate<T>(script);
  const observations = observeWith(run, page);
  const documents = new WeakMap<ActionTarget, DocumentStamp>();
  async function bind(target: ActionTarget, signal: AbortSignal) {
    const tab = (await call(signal, selected)).tab;
    const stamp = documents.get(target) ?? await call(signal, () => tab.evaluate(stampDocument, randomUUID()));
    if (target.ref === undefined && target.fieldId === undefined && target.label === undefined && target.testId === undefined &&
      (target.role === undefined || target.name === undefined)) throw new AdapterError("TARGET_NOT_FOUND");
    const query: ControlQuery = target.ref !== undefined && target.fieldId === undefined ? { ref: target.ref, limit: 1 }
      : { target, offset: target.ref === undefined ? target.nth : 0, limit: 1 };
    const lookup = () => call(signal, () => observations.controlWindow(query));
    let fresh = await lookup();
    // 이름·칸으로 찾는 첫 조회만 늦게 그리는 화면을 기다린다. 한 번 묶은 ref는 다시 골라 주지 않는다.
    const deadline = Date.now() + Math.min(timeout, 2000);
    while (target.ref === undefined && target.nth === undefined && fresh.items.length === 0 && !fresh.more && Date.now() < deadline) {
      await delay(80, undefined, { signal });
      fresh = await lookup();
    }
    if (fresh.more && target.nth === undefined) throw new AdapterError("AMBIGUOUS_TARGET");
    const item = fresh.items[0];
    if (!item) throw new AdapterError(target.ref === undefined ? "TARGET_NOT_FOUND" : "VERIFY_FAILED");
    if (target.ref !== undefined && (target.ref !== item.ref || target.role !== item.role || target.name !== item.name))
      throw new AdapterError("VERIFY_FAILED");
    const expected: ActionTarget = { ref: item.ref, role: item.role, name: item.name };
    if (item.fieldId !== undefined) {
      expected.fieldId = item.fieldId;
      expected.label = item.name;
    }
    if (fresh.url !== stamp.url || page.url() !== stamp.url) throw new AdapterError("VERIFY_FAILED");
    documents.set(expected, stamp);
    return { query, expected, ref: item.ref, stamp };
  }
  return {
    ...observations,
    async bindTarget(target, signal, optionLabel) {
      const {expected} = await bind(target, signal);
      if (optionLabel !== undefined) await bindOption(target, expected, optionLabel, signal);
      return expected;
    },
    async findByMeaning(term, linksOnly, url, picker, signal) {
      try {
        const before = await call(signal, () => observations.controlWindow({limit:600, semanticOnly:true, linksOnly}));
        if (before.more || before.url !== url || page.url() !== url) return undefined;
        const semantic: SemanticObservation = {term, picker, controls:before.items.filter(i => !linksOnly || i.role === "link")};
        if (semantic.controls.length === 0) return undefined;
        const paths = await observedSelectors(page, term, picker.model, signal, semantic);
        const original = semantic.selected;
        if (original === undefined || paths.length !== 1 || page.url() !== url ||
            await framesOf(page).path(original.ref) !== paths[0]) return undefined;
        const fresh = await call(signal, () => observations.controlWindow({text:original.name, exact:true, limit:2, semanticOnly:true, linksOnly}));
        const [item] = fresh.items;
        return fresh.url === url && !fresh.more && fresh.items.length === 1 && item?.ref === original.ref && item.role === original.role &&
          item.name === original.name && item.context === original.context && !item.disabled && item.pictureMasked !== true ? item : undefined;
      } catch { signal.throwIfAborted(); return undefined; }
    },
    scroll: signal => call(signal, async () => {
      const { tab } = await selected();
      signal.throwIfAborted();
      await tab.scroll(0, 0, 0, 600);
    }),
    hasVisibleLink: (name, signal) => call(signal, async () =>
      (await observations.controlWindow({ target: { role: "link", name }, limit: 1 })).items.length > 0),
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
      const { query, expected, ref, stamp } = await bind(target, signal);
      if (isEmbeddedRef(ref)) {
        const path = await framesOf(page).path(ref);
        if (path === undefined || await call(signal, () => tab.locator(path).count({timeout})) !== 1) throw new AdapterError("VERIFY_FAILED");
        const host = playwrightElement(await playwrightTarget(page, expected, signal), signal, timeout);
        return embeddedElement(page, expected, signal, timeout, host, stamp);
      }
      const readBound = "(" + boundItem.toString() + ").bind(null," + observePage.toString() + "," + JSON.stringify(query) + "," + JSON.stringify(expected) + "," + JSON.stringify(stamp) + ")";
      const selector = '[data-cheongeum-ref="' + cssEscape(ref) + '"]';
      const hostLocator = page.locator(selector).filter({ visible: true });
      const host = playwrightElement(hostLocator, signal, timeout);
      const locator = tab.locator(selector);
      const opts = { timeout };
      if (await call(signal, () => locator.count(opts)) !== 1) throw new AdapterError("AMBIGUOUS_TARGET");
      const safeSelector = selector + ':not(input[type="password" i], [autocomplete~="one-time-code" i], [autocomplete~="current-password" i], [autocomplete~="new-password" i])';
      const fieldType = () => call(signal, () => tab.evaluate(sel => document.querySelector(sel)?.getAttribute("type")?.toLowerCase() ?? null, selector));
      const inputValue = () => call(signal, () => tab.locator(safeSelector).inputValue(opts));
      const selectedLabel = () => call(signal, async () => strip(await tab.locator(selector + " option:checked").textContent(opts)));
      const isChecked = () => call(signal, () => locator.isChecked(opts));
      async function evalHandle<T>(work: () => Promise<JSHandle<T>>): Promise<JSHandle<T>> {
        const promise = work();
        try { return await call(signal, () => promise); }
        catch (error) { void promise.then(handle => handle.dispose()).catch(() => {}); throw error; }
      }
      async function trusted(work: (node: ElementHandle<HTMLElement | SVGElement>) => Promise<void>, evidence: ClickEvidence = {}, keyboard = false) {
        signal.throwIfAborted();
        const script = "(" + installInputCheck.toString() + ")(" + readBound + "," + JSON.stringify(ref) + "," +
          JSON.stringify(evidence) + "," + String(keyboard) + ")";
        // 기다리다 문서가 바뀌어도 같은 셀렉터로 새 문서의 요소를 다시 잡지 않는다.
        const node = await call(signal, () => hostLocator.elementHandle({ timeout, signal }));
        try {
          const check = await evalHandle(() => page.evaluateHandle<ReturnType<typeof installInputCheck>>(script));
          try {
            if (!await call(signal, () => check.evaluate(armed => typeof armed === "function"))) throw new AdapterError("VERIFY_FAILED");
            await call(signal, () => work(node));
          } finally {
            const rejected = await check.evaluate(cleanup => cleanup?.() ?? true).catch(() => false);
            await check.dispose().catch(() => {});
            if (rejected) throw new AdapterError("VERIFY_FAILED");
          }
        } finally { await node.dispose().catch(() => {}); }
      }
      async function apply(operation: "scroll" | "focus" | "disclosure") {
        const mutate = (read: ReadBound, sel: string, mode: typeof operation) => {
          const el = document.querySelector(sel);
          const item = read();
          if (!(el instanceof HTMLElement || el instanceof SVGElement) || item === undefined ||
            window.__cheongeumElementRefs?.get(el)?.ref !== item.ref) return false;
          if (mode === "scroll") el.scrollIntoView({ block: "nearest", inline: "nearest" });
          else if (mode === "focus") el.focus();
          else {
            const details = el.parentElement;
            if (!(details instanceof HTMLDetailsElement) || details.querySelector(":scope > summary") !== el) return false;
            details.open = !details.open;
          }
          return true;
        };
        const script = "(" + mutate.toString() + ")(" + readBound + "," + JSON.stringify(selector) + "," + JSON.stringify(operation) + ")";
        if (!await call(signal, () => tab.evaluate<boolean>(script))) throw new AdapterError("VERIFY_FAILED");
      }
      return {
        ...host, fieldType, inputValue, selectedLabel, isChecked,
        click: evidence => trusted(node => node.click({ timeout, signal }), evidence),
        check: checked => trusted(node => node.setChecked(checked, { timeout, signal })),
        async press(key) {
          if (await call(signal, () => tab.locator(safeSelector).count(opts)) !== 1) throw new AdapterError("NOT_SUPPORTED");
          await trusted(node => node.press(key, { timeout, signal }), {}, true);
        },
        scroll: () => apply("scroll"),
        focus: () => apply("focus"),
        toggleDisclosure: () => apply("disclosure"),
        async fill(value) {
          if (await call(signal, () => tab.locator(safeSelector).count(opts)) !== 1) throw new AdapterError("NOT_SUPPORTED");
          const token = "cheongeum-" + randomUUID();
          const read = await evalHandle(() => page.evaluateHandle<ReadBound>(readBound));
          const handle = await evalHandle(() => hostLocator.evaluateHandle(armFill, { token, value, ref, read, safeSelector }, { timeout, signal }))
            .finally(() => read.dispose().catch(() => {}));
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
          signal.throwIfAborted();
          const token = "cheongeum-" + randomUUID();
          const option = await bindOption(target, expected, label, signal);
          const read = await evalHandle(() => page.evaluateHandle<ReadBound>(readBound));
          const handle = await evalHandle(() => hostLocator.evaluateHandle(armSelect,
            {read, safeSelector, token, label, choices: option.reader, approved: option.token}, { timeout, signal }))
            .finally(() => read.dispose().catch(() => {}));
          const revoke = () => handle.evaluate(clear => clear?.() ?? false).catch(() => false);
          const cancel = () => { void revoke(); };
          signal.addEventListener("abort", cancel, { once: true });
          let applied = false;
          try {
            await call(signal, () => tab.evaluate(({ selector, token }) => {
              document.querySelector(selector)?.dispatchEvent(new Event(token));
            }, { selector: safeSelector, token }));
          } finally {
            signal.removeEventListener("abort", cancel);
            applied = await revoke();
            await handle.dispose().catch(() => {});
          }
          if (!applied) throw new AdapterError("VERIFY_FAILED");
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
