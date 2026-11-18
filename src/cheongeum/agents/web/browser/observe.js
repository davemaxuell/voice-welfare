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
  const linkEls = Array.from(document.querySelectorAll('a[href]')).filter((a) => isVisible(a) && !a.classList.contains('skip-link'));
  const linkName = (a) => (text(a) || a.getAttribute('aria-label') || a.getAttribute('title') || '').slice(0, 60);
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
      .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 4000);
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
      .filter((x) => x.name).slice(0, 40),
    links: linkNames.slice(0, 300),
    linkCount: linkNames.length,
    menuLinks: uniq(linkEls.filter((a) => a.closest('nav, header, [role="navigation"], [role="banner"]')).map(linkName)).slice(0, 40),
    mainLinks: mainEl && mainEl !== document.body
      ? uniq(linkEls.filter((a) => mainEl.contains(a) && !a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')).map(linkName)).slice(0, 80)
      : uniq(linkEls.filter((a) => !a.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')).map(linkName)).slice(0, 80),
    mainText,
    landmarks,
  };
  const status = Array.from(document.querySelectorAll('[role="status"]')).filter(isVisible).map(text).filter(Boolean).join(' ').slice(0, 300);
  if (status) result.status = status;
  return result;
})()