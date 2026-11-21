import type { DialogInfo, NoticeFacts, Observation, ObservedField, InteractiveItem, ScreenOutline, ScreenTarget } from "../../../core/actions.ts";
import type { InspectionControl } from "../../../safety/guard.ts";

export interface ControlQuery {
  text?: string; offset?: number; limit?: number; ref?: string | null; refs?: readonly string[]; exact?: boolean;
  inspection?: boolean; destination?: string; searchField?: string;
  /** ref로 찾은 항목이 팝업 안에 있으면 그 팝업의 사실(notice)을 새로 읽어 함께 돌려준다. */
  notice?: boolean;
}
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type RefElement = HTMLElement | SVGElement;
// shadows는 페이지 안에서 알 수 없다(닫힌 shadow root는 스크립트에 보이지 않는다). 어댑터가 브라우저의 DOM 정보로 채운다.
type PageNotice = Omit<NoticeFacts, "shadows">;
type Item = InteractiveItem & { context?: string; inspection?: InspectionControl; notice?: PageNotice };
type RawObservation = Omit<Observation, "platform" | "capturedAt" | "outline"> &
  { outline?: Omit<ScreenOutline, "screenTarget"> & { screenTarget: ScreenTarget | null } };
declare global {
  interface Window {
    __cheongeumElementRefs?: WeakMap<RefElement, { ref: string; href: string | null; context?: string }>;
    __cheongeumRefSeq?: number;
  }
}

/** Keep runtime values inside this function: Playwright executes it in the observed page's realm. */
export function observePage(query: ControlQuery | null = null) {
  // XML documents and pages without a body still have observable controls.
  const body = document.body instanceof HTMLElement ? document.body : null;
  const first = (...choices: (string | null | undefined)[]) => choices.find(s => s !== undefined && s !== null && s.length > 0) ?? "";
  const elementValue = (el: Element) => "value" in el && typeof el.value === "string" ? el.value : "";
  const inner = (el: Element) => el instanceof HTMLElement ? el.innerText : "";
  const disabled = (el: Element) => "disabled" in el && el.disabled === true;
  const control = (el: Element | null | undefined): el is Control => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
  const text = (el: Node | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const isVisible = (el: Element | null | undefined) => {
    if (!el || el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  // 외부 사이트 입력란은 id가 없는 경우가 많아 관찰할 때 임시 ID를 붙여 다시 찾을 수 있게 한다.
  let seq = 0;
  const idOf = (c: HTMLElement) => {
    if (c.id.length > 0) return c.id;
    if ((c.dataset.cheongeumId ?? "").length === 0) c.dataset.cheongeumId = 'cheongeum-' + (++seq) + '-' + Math.random().toString(36).slice(2, 6);
    return c.dataset.cheongeumId!;
  };
  const refs = window.__cheongeumElementRefs ??= new WeakMap();
  const refOf = (el: RefElement, context?: string) => {
    const previous = refs.get(el);
    const href = el instanceof HTMLAnchorElement ? el.href : null;
    if (previous && previous.href === href && el.dataset.cheongeumRef === previous.ref
      && (context === undefined || previous.context === undefined || previous.context === context)) {
      if (context !== undefined) previous.context = context;
      return previous.ref;
    }
    window.__cheongeumRefSeq = (window.__cheongeumRefSeq ?? 0) + 1;
    const ref = 'r' + window.__cheongeumRefSeq + '-' + Math.random().toString(36).slice(2, 6);
    el.dataset.cheongeumRef = ref;
    refs.set(el, { ref, href, context });
    return ref;
  };
  if (query?.searchField !== undefined) {
    const id = CSS.escape(query.searchField);
    const matches = Array.from(document.querySelectorAll('[id="' + id + '"], [data-cheongeum-id="' + id + '"]')).filter(isVisible);
    const [el] = matches;
    const form = el instanceof HTMLInputElement ? el.form : null;
    const valid = matches.length === 1 && el instanceof HTMLInputElement && form !== null && !el.matches(':disabled') &&
      !el.readOnly && el.name.length > 0 && (el.type === 'search' || (el.type === 'text' && el.getAttribute('role') === 'searchbox' &&
        form.getAttribute('role') === 'search')) && !/password|one-time-code|cc-/i.test(el.autocomplete) &&
      form.getAttribute('method')?.toLowerCase() === 'get' &&
      Array.from(form.elements).every(other => other === el ||
        !(control(other) || other instanceof HTMLButtonElement) || other.name.length === 0 ||
        other.matches(':disabled') || ['submit', 'button', 'reset'].includes(other.type));
    if (!valid) return { url: location.href };
    // Bind the live form instance as well as the field, method, and parameter.
    return { url: location.href, destination: form.action, parameter: el.name,
      signature: JSON.stringify([refOf(el), refOf(form), el.type, el.name, form.action, form.method]) };
  }
  const controls = query ? [] : Array.from(document.querySelectorAll<Control>('input, select, textarea'))
    .filter((c) => c.type !== 'hidden' && c.type !== 'submit' && c.type !== 'button' && c.type !== 'image' && c.type !== 'reset')
    .filter((c) => c.id.length > 0 || isVisible(c))
    .slice(0, 60);
  const fields = controls.map((c) => {
    const isSelect = c instanceof HTMLSelectElement;
    const type = isSelect ? 'select' : (c.tagName === 'TEXTAREA' ? 'textarea' : first(c.type, 'text'));
    const sensitive = type === 'password' || c.getAttribute('autocomplete') === 'one-time-code';
    const isCheck = c instanceof HTMLInputElement && (type === 'checkbox' || type === 'radio');
    let value = '';
    if (isSelect) value = c.value !== '' && c.selectedIndex >= 0 ? text(c.options[c.selectedIndex]) : '';
    else if (isCheck) value = c.checked ? '예' : '아니오';
    else if (!sensitive) value = c.value;
    const errId = c.getAttribute('aria-errormessage');
    const errEl = errId !== null && errId.length > 0 ? document.getElementById(errId) : null;
    const invalid = c.getAttribute('aria-invalid') === 'true';
    const label = (c.labels?.length ?? 0) > 0 ? text(c.labels?.[0])
      : first(c.getAttribute('aria-label'), c.getAttribute('title'), c.getAttribute('placeholder'), c.name, '이름 없는 입력란');
    const field: ObservedField = {
      fieldId: idOf(c),
      label: label.slice(0, 80),
      type,
      required: !!c.required,
      visible: isVisible(c),
      value: String(value).slice(0, 200),
      filled: isCheck ? c.checked : c.value !== '',
      invalid,
      sensitive,
    };
    const role = c.getAttribute('role');
    const hay = [label, c.getAttribute('placeholder'), c.name, c.id].join(' ');
    if (!sensitive && (type === 'search' || role === 'searchbox' || role === 'combobox' && /검색|search|query/i.test(hay) || /검색|search|query|keyword/i.test(hay))) field.searchable = true;
    if (invalid && errEl && text(errEl).length > 0) field.error = text(errEl);
    const hint = (c.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
      .map((id) => document.getElementById(id)).filter((el) => el !== null && el !== errEl && isVisible(el)).map(text).join(' ');
    if (hint.length > 0) field.hint = hint.slice(0, 200);
    if (isSelect) field.options = Array.from(c.options).filter((o) => o.value !== '').map((o) => text(o)).slice(0, 30);
    return field;
  });
  const result: RawObservation = {
    url: location.href,
    title: document.title,
    fields,
    errors: Array.from(document.querySelectorAll('[role="alert"]')).filter(isVisible).map(text).filter(Boolean).slice(0, 5),
    dialogs: [], // 팝업은 본문 영역(mainEl)을 정한 뒤 아래에서 채운다.
  };
  const current = document.querySelector('[aria-current="step"]');
  let steps: string[] = [];
  if (current && current.parentElement && isVisible(current)) {
    const sibs = Array.from(current.parentElement.children);
    result.step = { index: sibs.indexOf(current) + 1, total: sibs.length, name: text(current) };
    steps = sibs.map(text);
  }
  const inDialog = (el: Element) => !!el.closest('[role="dialog"], [role="alertdialog"], dialog');
  const linkEls = query ? [] : Array.from(document.querySelectorAll('a[href], [role="link"]')).filter((a) => isVisible(a) && !a.classList.contains('skip-link'));
  const imgAlt = (el: Element) => {
    const img = Array.from(el.querySelectorAll('img[alt]')).find((i) => (i.getAttribute('alt') ?? '').trim().length > 0);
    return img?.getAttribute('alt')?.trim() ?? '';
  };
  const nameOf = (el: Element) => first(text(el), el.getAttribute('aria-label'), imgAlt(el), el.getAttribute('title'), elementValue(el))
    .replace(/\s+/g, ' ').trim().slice(0, 60);
  const linkName = nameOf;
  const uniq = (arr: (string | null | undefined)[]) => [...new Set(arr.filter((s): s is string => s !== undefined && s !== null && s.length > 0))];
  const linkNames = linkEls.map(linkName).filter(Boolean);
  // 본문: main → article → [role=main] → body 순서. 머리말·탐색·꼬리말·스크립트 제외.
  // 공공 누리집은 접근성 지침상 '본문 바로가기' 링크가 있어, 그 목적지를 본문으로 쓴다(semantic main이 없을 때).
  const skip = Array.from(document.querySelectorAll('a[href^="#"]'))
    .find((a) => (a.getAttribute('href') ?? '').length > 1 && /본문|컨텐츠|콘텐츠|content|main/i.test(text(a) + ' ' + a.getAttribute('href')));
  let skipTarget: HTMLElement | null = null;
  if (skip) {
    try { skipTarget = document.getElementById(decodeURIComponent(skip.getAttribute('href')!.slice(1))); } catch (e) { skipTarget = null; }
  }
  const usable = (el: Element | null) => el !== null && isVisible(el) && inner(el).trim().length > 30;
  const firstUsable = (selector: string) => [...document.querySelectorAll(selector)].find(usable);
  const mainEl = [...document.querySelectorAll('main, [role="main"]')].find(isVisible)
    || (usable(skipTarget) ? skipTarget : null)
    || firstUsable('#contents, #content, #contentArea, #contentsWrap')
    || firstUsable('article')
    || body;
  // 팝업 사실: ARIA 대화상자·<dialog>와 화면 위에 뜬 레이어 팝업을 한 목록(최대 3개)으로 모은다. 조회 전용 질의(query)에서는 만들지 않는다(notice 질의는 예외).
  // 애매하면 팝업으로 세지 않고, 팝업이어도 입력이 있는 쪽으로 기울인다. 확실하지 않을 때는 지금처럼 사용자에게 묻게 하려는 것이다.
  const BUTTONISH = 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]';
  // 입력 칸·양식. 안을 볼 수 없는 iframe·embed·object도 입력이 있는 것으로 센다.
  const FIELDISH = 'form, [role="form"], select, textarea, iframe, embed, object, [contenteditable]:not([contenteditable="false"]), '
    + 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]), '
    + '[role="textbox"], [role="combobox"], [role="searchbox"], [role="listbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="spinbutton"]';
  // 레이어 팝업의 단서는 닫기 계열 이름뿐이다. '확인'은 하단 고정 줄의 제출 단추와 구분되지 않아 단서로 쓰지 않는다.
  const CLOSE_NAME = /^(?:x|×|✕|✖|╳|닫기|닫음|close)$|(?:닫기|닫음)$|(?:열지|보지|보이지)(?:않|말)/i;
  // 조회 질의는 팝업을 만들지 않지만, notice 질의(누르기 직전 안내 팝업 확인)는 같은 규칙으로 팝업을 새로 읽는다.
  const wantPopups = !query || query.notice === true;
  const ariaPopups: Element[] = !wantPopups ? [] : Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')).filter(isVisible);
  // 레이어의 몸통: 닫기 단추의 조상 가운데 화면 안에서 겹쳐 뜬(fixed·absolute, z-index 1 이상) 상자.
  // 제목줄 같은 안쪽 상자를 잡으면 입력 칸을 놓치므로 조건을 만족하는 가장 바깥 조상을 쓴다.
  const layerRoot = (closeControl: Element): Element | null => {
    let found: Element | null = null;
    for (let el = closeControl.parentElement; el !== null && el !== body && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      const absolute = style.position === 'absolute';
      if ((!absolute && style.position !== 'fixed') || !(parseInt(style.zIndex, 10) > 0)) continue;
      if (!isVisible(el) || el.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')) continue;
      if (mainEl !== null && mainEl !== body && el.contains(mainEl)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 50 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
      if (absolute && rect.width * rect.height > innerWidth * innerHeight * 0.85) continue;
      found = el;
    }
    return found;
  };
  const layerPopups: Element[] = [];
  if (wantPopups) {
    const closers = Array.from(document.querySelectorAll(BUTTONISH + ', a'))
      .filter((c) => (c.textContent ?? '').length < 40 && CLOSE_NAME.test(nameOf(c).replace(/\s+/g, '')) && isVisible(c))
      .slice(0, 40);
    for (const closer of closers) {
      const root = layerRoot(closer);
      if (root !== null && !layerPopups.includes(root)) layerPopups.push(root);
    }
  }
  // 이미 대화상자인 상자(가리개가 감싸는 경우 포함)와 다른 레이어 안에 든 레이어는 따로 세지 않는다.
  const popups = [...ariaPopups, ...layerPopups.filter((layer) => !ariaPopups.some((d) => d.contains(layer) || layer.contains(d))
    && !layerPopups.some((other) => other !== layer && other.contains(layer)))].slice(0, 3);
  const popupTitle = (el: Element) => {
    const lid = el.getAttribute('aria-labelledby');
    const named = lid !== null && lid.length > 0 ? text(document.getElementById(lid)) : (el.getAttribute('aria-label') ?? '');
    return (named.length > 0 || ariaPopups.includes(el) ? named : text(el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]'))).slice(0, 100);
  };
  // 단추가 속한 양식: 팝업 안의 <form> 조상이든 밖의 양식을 가리키는 button[form]이든 그 양식을 보낼 수 있다.
  // form 속성이 있으면 짝이 아직 없어도(나중에 생길 수 있다) 센다. 보이지 않는 단추도 센다.
  const formBound = (b: Element) => (b instanceof HTMLButtonElement || b instanceof HTMLInputElement) && (b.form !== null || b.hasAttribute('form'));
  // 열린 shadow root 안은 querySelector로 볼 수 없다. 안에 무엇이 있는지 모르므로 입력이 있는 것으로 센다.
  // 닫힌 root는 페이지 안에서 알 수 없다: 안내 팝업 증명에서는 어댑터가 브라우저(CDP)의 DOM 정보로 따로 세어 NoticeFacts.shadows에 담는다.
  const hasShadow = (d: Element) => d.shadowRoot !== null || Array.from(d.querySelectorAll('*')).some((e) => e.shadowRoot !== null);
  result.dialogs = popups.map((d): DialogInfo => {
    const buttonEls = Array.from(d.querySelectorAll(BUTTONISH));
    return {
      title: popupTitle(d),
      text: text(d).slice(0, 300),
      // 링크 모양 닫기('<a>닫기</a>')는 단추 목록이 아니라 outline.items에서 dialog 번호로 찾는다.
      // 보이는 단추는 이름이 없어도(빈 문자열), 이름이 같아도 하나씩 남긴다. 6개를 넘으면 앞 6개만 남지만 그래도 둘 이상이다.
      buttons: buttonEls.filter(isVisible).map(nameOf).slice(0, 6),
      // 입력 칸·양식·속을 못 보는 요소, 어떤 양식에 속한 단추(앞 6개 밖의 단추 포함)가 하나라도 있으면 입력이 있는 것으로 센다.
      hasInputs: d.querySelector(FIELDISH) !== null || d.closest('form') !== null || buttonEls.some(formBound) || hasShadow(d),
      kind: ariaPopups.includes(d) ? 'dialog' : 'layer',
    };
  });
  // 요소가 든 가장 안쪽 팝업의 번호. 팝업 밖이면 -1.
  const dialogOf = (el: Element) => {
    let at = -1;
    popups.forEach((d, i) => { if (d !== el && d.contains(el) && (at < 0 || popups[at]!.contains(d))) at = i; });
    return at;
  };
  let mainText = '';
  const pictureMask = 'input, textarea, select, [contenteditable], iframe, embed, object';
  const visualSelector = 'canvas, svg, img, video, [role="img"]';
  const excludedTarget = pictureMask + ', [hidden], [aria-hidden="true"], script, style, template';
  const accessibleText = (el: Element | null | undefined) => {
    if (!el || el.closest(excludedTarget) || el.querySelector(pictureMask)) return '';
    return first(inner(el), el instanceof SVGElement ? text(el) : '').trim().replace(/\s+/g, ' ').slice(0, 400);
  };
  const visualLabel = (el: Element) => {
    const refText = (attr: string) => (el.getAttribute(attr) ?? '').split(/\s+/).slice(0, 4)
      .map(id => accessibleText(document.getElementById(id))).filter(Boolean).join(' ');
    return uniq([refText('aria-labelledby'), el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title'),
      refText('aria-describedby'), accessibleText(el.querySelector(':scope > title')), accessibleText(el.querySelector(':scope > desc')),
      accessibleText(el.closest('figure')?.querySelector('figcaption'))]).join(' ').trim().slice(0, 400);
  };
  const targetOf = (element: Element | null | undefined, kind: "focus" | "hover"): ScreenTarget | null => {
    if (control(element) && element.matches('input:not([type="hidden"]), textarea, select') && isVisible(element)) {
      const label = first(Array.from(element.labels ?? []).map(accessibleText).filter(Boolean).join(' '), visualLabel(element));
      return label.length > 0 ? {kind, role: element.localName, label: label.slice(0, 400), text: ''} : null;
    }
    if (!element || element.closest(excludedTarget)) return null;
    const semantic = element.closest(visualSelector + ', a, button, label, summary, p, li, dt, dd, th, td, figcaption, h1, h2, h3, h4, h5, h6, [role="button"], [role="link"], [tabindex], span');
    const el = semantic || (element.matches('div') && element.childElementCount === 0 ? element : null);
    if (!el || el === body || !isVisible(el) || el.querySelector(pictureMask)) return null;
    const label = visualLabel(el);
    const role = first(el.getAttribute('role'), el.localName);
    const targetText = inner(el).trim().replace(/\s+/g, ' ').slice(0, 400);
    if (label.length === 0 && targetText.length === 0 && !el.matches(visualSelector)) return null;
    const rect = el.getBoundingClientRect();
    const position = `center x=${Math.round(rect.left + scrollX + rect.width / 2)}, y=${Math.round(rect.top + scrollY + rect.height / 2)} CSS px`;
    return {kind, role, label, text: targetText, position};
  };
  const selectedTarget = (): ScreenTarget | null => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const root = range.commonAncestorContainer;
    const el = root instanceof Element ? root : root.parentElement;
    if (!el || !isVisible(el) || el.closest(excludedTarget)) return null;
    if (Array.from(el.querySelectorAll(excludedTarget)).some(node => range.intersectsNode(node))) return null;
    const selected = selection.toString().trim().replace(/\s+/g, ' ').slice(0, 400);
    return selected.length > 0 ? {kind: 'selection', role: el.localName, text: selected, label: ''} : null;
  };
  const hovered = document.querySelectorAll(':hover');
  const screenTarget = query ? null : selectedTarget() || targetOf(document.activeElement, 'focus') || targetOf(hovered[hovered.length - 1], 'hover');
  const graphics = query ? [] : Array.from((mainEl || document).querySelectorAll(visualSelector)).filter(el => {
    if (!isVisible(el) || el.closest(excludedTarget) || el.matches('[role="presentation"], [role="none"], img[alt=""]')) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 40 && rect.height >= 40;
  });
  if (!query && mainEl) {
    // 공공 포털은 본문 전체를 form으로 감싸기도 한다. 입력값과 숨은 레이어는 제외하고 화면에 보이는 안내만 읽는다.
    const skipText = 'script, style, noscript, template, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-hidden="true"], [hidden], button, ' + pictureMask;
    const chromeName = /(^|[\s_-])(header|gnb|lnb|snb|nav|menu|footer|skip|util|quick|top-?bar|sitemap|family|banner|popup|layer)([\s_-]|$)/i;
    const pieces: string[] = [];
    function readText(node: Node) {
      if (node.nodeType === Node.TEXT_NODE) { pieces.push(node.nodeValue ?? ""); return; }
      if (!(node instanceof Element) || node.matches(skipText)) return;
      if (mainEl === body && chromeName.test(node.id + ' ' + (typeof node.className === 'string' ? node.className : ''))) return;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const start = pieces.length;
      for (const child of node.childNodes) readText(child);
      // A short definition or table cell is one passage, including its nested list and exceptions.
      if (node.tagName === 'DD' || node.tagName === 'TD') {
        const cell = pieces.slice(start).join('').replace(/\s+/g, ' ').trim();
        if (cell.length > 0 && cell.length <= 500) pieces.splice(start, pieces.length - start, cell);
      }
      if (/^(P|DIV|LI|H[1-6]|TR|SECTION|ARTICLE|DT|DD|BR)$/.test(node.tagName)) pieces.push('\n');
      else if (/^(A|SPAN|TD|TH)$/.test(node.tagName)) pieces.push(' ');
    }
    if (!mainEl.closest(pictureMask)) readText(mainEl);
    mainText = pieces.join('')
      .replace(/<[^>]{0,80}>/g, ' ') // 일부 사이트는 태그 문자열을 그대로 노출한다
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 20000);
  }
  // 꼬리말 글: 대표번호·주소 같은 연락처는 흔히 여기에만 있다. 본문(mainText)에서는 빼므로 따로 담고, 메뉴 링크 글자는 뺀다.
  // 사이트 꼬리말만: 기사·카드 안의 <footer>(작성일·조회수)는 제외한다.
  const footerEls = query ? [] : Array.from(document.querySelectorAll('footer, [role="contentinfo"]'))
    .filter((el) => isVisible(el) && !inDialog(el))
    .filter((el) => el.getAttribute('role') === 'contentinfo' || !(el.parentElement && el.parentElement.closest('article, aside, main, nav, section')));
  const footerText = footerEls
    .filter((el) => !footerEls.some((o) => o !== el && o.contains(el)))
    .map((el) => {
      const clone = el.cloneNode(true);
      if (!(clone instanceof Element)) return "";
      clone.querySelectorAll('script, style, noscript, nav, button, select, [aria-hidden="true"], [hidden], a:not([href^="tel:"])').forEach((n) => n.remove());
      const rows = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      while (rows.nextNode()) if (rows.currentNode instanceof Text) rows.currentNode.data = rows.currentNode.data.replace(/\s+/g, ' ');
      clone.querySelectorAll('span').forEach((n) => n.append(' '));
      clone.querySelectorAll('p, div, li, dt, dd, br, address').forEach((n) => n.append('\n'));
      return (clone.textContent ?? '').split('\n').map((row) => row.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join(' / ')
    .slice(0, 600);
  const CANDIDATE = 'a[href], button, summary, input[type="submit"], input[type="button"], [role="link"], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
  const INTERACTIVE = CANDIDATE + ', input, select, textarea, label';
  const TAG_ROLE: Record<string, InteractiveItem["role"]> = { A: 'link', BUTTON: 'button', SUMMARY: 'button', INPUT: 'button' };
  // 주소창이 해석한 프로토콜로 본다: java&#9;script: 같은 변형도 javascript:로 걸러진다
  const navigatesByHref = (el: Element) => el instanceof HTMLAnchorElement && /^\s*[^#\s]/.test(el.getAttribute('href') ?? '') && el.protocol !== 'javascript:';
  const structuralTab = (el: Element) => !!el.closest('[role="tablist"]') || el.hasAttribute('aria-controls') || el.hasAttribute('aria-selected');
  const roleOf = (el: Element): InteractiveItem["role"] => {
    const r = el.getAttribute('role');
    if (r === 'tab' && structuralTab(el)) return 'tab';
    if (navigatesByHref(el)) return 'link';
    if (r === 'button' || r === 'tab') return 'button';
    if (r === 'menuitem' || r === 'menuitemcheckbox' || r === 'menuitemradio') return 'menuitem';
    if (r === 'link' || el.tagName === 'A') return 'scriptlink';
    return TAG_ROLE[el.tagName] ?? 'generic';
  };
  const inspect = (el: RefElement, context: string): InspectionControl => {
    const rawHref = el.getAttribute('href');
    const anchor = el instanceof HTMLAnchorElement;
    const href = anchor && ['http:', 'https:'].includes(el.protocol) && (rawHref?.trim().length ?? 0) > 0 ? el.href : undefined;
    const form = el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.form : el.closest('form');
    const htmlRole = el.getAttribute('role');
    const type = el instanceof HTMLButtonElement || el instanceof HTMLInputElement ? el.type : null;
    const disclosure = el instanceof HTMLElement && el.tagName === 'SUMMARY' &&
      el.parentElement instanceof HTMLDetailsElement && el.parentElement.querySelector(':scope > summary') === el;
    const actions: Array<[string, string]> = [];
    for (let node: Element | null = el; node !== null; node = node.parentElement) {
      for (const attr of node.attributes) {
        if (/^on(?:click|pointer|mouse|key)|^data-(?:action|confirm|(?:[\w-]+-)?method)$/i.test(attr.name)) {
          actions.push([attr.name, attr.value]);
        }
      }
    }
    const download = el.hasAttribute('download');
    const signature = JSON.stringify([
      el.tagName, htmlRole, type, rawHref, href, el.getAttribute('target'), el.getAttribute('ping'), download, actions,
      form?.action, form?.method, el.getAttribute('aria-controls'), el.getAttribute('aria-haspopup'), context,
    ]);
    const unsupportedScheme = rawHref !== null && anchor && href === undefined && !['javascript:', ''].includes(el.protocol);
    const writeAction = /\b(?:submit|requestSubmit|delete|logout|signout|pay|purchase|checkout|send|approve|upload|withdraw)\b/i;
    const declaredWrite = actions.some(([key, value]) => key.endsWith('method') ? !/^get$/i.test(value) : writeAction.test(value)) ||
      (rawHref !== null && href === undefined && writeAction.test(rawHref));
    const formSubmit = type === 'submit' || type === 'image' || type === 'reset';
    const privateForm = form?.querySelector('input[type="password"], input[autocomplete="one-time-code"], input[autocomplete^="cc-"]');
    const changesSelection = htmlRole === 'menuitemcheckbox' || htmlRole === 'menuitemradio';
    const externalTarget = href === undefined && (el.getAttribute('target')?.toLowerCase() ?? '_self') !== '_self';
    if (unsupportedScheme || download || declaredWrite || (form !== null && formSubmit) || privateForm || changesSelection || externalTarget) {
      return { kind: 'blocked', ...(href === undefined ? {} : { href }), signature };
    }
    const passive = actions.length === 0 && form === null && !el.hasAttribute('aria-haspopup') && !el.hasAttribute('aria-controls');
    if (href !== undefined && passive && !el.hasAttribute('ping') && (htmlRole === null || htmlRole === 'link')) {
      return { kind: 'navigation', href, signature };
    }
    if (disclosure && passive) return { kind: 'disclosure', signature };
    return { kind: 'ambiguous', ...(href === undefined ? {} : { href }), signature };
  };
  const MENU_AREA = 'nav, header, [role="navigation"], [role="banner"]';
  const OUT_AREA = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';
  // Only title links or result-list entries get a result number. Page navigation has its own order.
  const resultArea = '#results, #result-list, #search, #rso, #b_results, #main_pack, .search-results, [data-testid="web-vertical"], [aria-label*="검색 결과"], [aria-label*="search results" i]';
  const resultTitle = 'h2, h3, [role="heading"]';
  const isSearchResult = (el: Element) => {
    if (!(el instanceof HTMLAnchorElement) || !/^https?:$/.test(el.protocol) || el.closest(OUT_AREA + ', aside, form, [role="search"]')) return false;
    if (!el.closest(resultArea)) return false;
    return !!(el.closest(resultTitle) || el.querySelector(resultTitle) ||
      el.matches('a.title_link, a.link_tit, [data-testid="result-title-a"]') ||
      el.closest('#results li, #result-list li, .search-results li'));
  };
  const regionOf = (el: Element) => {
    if (el.closest(MENU_AREA)) return 'menu';
    if (!el.closest(OUT_AREA) && mainEl && (mainEl === body || mainEl.contains(el))) return 'main';
    return 'other';
  };
  const pointer = (el: Element | null) => !!el && el.nodeType === 1 && getComputedStyle(el).cursor === 'pointer';
  const pointerRoot = (el: Element) => pointer(el) && !pointer(el.parentElement);
  // 안내 팝업 증명에 쓰는 사실: 이 단추가 든 팝업을 지금 다시 읽는다. 팝업 몸통·이 단추의 ref와 글 전체를 서명에 넣어, 팝업이 바뀌거나 다른 것으로 갈아 끼워지면 달라진다.
  // 입력 칸·양식·속을 못 보는 틀은 hasInputs로, 이 단추 밖의 조작 요소(링크·입력·라벨·탭 포함)는 others로 센다. 애매하면 안내가 아닌 쪽 값이 나온다.
  const noticeOf = (root: Element, control: RefElement, controlRef: string): PageNotice => {
    const buttonEls = Array.from(root.querySelectorAll(BUTTONISH));
    const names = buttonEls.filter(isVisible).map(nameOf);
    const full = text(root);
    const others = Array.from(root.querySelectorAll(INTERACTIVE)).filter((x) => x !== control && isVisible(x)).length;
    const hasInputs = root.querySelector(FIELDISH) !== null || root.closest('form') !== null || buttonEls.some(formBound) || hasShadow(root);
    const rootRef = root instanceof HTMLElement || root instanceof SVGElement ? refOf(root) : '';
    const kind = ariaPopups.includes(root) ? 'dialog' : 'layer';
    const title = popupTitle(root);
    const buttons = names.slice(0, 6);
    return {
      kind, title, text: full.slice(0, 600), textLength: full.length, buttons, buttonCount: names.length, others, hasInputs, popups: popups.length,
      signature: JSON.stringify([kind, title, full.slice(0, 2000), full.length, rootRef, buttons, names.length, others, hasInputs, popups.length, controlRef]),
      root: rootRef,
    };
  };
  const items: Item[] = [];
  let links = 0;
  let others = 0;
  let generics = 0;
  let matching = 0;
  const needle = (query?.text ?? '').trim().toLocaleLowerCase().replace(/\s+/g, '');
  const requestedRefs = query?.ref !== undefined && query.ref !== null && query.ref.length > 0 ? [query.ref] : query?.refs;
  const candidates = requestedRefs === undefined ? (body ? body.getElementsByTagName('*') : [])
    : requestedRefs.length === 0 ? [] : document.querySelectorAll(requestedRefs.map(ref => '[data-cheongeum-ref="' + CSS.escape(ref) + '"]').join(','));
  for (const el of candidates) {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
    const standard = el.matches(CANDIDATE);
    if (standard) {
      if (el.classList.contains('skip-link')) continue;
    } else {
      if (generics >= 20 || !pointerRoot(el)) continue;
      if (el.closest(INTERACTIVE) || el.querySelector(INTERACTIVE)) continue;
      const t = text(el);
      if (t.length < 2 || t.length > 60) continue;
    }
    const role = standard ? roleOf(el) : 'generic';
    const linkish = role === 'link' || role === 'scriptlink';
    if (!query && (linkish ? links >= 400 : others >= 300)) continue;
    if (!isVisible(el)) continue;
    const name = nameOf(el);
    if (name.length === 0) continue;
    if (query?.destination !== undefined && (!(el instanceof HTMLAnchorElement) || el.href !== query.destination)) continue;
    let context = '';
    if (query) {
      if (disabled(el) || el.getAttribute('aria-disabled') === 'true') continue;
      // 같은 '자세히 보기' 링크를 어느 제도·표 행에 속하는지로 구분한다. 입력값은 읽지 않는다.
      const row = el.closest('li, tr, article, [role="row"], [role="listitem"]');
      if (row && !row.closest(pictureMask)) {
        const label = row.querySelector('h1, h2, h3, h4, th, [role="heading"]');
        const detail = first(accessibleText(label), row.querySelectorAll(CANDIDATE).length < 5 ? accessibleText(row) : '');
        context = detail.slice(0, 120);
      }
      const compact = (query.exact === true ? name : name + ' ' + context).toLocaleLowerCase().replace(/\s+/g, '');
      if (needle.length > 0 && (query.exact === true ? compact !== needle : !compact.includes(needle))) continue;
      if (matching++ < (query.offset ?? 0)) continue;
      if (items.length >= (query.limit === undefined || query.limit === 0 ? 1 : query.limit)) break;
    }
    if (linkish) links++;
    else others++;
    if (!standard) generics++;
    const item: Item = { ref: refOf(el, query ? context : undefined), role, name, region: regionOf(el), disabled: !!disabled(el) || el.getAttribute('aria-disabled') === 'true' };
    if (context.length > 0 && context !== name) item.context = context;
    if (query?.inspection === true) item.inspection = inspect(el, context);
    if (el.closest(pictureMask) || el.querySelector(pictureMask)) item.pictureMasked = true;
    if (role === 'link' && isSearchResult(el)) item.searchResult = true;
    const popup = popups.length > 0 ? dialogOf(el) : -1;
    if (popup >= 0) item.dialog = popup;
    if (query?.notice === true && popup >= 0) item.notice = noticeOf(popups[popup]!, el, item.ref);
    const sel = el.getAttribute('aria-selected');
    const cur = el.getAttribute('aria-current');
    if (sel !== null) item.selected = sel === 'true';
    else if (cur !== null && cur !== 'false') item.selected = true;
    // 국내 누리집 관례: 지금 탭을 title/aria-label의 '선택됨'으로 알린다(복지로 상세: title="지원대상 선택됨")
    else if (/선택됨/.test([el, el.parentElement].filter((x): x is RefElement => x !== null).map((x) => (x.getAttribute('title') ?? '') + ' ' + (x.getAttribute('aria-label') ?? '')).join(' '))) item.selected = true;
    const exp = el.getAttribute('aria-expanded');
    if (exp !== null) item.expanded = exp === 'true';
    else if (el.tagName === 'SUMMARY' && el.parentElement) item.expanded = el.parentElement instanceof HTMLDetailsElement && el.parentElement.open;
    items.push(item);
  }
  if (query) return {url: location.href, items, more: matching > (query.offset ?? 0) + items.length};
  const landmarkNames: Record<string, string> = { HEADER: '머리말', NAV: '탐색 메뉴', MAIN: '본문', ASIDE: '보조 영역', FOOTER: '꼬리말', FORM: '입력 양식' };
  const landmarks = uniq(Array.from(document.querySelectorAll('header, nav, main, aside, footer, [role="banner"], [role="navigation"], [role="main"], [role="search"], [role="contentinfo"]'))
    .filter(isVisible)
    .map((el) => {
      const role = el.getAttribute('role');
      const base = role === 'search' ? '검색' : role === 'navigation' ? '탐색 메뉴' : role === 'banner' ? '머리말' : role === 'contentinfo' ? '꼬리말' : role === 'main' ? '본문' : (landmarkNames[el.tagName] ?? el.tagName);
      const name = el.getAttribute('aria-label');
      return name !== null && name.length > 0 ? base + '(' + name.slice(0, 30) + ')' : base;
    })).slice(0, 10);
  result.outline = {
    screenTarget,
    hasVisualContent: graphics.length > 0,
    visualLabels: uniq(graphics.map(visualLabel)).slice(0, 20),
    headings: Array.from(document.querySelectorAll('h1, h2, h3')).filter((h) => isVisible(h) && !inDialog(h)
      && !h.closest(pictureMask) && !h.querySelector(pictureMask))
      .map((h) => ({ level: Number(h.tagName[1]), text: text(h).slice(0, 120) })).filter((h) => h.text.length > 0).slice(0, 40),
    notices: Array.from(document.querySelectorAll('[role="note"], aside, [role="complementary"]')).filter(isVisible)
      .map((n) => ({ label: n.getAttribute('aria-label') ?? '', text: text(n).slice(0, 300) })).filter((n) => n.text.length > 0).slice(0, 5),
    steps,
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter((el) => isVisible(el) && !inDialog(el))
      .map((el) => ({ name: first(text(el), el.getAttribute('aria-label'), elementValue(el)).slice(0, 60), disabled: !!disabled(el) || el.getAttribute('aria-disabled') === 'true' }))
      .filter((x) => x.name.length > 0).slice(0, 80),
    links: linkNames.slice(0, 300),
    linkCount: linkNames.length,
    menuLinks: uniq(linkEls.filter((a) => a.closest('nav, header, [role="navigation"], [role="banner"]')).map(linkName)).slice(0, 40),
    mainLinks: mainEl && mainEl !== body
      ? uniq(linkEls.filter((a) => mainEl.contains(a) && !a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')).map(linkName)).slice(0, 80)
      : uniq(linkEls.filter((a) => !a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')).map(linkName)).slice(0, 80),
    mainText,
    footerText,
    landmarks,
    items,
  };
  const status = Array.from(document.querySelectorAll('[role="status"]')).filter(isVisible).map(text).filter(Boolean).join(' ').slice(0, 300);
  if (status.length > 0) result.status = status;
  return result;
}
