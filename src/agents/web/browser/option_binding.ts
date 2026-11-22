import { randomUUID } from "node:crypto";
import type { JSHandle, Page } from "playwright";
import type { ActionTarget } from "../../../core/actions.ts";
import { AdapterError, call } from "./driver.ts";

// 선택지 값은 이 문서 안에만 둔다. 같은 이름과 값으로 다시 그린 옵션도 다른 선택지다.
function observeOptions() {
  const pins = new WeakMap<HTMLOptionElement, { field: HTMLSelectElement; label: string; value: string; token: string }>();
  const normalize = (text: string) => text.replace(/[\u200b\u00ad]/gu, "").trim().replace(/\s+/gu, " ");
  const visible = (node: HTMLElement) => {
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility === "visible";
  };
  function resolve(field: HTMLSelectElement, label: string, seed?: string) {
    const wanted = normalize(label);
    const option = Array.from(field.options).find(candidate => normalize(candidate.label) === wanted);
    const group = option?.closest("optgroup");
    if (!option || !field.isConnected || field.matches(":disabled, [readonly]") || option.matches(":disabled") ||
      option.closest('[inert], [hidden], [aria-hidden="true" i], [aria-disabled="true" i]') ||
      !visible(option) || (group && !visible(group))) return;
    const prior = pins.get(option);
    if (prior?.field === field && prior.label === wanted && prior.value === option.value) return { option, token:prior.token };
    if (seed === undefined) return;
    pins.set(option, {field, label:wanted, value:option.value, token:seed});
    return {option, token:seed};
  }
  return {
    bind(ref: string, label: string, seed?: string) {
      const field = document.querySelector('[data-cheongeum-ref="' + CSS.escape(ref) + '"]');
      if (!(field instanceof HTMLSelectElement) || window.__cheongeumElementRefs?.get(field)?.ref !== ref) return;
      return resolve(field, label, seed)?.token;
    },
    selected(field: HTMLSelectElement, label: string, token: string) {
      const match = resolve(field, label);
      return match?.token === token ? match.option : undefined;
    },
  };
}

export type ObservedOptions = ReturnType<typeof observeOptions>;
interface Binding { reader: JSHandle<ObservedOptions>; token: string }

export function optionBindings(page: Page) {
  const pins = new WeakMap<ActionTarget, Binding>();
  let reader: Promise<JSHandle<ObservedOptions>> | undefined;
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return;
    void reader?.then(handle => handle.dispose()).catch(() => {});
    reader = undefined;
  });
  return async (previous: ActionTarget, target: ActionTarget, label: string, signal: AbortSignal) => {
    const ref = target.ref;
    if (ref === undefined) throw new AdapterError("VERIFY_FAILED");
    const original = pins.get(previous);
    const handle = original?.reader ?? await call(signal, () => reader ??= page.evaluateHandle(observeOptions));
    const token = await call(signal, () => handle.evaluate((choices, {ref, label, seed}) => choices.bind(ref, label, seed),
      {ref, label, seed:original === undefined ? randomUUID() : undefined}));
    if (token === undefined || (original !== undefined && original.token !== token)) throw new AdapterError("VERIFY_FAILED");
    const found = {reader:handle, token};
    pins.set(target, found);
    return found;
  };
}
