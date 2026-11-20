(arg) => {
  // 사진을 찍기 직전에 화면의 글 조각마다 표시(arg.attr)를 붙이고 글을 돌려준다. arg가 null이면 붙인 표시만 뗀다.
  // 무엇을 가릴지는 여기서 정하지 않는다(agents/web/shot.py). 글·모양은 바꾸지 않는다.
  const KEEP = '__cheongeumShot';
  const marked = window[KEEP];
  if (arg?.verify) return marked?.token === arg.verify && !marked.changed && marked.url === location.href;
  if (marked) {
    marked.observer.disconnect();
    for (const el of marked.els) el.removeAttribute(marked.attr);
    delete window[KEEP];
  }
  if (!arg) return null;

  const SKIP = /^(HEAD|SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const FRAME = /^(IFRAME|EMBED|OBJECT)$/;
  const INLINE = /^(inline|contents|ruby|ruby-text)$/;
  const maskSel = arg.mask.join(', ');
  const hideSel = arg.hide.join(', ');
  const shown = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };

  // 글 조각 = 줄을 이루는 요소(inline이 아닌 가장 가까운 조상) 하나에 이어져 있는 글. 보이지 않는 조각도 담는다:
  // 관찰한 본문(mainText)에는 접힌 글도 들어 있어서, 그 글을 담은 조각이 없으면 가릴 수 없는 글로 판정된다.
  const roots = [document];
  const runs = [];
  const frames = [];
  let inputs = 0;
  let passwords = 0;
  const say = (el, text) => {
    const last = runs[runs.length - 1];
    if (last && last.el === el) last.text += text;
    else runs.push({ el, text });
  };
  const walk = (root, block) => {
    for (const node of root.childNodes) {
      if (node.nodeType === 3) { say(block, node.nodeValue); continue; }
      if (node.nodeType !== 1 || SKIP.test(node.tagName) || (hideSel && node.matches(hideSel))) continue;
      if (node.tagName === 'BR') { say(block, ' '); continue; }
      if (node.tagName === 'INPUT' && node.type === 'password') passwords += 1;
      if (maskSel && node.matches(maskSel)) {
        if (FRAME.test(node.tagName)) frames.push({ src: String(node.src || node.data || ''), shown: shown(node) });
        else if (shown(node)) inputs += 1;
      }
      const own = INLINE.test(getComputedStyle(node).display) ? block : node;
      walk(node, own);
      if (node.shadowRoot) {
        roots.push(node.shadowRoot);
        walk(node.shadowRoot, own);
      }
    }
  };
  walk(document.documentElement, document.documentElement);

  const ids = new Map();
  const blocks = [];
  for (const run of runs) {
    const text = run.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!ids.has(run.el)) {
      ids.set(run.el, 'b' + ids.size);
      run.el.setAttribute(arg.attr, ids.get(run.el));
    }
    blocks.push({ id: ids.get(run.el), text });
  }
  // Playwright adds temporary style and mask elements while taking the screenshot.
  const internal = (node) => node.nodeType === 1 && (node.tagName === 'STYLE' || node.tagName === 'X-PW-GLASS');
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(internal)) continue;
      state.changed = true;
    }
  });
  const state = { token: arg.token, url: location.href, attr: arg.attr, els: Array.from(ids.keys()), observer, changed: false };
  for (const root of roots) observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  window[KEEP] = state;
  return { url: location.href, blocks, frames, inputs, passwords, overlays: hideSel ? document.querySelectorAll(hideSel).length : 0 };
}
