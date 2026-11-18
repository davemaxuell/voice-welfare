import asyncio, json, sys
from playwright.async_api import async_playwright
from cheongeum.agents.web.browser import OBSERVE_SCRIPT
from cheongeum.agents.web.digest import digest_page, digest_for_llm
async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        for url in sys.argv[1:]:
            c = await b.new_context(locale="ko-KR", viewport={"width": 1100, "height": 860})
            p = await c.new_page()
            await p.goto(url, wait_until="domcontentloaded", timeout=15000)
            try: await p.wait_for_load_state("networkidle", timeout=3000)
            except Exception: pass
            await p.wait_for_timeout(1500)
            obs = await p.evaluate(OBSERVE_SCRIPT)
            view = {**obs, "url": p.url, "pageId": "external"}
            d = digest_page(view)
            out = digest_for_llm(d)
            allb = [x["name"] for x in (obs["outline"]["buttons"])]
            print(json.dumps({"url": p.url[:60], "kind": out["kind"], "buttonsObserved": len(allb), "itemsSentToLlm": [f'{i["kind"]}:{i["name"]}' for i in out["items"]], "buttonsNotSent": [n for n in allb if n not in [i["name"] for i in out["items"]]]}, ensure_ascii=False))
            await c.close()
        await b.close()
asyncio.run(main())
