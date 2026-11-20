(arg) => {
  // Some sites scroll their main panel inside a fixed-height shell. Expand only that panel
  // and its ancestors for the capture. The site's styles, scroll offsets and focus survive.
  const stateKey = '__cheongeumFullPage';
  if (arg.restore) {
    const state = window[stateKey];
    if (!state || state.attr !== arg.attr) return;
    state.style.remove();
    for (const { el, top, left } of state.chain) {
      el.removeAttribute(state.attr);
      el.scrollTo({ top, left, behavior: 'instant' });
    }
    scrollTo({ top: state.top, left: state.left, behavior: 'instant' });
    delete window[stateKey];
    return;
  }
  if (window[stateKey] || document.scrollingElement.scrollHeight > innerHeight + 2) return false;
  const main = document.querySelector('main, [role="main"]');
  const panes = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.clientHeight < innerHeight / 2 || el.clientWidth < innerWidth / 2 ||
        el.scrollHeight <= el.clientHeight + 2 || el.closest('dialog, iframe, textarea, select, [contenteditable]')) continue;
    if (!/^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    panes.push(el);
  }
  const primary = main ? panes.filter(el => el === main || el.contains(main) || main.contains(el)) : panes;
  if (primary.length !== 1) return false;
  const chain = [];
  for (let el = primary[0]; el; el = el.parentElement) {
    const positioned = /^(fixed|absolute)$/.test(getComputedStyle(el).position);
    chain.push({ el, top: el.scrollTop, left: el.scrollLeft });
    el.setAttribute(arg.attr, positioned ? 'positioned' : '');
  }
  const style = document.createElement('style');
  style.textContent = `[${arg.attr}] { height:auto !important; max-height:none !important; overflow:visible !important; contain:none !important; }
    [${arg.attr}="positioned"] { position:relative !important; inset:auto !important; }`;
  window[stateKey] = { chain, style, attr:arg.attr, top:scrollY, left:scrollX };
  document.head.appendChild(style);
  return true;
}
