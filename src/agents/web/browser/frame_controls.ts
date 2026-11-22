import { randomUUID } from "node:crypto";
import type { CDPSession, Frame, Locator, Page } from "playwright";
import { InteractiveItemSchema, ScreenOutlineSchema } from "../../../core/actions.ts";
import type { ControlQuery } from "./observe.ts";
import type { ControlWindow } from "./driver.ts";

const registries = new WeakMap<Page, FrameControls>();
export function framesOf(page: Page) {
  let controls = registries.get(page);
  if (controls === undefined) {
    controls = new FrameControls(page);
    registries.set(page, controls);
  }
  return controls;
}

/** 공개 ref는 탭·프레임·문서에 묶인다. 같은 URL로 다시 이동해도 예전 ref는 쓸 수 없다. */
class FrameControls {
  readonly #ids = new Map<Frame, string>();
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
    const forget = (frame: Frame) => {
      for (const known of this.#ids.keys()) {
        for (let current: Frame | null = known; current !== null; current = current.parentFrame()) {
          if (current === frame) { this.#ids.delete(known); break; }
        }
      }
    };
    page.on("framenavigated", forget);
    page.on("framedetached", forget);
  }

  #id(frame: Frame) {
    let id = this.#ids.get(frame);
    if (id === undefined) {
      id = "f-" + randomUUID() + ":";
      this.#ids.set(frame, id);
    }
    return id;
  }
  documentId() { return this.#id(this.page.mainFrame()); }

  owner(ref: string) {
    if (!ref.startsWith("f-")) return {frame: this.page.mainFrame(), local: ref};
    for (const [frame, id] of this.#ids) if (ref.startsWith(id)) return {frame, local: ref.slice(id.length)};
    return undefined;
  }

  origins(ref: string) {
    const frame = this.owner(ref)?.frame;
    if (frame === undefined || !ref.startsWith("f-")) return undefined;
    // 중첩한 문서도 바깥 문서보다 높은 권한을 갖지 않는다. about:srcdoc·blank는 부모의 출처를 쓴다.
    const origins = new Set<string>();
    for (let doc: Frame | null = frame; doc !== null; doc = doc.parentFrame()) {
      const url = URL.parse(doc.url());
      if (url?.protocol === "http:" || url?.protocol === "https:") origins.add(url.origin);
    }
    return [...origins];
  }

  async #state(frame: Frame): Promise<"readable" | "hidden" | "opaque"> {
    if (frame === this.page.mainFrame()) return "readable";
    const parent = frame.parentFrame();
    if (parent === null) return "opaque";
    const parentState = await this.#state(parent);
    if (parentState !== "readable") return parentState;
    const owner = await frame.frameElement();
    let dom: "readable" | "hidden" | "opaque";
    try {
      dom = await owner.evaluate((el): "readable" | "hidden" | "opaque" => {
        if (!(el instanceof Element)) return "opaque";
        let opaque = el.hasAttribute("sandbox");
        if (el.getClientRects().length === 0) return "hidden";
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return "hidden";
        for (let node: Element | null = el; node !== null;) {
          if (node.matches('[hidden], [aria-hidden="true"], [inert]') ||
              getComputedStyle(node).visibility === "hidden" || getComputedStyle(node).display === "none") return "hidden";
          if (node.matches('[contenteditable], [role="textbox"], [role="combobox"]')) opaque = true;
          const root = node.getRootNode();
          if (root instanceof ShadowRoot && root.mode !== "open") opaque = true;
          node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return opaque ? "opaque" : "readable";
      });
    } finally { await owner.dispose(); }
    if (dom !== "readable") return dom;
    return /^(?:https?:\/\/|about:(?:blank|srcdoc)$)/u.test(frame.url()) ? "readable" : "opaque";
  }

  async #visible(frame: Frame): Promise<boolean> {
    return (await this.#state(frame)) === "readable";
  }

  async locator(ref: string): Promise<Locator | undefined> {
    const owner = this.owner(ref);
    if (owner === undefined || !/^[\w-]+$/u.test(owner.local) || !await this.#visible(owner.frame)) return undefined;
    return owner.frame.locator(`[data-cheongeum-ref="${owner.local}"]`).filter({visible: true});
  }

  // SDK 셀렉터는 실행하지 않는다. 앱 ref로 찾은 바로 그 노드의 현재 경로와 비교하는 데만 쓴다.
  async path(ref: string): Promise<string | undefined> {
    const owner = this.owner(ref);
    const locator = await this.locator(ref);
    if (owner === undefined || locator === undefined || await locator.count() !== 1) return undefined;
    let path = await locator.evaluate(nodePath);
    for (let frame = owner.frame; frame.parentFrame() !== null;) {
      const el = await frame.frameElement();
      try { path = await el.evaluate(nodePath) + path; } finally { await el.dispose(); }
      frame = frame.parentFrame()!;
    }
    return "xpath=" + path;
  }

  /** 각 문서의 비공개 영역을 SDK 관찰에서도 제외한다. 숨겨졌거나 읽을 수 없는 프레임은 통째로 제외한다. */
  async ignoredSelectors(mask: string) {
    const result = [mask];
    const visit = async (frame: Frame, prefix: string) => {
      for (const child of frame.childFrames()) {
        const id = this.#id(child).slice(2, -1);
        const owner = await child.frameElement();
        try {
          await owner.evaluate((el, id) => { if (el instanceof Element) el.setAttribute("data-cheongeum-frame", id); }, id);
        } finally { await owner.dispose(); }
        const path = prefix + '[data-cheongeum-frame="' + id + '"]';
        if (await this.#visible(child)) {
          result.push(path + " >> " + mask);
          await visit(child, path + " >> ");
        } else result.push(path);
      }
    };
    await visit(this.page.mainFrame(), "");
    return result;
  }

  async query(query: ControlQuery, read: (frame: Frame, query: ControlQuery) => Promise<ControlWindow>) {
    const top = this.page.mainFrame();
    const topId = this.documentId();
    const frames = this.page.frames();
    const refs = query.ref != null && query.ref !== "" ? [query.ref] : query.refs;
    const limit = query.limit ?? 1;
    if (frames.length === 1 && refs?.some(ref => ref.startsWith("f-")) !== true) {
      const result = await read(top, query);
      return {...result, items:result.items.map(item => item.ref.startsWith("s") ? {...item, ref:topId + item.ref} : item)};
    }
    const offset = query.offset ?? 0;
    const items: ControlWindow["items"] = [];
    const url = this.page.url();
    let more = false;
    for (const frame of frames) {
      const topLevel = frame === top;
      const selected = refs?.flatMap(ref => {
        const owner = this.owner(ref);
        return owner?.frame === frame ? [owner.local] : [];
      });
      if (selected?.length === 0) continue;
      const id = topLevel ? topId : this.#id(frame);
      try {
        if (!await this.#visible(frame)) continue;
        const result = await read(frame, {...query, ref: undefined, refs: selected, offset: 0,
          limit: offset + limit + 1, embedded: !topLevel, notice: topLevel && query.notice});
        if (this.#ids.get(frame) !== id) continue;
        for (const item of result.items) items.push(topLevel && !item.ref.startsWith("s") ? item : {...item, ref:id + item.ref});
        more ||= result.more;
      } catch (error) { if (topLevel) throw error; }
      if (items.length > offset + limit) break;
    }
    return {url, items: items.slice(offset, offset + limit), more: more || items.length > offset + limit};
  }

  async nested(read: (frame: Frame, query: ControlQuery) => Promise<ControlWindow>) {
    const items: ControlWindow["items"] = [];
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const id = this.#id(frame);
      try {
        if (!await this.#visible(frame)) continue;
        const result = await read(frame, {embedded: true, limit: 700 - items.length});
        if (this.#ids.get(frame) !== id) continue;
        for (const item of result.items) items.push({...item, ref: id + item.ref});
      } catch { /* 이동하거나 읽을 수 없는 문서는 건너뛴다. */ }
      if (items.length >= 700) break;
    }
    return items;
  }

  async includeOutline<T extends Record<string, unknown>>(raw: T, topId: string, read: (frame: Frame, query: ControlQuery) => Promise<ControlWindow>) {
    const nested = await this.nested(read);
    const data = raw.outline;
    const shadow = typeof data === "object" && data !== null && "items" in data && Array.isArray(data.items) &&
      data.items.some((i: unknown) => typeof i === "object" && i !== null && "ref" in i && typeof i.ref === "string" && i.ref.startsWith("s"));
    if (nested.length === 0 && !shadow) return raw;
    const outline = ScreenOutlineSchema.parse(raw.outline);
    const items = InteractiveItemSchema.array().parse(nested);
    const links = items.filter(item => item.role === "link" || item.role === "scriptlink");
    const names = links.map(item => item.name);
    const top = (outline.items ?? []).map(i => i.ref.startsWith("s") ? {...i, ref:topId + i.ref} : i);
    return {...raw, outline:{...outline, items:[...top, ...items],
      links:[...outline.links, ...names].slice(0, 300), linkCount:(outline.linkCount ?? outline.links.length) + links.length,
      mainLinks:[...outline.mainLinks ?? [], ...links.filter(i => i.region !== "menu").map(i => i.name)].slice(0, 80),
      menuLinks:[...outline.menuLinks ?? [], ...links.filter(i => i.region === "menu").map(i => i.name)].slice(0, 40),
      buttons:[...outline.buttons, ...items.filter(i => i.role === "button").map(({name, disabled}) => ({name, disabled}))].slice(0, 80),
    }};
  }

  async hasOpaqueContent() {
    // 못 찾았을 때만 닫힌 섀도나 보이는 불투명 프레임의 존재를 확인한다. 숨은 유틸리티 프레임은 건너뛴다.
    for (const frame of this.page.frames()) {
      const state = await this.#state(frame).catch(() => "opaque" as const);
      if (state === "hidden") continue;
      if (state === "opaque") return true;
      if (frame === this.page.mainFrame() || URL.parse(frame.url())?.origin !== URL.parse(this.page.url())?.origin) {
        if (await this.#closedRoots(frame)) return true;
      }
    }
    return false;
  }

  async #closedRoots(frame: Frame) {
    let cdp: CDPSession | undefined;
    try {
      cdp = await this.page.context().newCDPSession(frame === this.page.mainFrame() ? this.page : frame);
      const {root} = await cdp.send("DOM.getDocument", {depth:-1, pierce:true});
      const pending = [root];
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        if (node.shadowRootType === "closed") return true;
        pending.push(...node.children ?? [], ...node.shadowRoots ?? []);
        if (node.contentDocument !== undefined) pending.push(node.contentDocument);
      }
      return false;
    } catch { return true; }
    finally { await cdp?.detach().catch(() => {}); }
  }
}

function nodePath(el: Element) {
  let path = "";
  for (let node: Element | null = el; node !== null;) {
    let index = 1;
    for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
      if (sibling.localName === node.localName) index++;
    }
    const root = node.getRootNode();
    const shadow = node.parentElement === null && root instanceof ShadowRoot;
    path = (shadow ? "//" : "/") + node.localName + "[" + index + "]" + path;
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  return path;
}
