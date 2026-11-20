"""S2: 뒤에 있는 탭을 앞으로 가져오지 않고 찍을 수 있는가, 가림이 제자리에 떨어지는가. 임시 프로필만 쓴다."""
import asyncio
import io
import sys
import tempfile
import time

from playwright.async_api import async_playwright

HTML = """<html><body style="margin:0;background:#fff;font:20px sans-serif">
<h1 style="margin:20px">기초연금 안내</h1>
<input id="name" value="홍길동" style="position:absolute;left:40px;top:120px;width:300px;height:40px;font-size:24px">
<p id="rrn" style="position:absolute;left:40px;top:200px;margin:0">주민등록번호 900101-1234567</p>
<div id="__cheongeum_cursor" style="position:fixed;left:400px;top:120px;width:40px;height:40px;background:#f00;z-index:2147483647"></div>
</body></html>"""


def pixel(png: bytes, x: int, y: int):
    from PIL import Image

    im = Image.open(io.BytesIO(png)).convert("RGB")
    return im.getpixel((x, y))


async def run(channel: str | None, headless: bool):
    out = {"channel": channel or "chromium", "headless": headless}
    async with async_playwright() as p:
        prof = tempfile.mkdtemp(prefix="cheongeum-s2-")
        kw = dict(headless=headless, no_viewport=True, args=["--window-size=1100,860"])
        if channel:
            kw["channel"] = channel
        ctx = await p.chromium.launch_persistent_context(prof, **kw)
        a = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await a.set_content(HTML)
        b = await ctx.new_page()
        await b.set_content("<h1>앞에 있는 탭</h1>")
        await b.bring_to_front()
        await asyncio.sleep(0.5)
        out["a_visibility"] = await a.evaluate("document.visibilityState")
        t = time.perf_counter()
        try:
            png = await asyncio.wait_for(
                a.screenshot(
                    mask=[a.locator("#name"), a.locator("#rrn")],
                    mask_color="#000000",
                    style="#__cheongeum_cursor{display:none!important}",
                    scale="css",
                    timeout=5000,
                ),
                8,
            )
            out["ms"] = round((time.perf_counter() - t) * 1000)
            out["mask_input"] = pixel(png, 60, 140)
            out["mask_para"] = pixel(png, 60, 210)
            out["cursor_spot"] = pixel(png, 420, 140)
            out["blank_spot"] = pixel(png, 900, 600)
            from PIL import Image

            out["size"] = Image.open(io.BytesIO(png)).size
        except Exception as e:  # noqa: BLE001
            out["error"] = repr(e)[:200]
        out["front_after"] = await b.evaluate("document.visibilityState")
        await ctx.close()
    return out


async def main():
    for channel, headless in [(None, False), ("chrome", False), (None, True)]:
        try:
            print(await run(channel, headless))
        except Exception as e:  # noqa: BLE001
            print({"channel": channel, "error": repr(e)[:200]})


asyncio.run(main())
