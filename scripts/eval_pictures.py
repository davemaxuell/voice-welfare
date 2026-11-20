"""Exercise ten synthetic browser screens. Only --live sends pictures to OpenAI."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
import re
import sys
import time
from html import escape
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from cheongeum.agents.web.browser import stop_playwright
from cheongeum.core import llm
from cheongeum.core.picture import png_size
from cheongeum.server.runtime import AgentRuntime, load_config
from cheongeum.speech.picture import UNCHECKED_NUMBERS


async def evaluate(live: bool, example: Path | None = None) -> dict:
    cases = json.loads((ROOT / "tests/fixtures/picture_cases.json").read_text(encoding="utf8"))
    config = {"LLM_PROVIDER": "mock", "PRACTICE_MODE": "false", "HEADLESS": "true", "REQUIRE_CONSENT": "false"}
    if live:
        from dotenv import dotenv_values

        configured = load_config({**dotenv_values(ROOT / ".env"), **os.environ})
        config["LLM_VISION_DETAIL"] = configured.visionDetail
        vision = configured.llmVision
    else:
        vision = llm.LlmConfig(provider="openai", model="offline", apiKey="offline")
    runtime_config = load_config(config)
    runtime_config.llmVision = vision
    runtime = AgentRuntime(runtime_config)
    rows = []
    image_hashes = set()
    try:
        if runtime.vision_llm is None:
            raise ValueError("Set LLM_VISION_PROVIDER=openai, LLM_VISION_MODEL and LLM_VISION_API_KEY.")
        session = await runtime.create_session()
        page = session.web.adapter.page
        origin = "http://picture-qa.test"
        pages = {case["id"]: case for case in cases}

        async def serve(route):
            case = pages.get(route.request.url.removeprefix(origin + "/"))
            if case is None:
                await route.abort()
                return
            title = escape(case["title"])
            await route.fulfill(content_type="text/html; charset=utf-8", body=(
                f'<!doctype html><html lang="ko"><meta charset="utf-8"><title>{title}</title>'
                f'<style>body{{font:24px sans-serif;padding:32px}}button,input{{font:inherit}}</style>'
                f'<main><h1>{title}</h1>{case["body"]}</main></html>'
            ))

        await page.route("**/*", serve)
        post = llm.post_json
        for case in cases:
            await page.goto(f'{origin}/{case["id"]}')
            row = {"case": case["id"], "requests": 0, "usage": None, "cost_usd": None}

            async def inspect_request(url, headers, body, timeout_s, signal=None):
                row["requests"] += 1
                if case["refuse"] or row["requests"] != 1 or url != "https://api.openai.com/v1/chat/completions":
                    raise RuntimeError("Unexpected outgoing QA request")
                prompt, part = body["messages"][-1]["content"]
                assert case["question"] in prompt["text"]
                assert "900101-1234567" not in prompt["text"] and "비밀메모" not in prompt["text"]
                data = base64.b64decode(part["image_url"]["url"].removeprefix("data:image/png;base64,"), validate=True)
                row["dimensions"] = png_size(data)
                if case.get("min_height"):
                    assert row["dimensions"][1] >= case["min_height"]
                    if example:
                        example.parent.mkdir(parents=True, exist_ok=True)
                        example.write_bytes(data)
                digest = hashlib.sha256(data).digest()
                assert digest not in image_hashes, "Different fixture pages produced identical captures"
                image_hashes.add(digest)
                if live:
                    response = await post(url, headers, body, timeout_s, signal)
                    row["usage"] = (response or {}).get("usage")
                    row["cost_usd"] = (row["usage"] or {}).get("cost")
                    return response
                picked = []
                if case["pick"]:
                    index = re.search(rf'^(\d+)\. {re.escape(case["pick"])}$', prompt["text"], re.M)
                    assert index
                    picked.append(int(index[1]))
                result = {"screen": "normal", "description": case["offline_answer"], "pressable": picked}
                return {"choices": [{"message": {"content": json.dumps(result)}}]}

            started = time.perf_counter()
            with patch.object(llm, "post_json", inspect_request):
                result = await session.handle_turn(case["question"])
            speech = result["speech"]
            row.update(latency_s=round(time.perf_counter() - started, 3), speech=speech)
            row["expected_refusal"] = case["refuse"]
            row["number_check"] = (
                all(re.search(rf"(?<!\d){n}(?!\d)", speech) for n in case["numbers"]) and UNCHECKED_NUMBERS in speech
                if case["numbers"] else None
            )
            row["passed"] = bool(
                result["semanticAction"] == "describe-picture"
                and row["requests"] == (0 if case["refuse"] else 1)
                and all(re.search(pattern, speech) for pattern in case["patterns"])
                and row["number_check"] is not False
                and "900101-1234567" not in speech
            )
            if case["pick"]:
                await session.handle_turn("1번 눌러줘")
                row["numbered_pick"] = await page.locator("dialog").count() == 0
                row["passed"] &= row["numbered_pick"]
            rows.append(row)
        await session.close()
    finally:
        await runtime.close()
        await stop_playwright()
    return {"mode": "live" if live else "local-scripted", "model": vision.model, "cases": rows}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="send eligible synthetic pages to the configured paid vision model")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--example", type=Path, help="save the masked synthetic comparison page as a PNG")
    args = parser.parse_args()
    report = asyncio.run(evaluate(args.live, args.example))
    path = args.report or ROOT / "reports" / f'picture-qa-{report["mode"]}.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    for row in report["cases"]:
        print(f'{"PASS" if row["passed"] else "FAIL"} {row["case"]} ({row["requests"]} requests)')
    print(path)
    return int(any(not row["passed"] for row in report["cases"]))


if __name__ == "__main__":
    raise SystemExit(main())
