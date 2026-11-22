import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import type { ActionTarget, ExecutionErrorCode } from "../../../core/actions.ts";
import { strip } from "../../../core/text.ts";
import type { ClickEvidence } from "./stagehand_driver.ts";
import { observePage, type ControlQuery } from "./observe.ts";
import { framesOf } from "./frame_controls.ts";
import { embeddedElement, isEmbeddedRef } from "./embedded_element.ts";
import type { ControlPicker } from "../control_picker.ts";

const InspectionControlSchema = z.union([
  z.object({ kind: z.literal("navigation"), href: z.string(), signature: z.string() }),
  z.object({ kind: z.enum(["disclosure", "ambiguous", "blocked"]), href: z.string().optional(), signature: z.string() }),
]);
// shadows는 페이지 안에서는 알 수 없어 읽은 그대로는 -1(세지 않음)이다. controlWindow가 브라우저의 DOM 정보로 세어 채운다.
const NoticeFactsSchema = z.object({
  kind: z.enum(["dialog", "layer"]), title: z.string(), text: z.string(), textLength: z.number(), buttons: z.array(z.string()),
  buttonCount: z.number(), others: z.number(), hasInputs: z.boolean(), popups: z.number(), signature: z.string(), root: z.string(),
  shadows: z.number().default(-1),
});
const ControlItemSchema = z.looseObject({
  ref: z.string(), role: z.string(), name: z.string(), region: z.string(), disabled: z.boolean(),
  context: z.string().optional(), pictureMasked: z.boolean().optional(), inspection: InspectionControlSchema.optional(),
  notice: NoticeFactsSchema.optional(), planSignature: z.string().optional(),
  fieldId: z.string().optional(),
});
const ControlWindowSchema = z.object({ url: z.string(), items: z.array(ControlItemSchema), more: z.boolean() });
const InspectionSearchSchema = z.object({
  url: z.string(), destination: z.string(), parameter: z.string(), signature: z.string(), field: z.object({ ref: z.string(), name: z.string() }),
});
export type ControlItem = z.infer<typeof ControlItemSchema>;
export type ControlWindow = z.infer<typeof ControlWindowSchema>;

export class AdapterError extends Error {
  readonly code: ExecutionErrorCode;
  constructor(code: ExecutionErrorCode, message: string = code) { super(message); this.code = code; }
}

type InspectionSearch = z.infer<typeof InspectionSearchSchema>;
const PageObservationSchema = z.looseObject({ errors: z.array(z.string()).optional() });

/** 한 번 확인한 요소. 이 조작의 중단 신호와 제한 시간을 함께 가진다. */
export interface ResolvedElement {
  scroll(): Promise<void>;
  cursorBox(hover: boolean): Promise<{ x: number; y: number; width: number; height: number } | null | undefined>;
  waitForClick(): Promise<void>;
  toggleDisclosure(): Promise<void>;
  click(evidence?: ClickEvidence): Promise<void>;
  focus(): Promise<void>;
  press(key: string): Promise<void>;
  fill(value: string): Promise<void>;
  select(label: string): Promise<void>;
  check(checked: boolean): Promise<void>;
  fieldType(): Promise<string | null>;
  inputValue(): Promise<string>;
  selectedLabel(): Promise<string>;
  isChecked(): Promise<boolean>;
  read(): Promise<string>;
}

/** 호스트가 선택한 단일 탭의 관찰과 요소 조작. 이동과 승인 기록은 호스트가 맡는다. */
export interface PageDriver {
  findByMeaning?(name: string, linksOnly: boolean, url: string, picker: ControlPicker, signal: AbortSignal): Promise<ControlItem | undefined>;
  observe(signal: AbortSignal): Promise<z.infer<typeof PageObservationSchema>>;
  controlWindow(query: ControlQuery): Promise<ControlWindow>;
  inspectionSearch(fieldId: string): Promise<InspectionSearch | undefined>;
  /** 정책 검사에 사용할 현재 요소의 ref·역할·이름을 구한다. 입력 칸에는 칸 id도 남긴다. */
  bindTarget?(target: ActionTarget, signal: AbortSignal, optionLabel?: string): Promise<ActionTarget>;
  resolve(target: ActionTarget, signal: AbortSignal): Promise<ResolvedElement>;
  scroll(signal: AbortSignal): Promise<void>;
  hasVisibleLink(name: string, signal: AbortSignal): Promise<boolean>;
  hiddenLinkUrls(name: string, signal: AbortSignal): Promise<string[]>;
}

export function call<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return work().then(value => { signal.throwIfAborted(); return value; });
}
export async function optional<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | undefined> {
  try { return await call(signal, work); }
  catch { signal.throwIfAborted(); return undefined; }
}

export const browserPatterns = { attributeQuotes: /["\\]/gu, spaces: /\p{White_Space}+/gu };
export const cssEscape = (value: string) => value.replace(browserPatterns.attributeQuotes, ch => "\\" + ch);
const observeFunction = observePage.toString();
// 일부 포털은 브라우저 드라이버가 객체를 돌려받을 때 쓰는 내장 함수를 바꿔 둔다. 관찰은 글(JSON)로 받는다.
const observeJson = `JSON.stringify((${observeFunction})())`;
const controlsJson = (query: ControlQuery) => `JSON.stringify((${observeFunction})(${JSON.stringify(query)}))`;

export function playwrightElement(loc: Locator, signal: AbortSignal, timeout: number): ResolvedElement {
  const opts = { timeout, signal };
  const fieldType = () => call(signal, () => loc.getAttribute("type", { signal }));
  const inputValue = () => call(signal, () => loc.inputValue(opts));
  const selectedLabel = async () => strip(await call(signal, () => loc.locator("option:checked").textContent(opts)) ?? "");
  const isChecked = () => call(signal, () => loc.isChecked(opts));
  return {
    fieldType, inputValue, selectedLabel, isChecked,
    scroll: () => call(signal, () => loc.scrollIntoViewIfNeeded({ signal })),
    async cursorBox(hover) {
      await optional(signal, () => loc.scrollIntoViewIfNeeded({ timeout: 2000, signal }));
      if (hover) await call(signal, () => loc.hover(opts));
      return optional(signal, () => loc.boundingBox({ signal }));
    },
    waitForClick: () => call(signal, () => loc.click({ ...opts, trial: true })),
    toggleDisclosure: () => call(signal, () => loc.evaluate(element => {
      const details = element.parentElement;
      if (!(details instanceof HTMLDetailsElement) || details.querySelector(":scope > summary") !== element) {
        throw new Error("Disclosure changed");
      }
      details.open = !details.open;
    })),
    click: () => call(signal, () => loc.click(opts)),
    focus: () => call(signal, () => loc.focus(opts)),
    press: key => call(signal, () => loc.press(key, opts)),
    fill: value => call(signal, () => loc.fill(value, opts)),
    select: async label => { await call(signal, () => loc.selectOption({ label }, opts)); },
    check: checked => call(signal, () => loc.setChecked(checked, opts)),
    async read() {
      const type = await fieldType();
      if (type === "password") return "";
      if (type === "checkbox") return await isChecked() ? "예" : "아니오";
      const hasOptions = await call(signal, () => loc.locator("option").count()) > 0;
      const value = await inputValue();
      return hasOptions && value.length > 0 ? selectedLabel() : value;
    },
  };
}

export async function playwrightTarget(page: Page, target: ActionTarget, signal: AbortSignal): Promise<Locator> {
  signal.throwIfAborted();
  if (target.ref !== undefined) {
    const loc = await framesOf(page).locator(target.ref);
    if (loc === undefined || await call(signal, () => loc.count()) !== 1) throw new AdapterError("AMBIGUOUS_TARGET");
    return loc;
  }
  let loc: Locator;
  if (target.label !== undefined) loc = page.getByLabel(target.label, { exact: true });
  else if (target.role !== undefined && target.name !== undefined) {
    // 역할은 영문 소문자만 허용하고 이름은 정확히 일치하도록 직렬화한다.
    if (!/^[a-z]+$/u.test(target.role)) throw new AdapterError("TARGET_NOT_FOUND");
    loc = page.locator("role=" + target.role + "[name=" + JSON.stringify(target.name) + "s]");
  } else if (target.testId !== undefined) loc = page.getByTestId(target.testId);
  else if (target.fieldId !== undefined) {
    const id = cssEscape(target.fieldId);
    loc = page.locator('[id="' + id + '"], [data-cheongeum-id="' + id + '"]');
  } else throw new AdapterError("TARGET_NOT_FOUND");
  loc = loc.filter({ visible: true });
  if (target.nth !== undefined) {
    const nth = loc.nth(target.nth);
    if (await call(signal, () => nth.count()) === 0) throw new AdapterError("TARGET_NOT_FOUND");
    return nth;
  }
  let count = await call(signal, () => loc.count());
  if (count === 0) {
    await optional(signal, () => loc.first().waitFor({ state: "visible", timeout: 2000, signal }));
    count = await call(signal, () => loc.count());
  }
  if (count === 0) throw new AdapterError("TARGET_NOT_FOUND");
  if (count > 1) throw new AdapterError("AMBIGUOUS_TARGET");
  return loc;
}

export function observeWith(evaluate: (script: string) => Promise<unknown>, page?: Page): Pick<PageDriver, "observe" | "controlWindow" | "inspectionSearch"> {
  const read = async (frame: Frame | undefined, query: ControlQuery) => {
    const script = controlsJson(query);
    const text = frame === undefined || frame === page?.mainFrame() ? await evaluate(script) : await frame.evaluate(script);
    return ControlWindowSchema.parse(JSON.parse(z.string().parse(text)));
  };
  return {
    async observe(signal) {
      const topId = page === undefined ? undefined : framesOf(page).documentId();
      const text = z.string().parse(await call(signal, () => evaluate(observeJson)));
      const raw = PageObservationSchema.parse(JSON.parse(text));
      return page === undefined || topId === undefined ? raw : await call(signal, () => framesOf(page).includeOutline(raw, topId, read));
    },
    async controlWindow(query) {
      return page === undefined ? read(undefined, query) : framesOf(page).query(query, read);
    },
    async inspectionSearch(fieldId) {
      return InspectionSearchSchema.safeParse(JSON.parse(z.string().parse(
        await evaluate(controlsJson({ searchField: fieldId })),
      ))).data;
    },
  };
}

export function playwrightDriver(page: Page, timeout: number): PageDriver {
  return {
    ...observeWith(script => page.evaluate(script), page),
    async resolve(target, signal) {
      const host = playwrightElement(await playwrightTarget(page, target, signal), signal, timeout);
      return isEmbeddedRef(target.ref) ? embeddedElement(page, target, signal, timeout, host) : host;
    },
    scroll: signal => call(signal, () => page.mouse.wheel(0, 600)),
    async hasVisibleLink(name, signal) {
      const byRole = page.getByRole("link", { name, exact: true }).filter({ visible: true });
      return await call(signal, () => byRole.count()) > 0;
    },
    async hiddenLinkUrls(name, signal) {
      return z.array(z.string()).parse(await call(signal, () => page.locator("a[href]").evaluateAll((anchors, wanted) => {
        const compact = (text: string | null) => (text ?? "").replace(/\s+/g, "");
        return [...new Set(anchors.filter(a => compact(a.textContent) === compact(wanted) &&
          (a.getClientRects().length === 0 || getComputedStyle(a).visibility === "hidden"))
          .map(a => a instanceof HTMLAnchorElement ? a.href : ""))].slice(0, 2);
      }, name)));
    },
  };
}
