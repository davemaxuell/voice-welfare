(() => {
  const text = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const isVisible = (el) => {
    if (!el || el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  // 외부 사이트 입력란은 id가 없는 경우가 많아 관찰할 때 임시 ID를 붙여 다시 찾을 수 있게 한다.
  let seq = 0;
  const idOf = (c) => {
    if (c.id) return c.id;
    if (!c.dataset.cheongeumId) c.dataset.cheongeumId = 'cheongeum-' + (++seq) + '-' + Math.random().toString(36).slice(2, 6);
    return c.dataset.cheongeumId;
  };
  const controls = Array.from(document.querySelectorAll('input, select, textarea'))
    .filter((c) => c.type !== 'hidden' && c.type !== 'submit' && c.type !== 'button' && c.type !== 'image' && c.type !== 'reset')
    .filter((c) => c.id || isVisible(c))
    .slice(0, 60);
  const fields = controls.map((c) => {
    const isSelect = c.tagName === 'SELECT';
    const type = isSelect ? 'select' : (c.tagName === 'TEXTAREA' ? 'textarea' : (c.type || 'text'));
    const sensitive = type === 'password' || c.getAttribute('autocomplete') === 'one-time-code';
    const isCheck = type === 'checkbox' || type === 'radio';
    let value = '';
    if (isSelect) value = c.value !== '' && c.selectedIndex >= 0 ? text(c.options[c.selectedIndex]) : '';
    else if (isCheck) value = c.checked ? '예' : '아니오';
    else if (!sensitive) value = c.value;
    const errId = c.getAttribute('aria-errormessage');
    const errEl = errId ? document.getElementById(errId) : null;
    const invalid = c.getAttribute('aria-invalid') === 'true';
    const label = c.labels && c.labels.length ? text(c.labels[0])
      : (c.getAttribute('aria-label') || c.getAttribute('title') || c.getAttribute('placeholder') || c.name || '이름 없는 입력란');
    const field = {
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
    if (invalid && errEl && text(errEl)) field.error = text(errEl);
    const hint = (c.getAttribute('aria-describedby') || '').split(' ').filter(Boolean)
      .map((id) => document.getElementById(id)).filter((el) => el && el !== errEl && isVisible(el)).map(text).join(' ');
    if (hint) field.hint = hint.slice(0, 200);
    if (isSelect) field.options = Array.from(c.options).filter((o) => o.value !== '').map((o) => text(o)).slice(0, 30);
    return field;
  });
  const result = {
    title: document.title,
    fields,
    errors: Array.from(document.querySelectorAll('[role="alert"]')).filter(isVisible).map(text).filter(Boolean).slice(0, 5),
    dialogs: Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]'))
      .filter(isVisible)
      .slice(0, 3)
      .map((d) => {
        const lid = d.getAttribute('aria-labelledby');
        return {
          title: (lid ? text(document.getElementById(lid)) : (d.getAttribute('aria-label') || '')).slice(0, 100),
          text: text(d).slice(0, 300),
          buttons: Array.from(d.querySelectorAll('button')).filter(isVisible).map(text).filter(Boolean).slice(0, 6),
        };
      }),
  };
  const current = document.querySelector('[aria-current="step"]');
  let steps = [];
  if (current && current.parentElement && isVisible(current)) {
    const sibs = Array.from(current.parentElement.children);
    result.step = { index: sibs.indexOf(current) + 1, total: sibs.length, name: text(current) };
    steps = sibs.map(text);
  }
  const inDialog = (el) => !!el.closest('[role="dialog"], [role="alertdialog"], dialog');
  const linkEls = Array.from(document.querySelectorAll('a[href], [role="link"]')).filter((a) => isVisible(a) && !a.classList.contains('skip-link'));
  const imgAlt = (el) => {
    const img = Array.from(el.querySelectorAll('img[alt]')).find((i) => (i.getAttribute('alt') || '').trim());
    return img ? img.getAttribute('alt').trim() : '';
  };
  const nameOf = (el) => (text(el) || el.getAttribute('aria-label') || imgAlt(el) || el.getAttribute('title') || (typeof el.value === 'string' ? el.value : '') || '')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
  const linkName = nameOf;
  const uniq = (arr) => arr.filter((v, i, a) => v && a.indexOf(v) === i);
  const linkNames = linkEls.map(linkName).filter(Boolean);
  // 본문: main → article → [role=main] → body 순서. 머리말·탐색·꼬리말·스크립트 제외.
  // 공공 누리집은 접근성 지침상 '본문 바로가기' 링크가 있어, 그 목적지를 본문으로 쓴다(semantic main이 없을 때).
  const skip = Array.from(document.querySelectorAll('a[href^="#"]'))
    .find((a) => (a.getAttribute('href') || '').length > 1 && /본문|컨텐츠|콘텐츠|content|main/i.test(text(a) + ' ' + a.getAttribute('href')));
  let skipTarget = null;
  if (skip) {
    try { skipTarget = document.getElementById(decodeURIComponent(skip.getAttribute('href').slice(1))); } catch (e) { skipTarget = null; }
  }
  const usable = (el) => el && (el.innerText || '').trim().length > 30;
  const mainEl = document.querySelector('main, [role="main"]')
    || (usable(skipTarget) ? skipTarget : null)
    || document.querySelector('article')
    || document.body;
  let mainText = '';
  if (mainEl) {
    const clone = mainEl.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, nav, header, footer, [aria-hidden="true"], [hidden], form, button, select').forEach((n) => n.remove());
    if (mainEl === document.body) {
      // semantic main이 없는 사이트: 머리말·메뉴·꼬리말로 흔히 쓰는 id/class 블록을 뺀다(gnb·lnb 등 국내 누리집 관례 포함).
      clone.querySelectorAll('[role="banner"], [role="navigation"], [role="contentinfo"], [role="search"], [id], [class]').forEach((n) => {
        const key = ((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).toLowerCase();
        if (/(^|[\s_-])(header|gnb|lnb|snb|nav|menu|footer|skip|util|quick|top-?bar|sitemap|family|banner|popup|layer)([\s_-]|$)/.test(key)) n.remove();
      });
    }
    // 분리된 복제본은 innerText가 줄바꿈을 계산하지 않아, 블록 요소 뒤에 줄바꿈을 넣어 낱말이 붙지 않게 한다.
    clone.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, td, th, section, article, dt, dd, br, a, span').forEach((el) => {
      el.append(/^(A|SPAN|TD|TH)$/.test(el.tagName) ? ' ' : '\n');
    });
    mainText = (clone.textContent || '')
      .replace(/<[^>]{0,80}>/g, ' ') // 일부 사이트는 태그 문자열을 그대로 노출한다
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 20000);
  }
  // 꼬리말 글: 대표번호·주소 같은 연락처는 흔히 여기에만 있다. 본문(mainText)에서는 빼므로 따로 담고, 메뉴 링크 글자는 뺀다.
  // 사이트 꼬리말만: 기사·카드 안의 <footer>(작성일·조회수)는 제외한다.
  const footerEls = Array.from(document.querySelectorAll('footer, [role="contentinfo"]'))
    .filter((el) => isVisible(el) && !inDialog(el))
    .filter((el) => el.getAttribute('role') === 'contentinfo' || !(el.parentElement && el.parentElement.closest('article, aside, main, nav, section')));
  const footerText = footerEls
    .filter((el) => !footerEls.some((o) => o !== el && o.contains(el)))
    .map((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script, style, noscript, nav, button, select, [aria-hidden="true"], [hidden], a:not([href^="tel:"])').forEach((n) => n.remove());
      clone.querySelectorAll('p, div, li, dt, dd, br, span, address').forEach((n) => n.append(' '));
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join(' / ')
    .slice(0, 600);
  let refSeq = 0;
  const usedRefs = new Set();
  const refOf = (el) => {
    let r = el.dataset.cheongeumRef;
    // cloneNode로 만든 요소는 원본의 ref까지 복사해 온다
    if (!r || usedRefs.has(r)) {
      r = 'r' + (++refSeq) + '-' + Math.random().toString(36).slice(2, 6);
      el.dataset.cheongeumRef = r;
    }
    usedRefs.add(r);
    return r;
  };
  const CANDIDATE = 'a[href], button, summary, input[type="submit"], input[type="button"], [role="link"], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';
  const INTERACTIVE = CANDIDATE + ', input, select, textarea, label';
  const TAG_ROLE = { A: 'link', BUTTON: 'button', SUMMARY: 'button', INPUT: 'button' };
  // 주소창이 해석한 프로토콜로 본다: java&#9;script: 같은 변형도 javascript:로 걸러진다
  const navigatesByHref = (el) => el.tagName === 'A' && /^\s*[^#\s]/.test(el.getAttribute('href') || '') && el.protocol !== 'javascript:';
  const structuralTab = (el) => !!el.closest('[role="tablist"]') || el.hasAttribute('aria-controls') || el.hasAttribute('aria-selected');
  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r === 'tab' && structuralTab(el)) return 'tab';
    if (navigatesByHref(el)) return 'link';
    if (r === 'button' || r === 'tab') return 'button';
    if (r === 'menuitem' || r === 'menuitemcheckbox' || r === 'menuitemradio') return 'menuitem';
    if (r === 'link' || el.tagName === 'A') return 'scriptlink';
    return TAG_ROLE[el.tagName] || 'generic';
  };
  const MENU_AREA = 'nav, header, [role="navigation"], [role="banner"]';
  const OUT_AREA = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const regionOf = (el) => {
    if (el.closest(MENU_AREA)) return 'menu';
    if (!el.closest(OUT_AREA) && mainEl && (mainEl === document.body || mainEl.contains(el))) return 'main';
    return 'other';
  };
  const pointer = (el) => !!el && el.nodeType === 1 && getComputedStyle(el).cursor === 'pointer';
  const pointerRoot = (el) => pointer(el) && !pointer(el.parentElement);
  const items = [];
  let links = 0;
  let others = 0;
  let generics = 0;
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    if (!el.dataset) continue;
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
    if (linkish ? links >= 400 : others >= 300) continue;
    if (!isVisible(el)) continue;
    const name = nameOf(el);
    if (!name) continue;
    if (linkish) links++;
    else others++;
    if (!standard) generics++;
    const item = { ref: refOf(el), role, name, region: regionOf(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' };
    const sel = el.getAttribute('aria-selected');
    const cur = el.getAttribute('aria-current');
    if (sel !== null) item.selected = sel === 'true';
    else if (cur !== null && cur !== 'false') item.selected = true;
    // 국내 누리집 관례: 지금 탭을 title/aria-label의 '선택됨'으로 알린다(복지로 상세: title="지원대상 선택됨")
    else if (/선택됨/.test([el, el.parentElement].filter(Boolean).map((x) => (x.getAttribute('title') || '') + ' ' + (x.getAttribute('aria-label') || '')).join(' '))) item.selected = true;
    const exp = el.getAttribute('aria-expanded');
    if (exp !== null) item.expanded = exp === 'true';
    else if (el.tagName === 'SUMMARY' && el.parentElement) item.expanded = !!el.parentElement.open;
    items.push(item);
  }
  const landmarkNames = { HEADER: '머리말', NAV: '탐색 메뉴', MAIN: '본문', ASIDE: '보조 영역', FOOTER: '꼬리말', FORM: '입력 양식' };
  const landmarks = Array.from(document.querySelectorAll('header, nav, main, aside, footer, [role="banner"], [role="navigation"], [role="main"], [role="search"], [role="contentinfo"]'))
    .filter(isVisible)
    .map((el) => {
      const role = el.getAttribute('role');
      const base = role === 'search' ? '검색' : role === 'navigation' ? '탐색 메뉴' : role === 'banner' ? '머리말' : role === 'contentinfo' ? '꼬리말' : role === 'main' ? '본문' : (landmarkNames[el.tagName] || el.tagName);
      const name = el.getAttribute('aria-label');
      return name ? base + '(' + name.slice(0, 30) + ')' : base;
    })
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 10);
  result.outline = {
    headings: Array.from(document.querySelectorAll('h1, h2, h3')).filter((h) => isVisible(h) && !inDialog(h))
      .map((h) => ({ level: Number(h.tagName[1]), text: text(h).slice(0, 120) })).filter((h) => h.text).slice(0, 40),
    notices: Array.from(document.querySelectorAll('[role="note"], aside, [role="complementary"]')).filter(isVisible)
      .map((n) => ({ label: n.getAttribute('aria-label') || '', text: text(n).slice(0, 300) })).filter((n) => n.text).slice(0, 5),
    steps,
    buttons: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter((el) => isVisible(el) && !inDialog(el))
      .map((el) => ({ name: (text(el) || el.getAttribute('aria-label') || el.value || '').slice(0, 60), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true' }))
      .filter((x) => x.name).slice(0, 80),
    links: linkNames.slice(0, 300),
    linkCount: linkNames.length,
    menuLinks: uniq(linkEls.filter((a) => a.closest('nav, header, [role="navigation"], [role="banner"]')).map(linkName)).slice(0, 40),
    mainLinks: mainEl && mainEl !== document.body
      ? uniq(linkEls.filter((a) => mainEl.contains(a) && !a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')).map(linkName)).slice(0, 80)
      : uniq(linkEls.filter((a) => !a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')).map(linkName)).slice(0, 80),
    mainText,
    footerText,
    landmarks,
    items,
  };
  const status = Array.from(document.querySelectorAll('[role="status"]')).filter(isVisible).map(text).filter(Boolean).join(' ').slice(0, 300);
  if (status) result.status = status;
  return result;
})()