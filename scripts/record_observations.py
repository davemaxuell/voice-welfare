"""두 모의 출처의 모든 화면과 e2e에서 실제로 누른 조작의 전후를 기록한다."""
from __future__ import annotations

import asyncio
import argparse
import hashlib
import json
import os
import re
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

import pytest
from playwright.async_api import async_playwright

from cheongeum.agents.web.approval import fingerprint
from cheongeum.agents.web.auth_page import auth_page_kind
from cheongeum.agents.web.browser import OBSERVE_SCRIPT, PlaywrightExecutionAdapter
from cheongeum.agents.web.digest import digest_page
from cheongeum.agents.web.effect import Churn, diff_views
from cheongeum.agents.web.profile import create_mock_welfare_profile
from cheongeum.core.actions import parse_observation
from cheongeum.practice_site.serve import SITE_DIR, ensure_mock_site

ROOT = Path(__file__).resolve().parents[1]
ORIGINS = ("http://localhost:5174", "http://127.0.0.1:5174")
PROFILE = create_mock_welfare_profile(ORIGINS[0])


def encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def local(url):
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}" in ORIGINS


async def snapshot(page):
    raw = await page.evaluate(OBSERVE_SCRIPT)
    # 원문에 있는 시계·난수만 정규화한다. 출처·경로·역할과 이름은 보존한다.
    text = re.sub(r"MOCK-\d{8}-\d{4}", "MOCK-20261118-0000", encode(raw))
    text = re.sub(r"(cheongeum-\d+-)[a-z0-9]{1,4}(?=\")", r"\g<1>test", text)
    view = parse_observation({**json.loads(text), "platform": "pc", "url": page.url, "capturedAt": "2026-11-18T00:00:00.000Z"})
    return {**view, "pageId": PROFILE.classify(page.url)}


class Observations:
    def __init__(self):
        self.views = {}
        self.pages = {}
        self.clicks = {}
        self.idle = []

    def store(self, view):
        key = hashlib.sha256(encode(view).encode()).hexdigest()[:24]
        if key not in self.views:
            self.views[key] = {"id": key, "view": view, "digest": asdict(digest_page(view)), "auth": auth_page_kind(view)}
        return key

    async def inventory(self):
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            page = await browser.new_page()
            for origin in ORIGINS:
                for file in sorted(SITE_DIR.glob("*.html")):
                    url = origin + "/" + file.name
                    await page.goto(url)
                    self.pages[url] = self.store(await snapshot(page))
                await page.goto(origin + "/portal2.html?rotate=1")
                previous = None
                churn = Churn()
                for n in range(1, 5):
                    await page.wait_for_function("(n) => document.getElementById('ticker').textContent.endsWith(n + '호')", arg=n)
                    view = await snapshot(page)
                    churn.observe(view, previous)
                    self.idle.append({"origin": origin, "view": self.store(view), "volatile": churn.volatile()})
                    previous = view
            await browser.close()

    def intercept(self, original):
        async def execute(adapter, action, signal=None):
            page = adapter.page
            if action["type"] != "click" or page is None or not local(page.url):
                return await original(adapter, action, signal)
            before = await snapshot(page)
            result = await original(adapter, action, signal)
            page = adapter.page
            if page is None or page.is_closed() or not local(page.url):
                return result
            after = await snapshot(page)
            target = action.get("target") or {}
            simple = {"type": "click", "target": target}
            row = {"before": self.store(before), "after": self.store(after), "action": simple,
                   "effect": diff_views(before, after, target.get("ref")),
                   "fingerprint": fingerprint(before, [simple], "이 항목을 누를까요?")}
            key = encode(row)
            case = os.environ["PYTEST_CURRENT_TEST"].removesuffix(" (call)")
            self.clicks.setdefault(key, set()).add(case)
            return result
        return execute

    def publish(self, out):
        out.mkdir(parents=True, exist_ok=True)
        with (out / "views.jsonl").open("w", encoding="utf-8", newline="\n") as f:
            for key in sorted(self.views):
                print(encode(self.views[key]), file=f)
        data = {"pages": self.pages, "idle": self.idle,
                "clicks": [{**json.loads(row), "tests": sorted(self.clicks[row])} for row in sorted(self.clicks)]}
        (out / "interactions.json").write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"{len(self.pages)} pages, {len(self.views)} views, {len(self.clicks)} click pairs, {len(self.idle)} idle observations")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "tests" / "fixtures" / "observations")
    args = parser.parse_args()
    site = ensure_mock_site(5174)
    recording = Observations()
    try:
        asyncio.run(recording.inventory())
        with patch.object(PlaywrightExecutionAdapter, "execute", recording.intercept(PlaywrightExecutionAdapter.execute)):
            status = pytest.main(["-q", str(ROOT / "tests" / "e2e")])
        if status != 0:
            raise SystemExit(status)
        recording.publish(args.output)
    finally:
        if site:
            site.close()
