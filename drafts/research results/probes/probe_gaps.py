"""observe.js가 실제 사이트에서 놓치는 것을 센다(읽기 전용: 페이지를 열고 세기만 한다)."""
from __future__ import annotations

import asyncio
import json
import sys

from playwright.async_api import async_playwright

from cheongeum.agents.web.browser import OBSERVE_SCRIPT

SITES = sys.argv[1:] or [
    "https://www.bokjiro.go.kr",
    "https://www.gov.kr",
    "https://www.hometax.go.kr",
    "https://www.nps.or.kr",
    "https://www.mohw.go.kr",
    "https://www.nhis.or.kr",
    "https://www.naver.com",
]

PROBE = r"""
(() => {
  const vis = (el) => {
    if (!el || el.closest('[hidden]') || el.closest('[aria-hidden="true"]')) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const q = (sel) => Array.from(document.querySelectorAll(sel)).filter(vis);
  const text = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  const semantic = 'a[href], button, input, select, textarea, [role="button"]';
  const captured = 'a[href], button, [role="button"], input[type="submit"]';
  const linkName = (a) => (text(a) || a.getAttribute('aria-label') || a.getAttribute('title') || '');
  const namelessLinks = q('a[href]').filter((a) => !linkName(a));
  let shadow = 0;
  document.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) shadow++; });
  return {
    iframes: q('iframe').filter((f) => { const r = f.getBoundingClientRect(); return r.width >= 100 && r.height >= 50; }).length,
    tabs: q('[role="tab"]').length,
    expanders: q('[aria-expanded]').length,
    menuitems: q('[role="menuitem"]').length,
    shadowHosts: shadow,
    onclickNonSemantic: q('[onclick]').filter((el) => !el.matches(semantic)).length,
    anchorsNoHref: q('a:not([href])').filter((a) => text(a)).length,
    namelessLinks: namelessLinks.length,
    namelessLinksWithImgAlt: namelessLinks.filter((a) => Array.from(a.querySelectorAll('img')).some((i) => (i.getAttribute('alt') || '').trim())).length,
    tabsUncaptured: q('[role="tab"]').filter((el) => !el.matches(captured)).length,
    tabTags: Array.from(new Set(q('[role="tab"]').map((el) => el.tagName.toLowerCase() + (el.hasAttribute('href') ? '[href]' : '')))).join(','),
    expandersUncaptured: q('[aria-expanded]').filter((el) => !el.matches(captured)).length,
    hiddenTabPanelText: Array.from(document.querySelectorAll('[role="tabpanel"]')).filter((el) => !vis(el)).reduce((n, el) => n + text(el).length, 0),
    pointerUncaptured: q('body *').filter((el) => {
      if (getComputedStyle(el).cursor !== 'pointer') return false;
      if (el.closest(captured + ', label, input, select, textarea')) return false;
      if (el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') return false;
      if (el.querySelector(captured)) return false;
      return !!text(el);
    }).length,
    pointerSamples: q('body *').filter((el) => getComputedStyle(el).cursor === 'pointer' && !el.closest(captured + ', label, input, select, textarea') && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer') && !el.querySelector(captured) && text(el)).slice(0, 5).map((el) => el.tagName.toLowerCase() + ':' + text(el).slice(0, 14)),
    imgsNoAlt: q('img').filter((i) => !(i.getAttribute('alt') || '').trim()).length,
    bodyTextLen: (document.body.innerText || '').length,
  };
})()
"""


async def main() -> None:
    rows = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        for url in SITES:
            ctx = await browser.new_context(locale="ko-KR", viewport={"width": 1100, "height": 860})
            page = await ctx.new_page()
            row: dict = {"site": url}
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                try:
                    await page.wait_for_load_state("networkidle", timeout=3000)
                except Exception:  # noqa: BLE001
                    pass
                await page.wait_for_timeout(1500)
                obs = await page.evaluate(OBSERVE_SCRIPT)
                o = obs.get("outline") or {}
                row["finalUrl"] = page.url
                row["title"] = obs.get("title", "")[:40]
                row["seen"] = {
                    "links": o.get("linkCount"),
                    "buttons": len(o.get("buttons") or []),
                    "fields": len(obs.get("fields") or []),
                    "mainTextLen": len(o.get("mainText") or ""),
                }
                row["missed"] = await page.evaluate(PROBE)
                frames = []
                for f in page.frames:
                    if f is page.main_frame:
                        continue
                    try:
                        n = await f.evaluate("(document.body && document.body.innerText || '').length")
                        k = await f.evaluate("document.querySelectorAll('a[href], button, input, select, textarea').length")
                    except Exception:  # noqa: BLE001
                        n, k = -1, -1
                    frames.append({"url": f.url[:70], "textLen": n, "controls": k})
                row["childFrames"] = frames
            except Exception as e:  # noqa: BLE001
                row["error"] = f"{type(e).__name__}: {str(e)[:120]}"
            rows.append(row)
            await ctx.close()
        await browser.close()
    for r in rows:
        r["childFrames"] = [f for f in r.get("childFrames", []) if f["textLen"] > 100]
        print(json.dumps(r, ensure_ascii=False))


asyncio.run(main())
