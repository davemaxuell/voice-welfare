import asyncio, json, sys
from playwright.async_api import async_playwright
JS = r"""
(() => {
  const vis = (el) => { if (!el || el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const text = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const d = (el) => ({ t: text(el).slice(0, 18), role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), cls: (typeof el.className === 'string' ? el.className : '').slice(0, 30), onclick: el.hasAttribute('onclick'), inNav: !!el.closest('nav, header, [role=navigation], [role=banner]'), sel: el.getAttribute('aria-selected'), exp: el.getAttribute('aria-expanded') });
  const noHref = Array.from(document.querySelectorAll('a:not([href])')).filter((a) => vis(a) && text(a));
  const captured = 'a[href], button, [role="button"], input[type="submit"]';
  return {
    noHrefTotal: noHref.length,
    noHrefWithRoleButton: noHref.filter((a) => a.getAttribute('role') === 'button').length,
    noHrefFocusable: noHref.filter((a) => a.hasAttribute('tabindex')).length,
    noHref: noHref.slice(0, 30).map(d),
    buttonsVisible: Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(vis).length,
    hiddenTextLen: Array.from(document.querySelectorAll('main *, #contents *, .contents *')).filter((el) => !vis(el) && el.children.length === 0 && text(el).length > 20).reduce((n, el) => n + text(el).length, 0),
    hasMain: !!document.querySelector('main, [role="main"]'),
    headings: Array.from(document.querySelectorAll('h1,h2,h3,h4')).filter(vis).map((h) => h.tagName + ':' + text(h).slice(0, 20)).slice(0, 20),
  };
})()
"""
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        c = await b.new_context(locale="ko-KR", viewport={"width": 1100, "height": 860})
        p = await c.new_page()
        await p.goto(sys.argv[1], wait_until="domcontentloaded", timeout=15000)
        try: await p.wait_for_load_state("networkidle", timeout=3000)
        except Exception: pass
        await p.wait_for_timeout(1500)
        print(json.dumps(await p.evaluate(JS), ensure_ascii=False))
        await b.close()
asyncio.run(main())
