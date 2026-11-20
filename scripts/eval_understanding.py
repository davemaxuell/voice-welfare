"""같은 발화·대화 상태에서 첫 의도, 모델 호출, 말 이해 시간을 잰다."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import statistics
import time
from pathlib import Path
from unittest.mock import patch

from dotenv import load_dotenv

from cheongeum.agents.web.browser import stop_playwright
from cheongeum.server.runtime import AgentRuntime, load_config
from cheongeum.understanding.rules import IntentContext

ROOT = Path(__file__).resolve().parents[1]
ACTION_TYPES = {
    "FOLLOW_LINK", "FILL", "SEARCH", "OPEN_SITE", "GOAL", "START_APPLICATION",
    "PREPARE_SUBMIT", "LOGIN", "CLEAR_LOGIN", "NEXT", "PREV", "REJECT", "APPROVE",
}


async def evaluate(out: Path) -> int:
    load_dotenv(ROOT / ".env")
    cases = json.loads((ROOT / "tests/fixtures/understanding_cases.json").read_text(encoding="utf8"))
    runtime = AgentRuntime(load_config({**os.environ, "HEADLESS": "true", "REQUIRE_CONSENT": "false"}))
    rows = []
    times = []
    correct = wrong_actions = fast_calls = calls = failed_calls = fallback_rows = 0
    session = None
    try:
        session = await runtime.create_session(background=True)
        llm = session.deps.llm
        if llm is None:
            raise RuntimeError("비교 평가에 쓸 말 이해 모델을 설정해 주세요.")
        generate = llm.generate

        async def metered(**kwargs):
            nonlocal calls, failed_calls
            calls += 1
            try:
                result = await generate(**kwargs)
            except (Exception, asyncio.CancelledError):
                failed_calls += 1
                raise
            if result is None:
                failed_calls += 1
            return result

        with patch.object(llm, "generate", metered):
            for case in cases:
                previous = calls
                start = time.monotonic()
                plan = await session.understanding.understand(
                    case["text"], IntentContext(state=case["state"]), awaited=None,
                    clarifying=False, page=None, recent=[], trace=lambda _: None,
                )
                ms = (time.monotonic() - start) * 1000
                times.append(ms)
                kind = plan.intents[0]["type"]
                ok = kind in case["expect"]
                correct += ok
                wrong_actions += not ok and kind in ACTION_TYPES
                fallback_rows += plan.by == "rules-fallback"
                if case["fast"]:
                    fast_calls += calls - previous
                rows.append(f"| {case['text']} | {case['state']} | {', '.join(case['expect'])} | "
                            f"{kind} | {plan.by} | {'통과' if ok else '실패'} | {calls - previous} | {ms:.1f} |")
        model_name = llm.name
    finally:
        if session is not None:
            await session.close()
        await runtime.close()
        await stop_playwright()

    p95 = sorted(times)[math.ceil(len(times) * .95) - 1]
    lines = [
        "# 말 이해 평가", "", f"- 모델 {model_name}",
        f"- 정확도 {correct}/{len(cases)} ({correct / len(cases):.1%})",
        f"- 잘못 선택한 조작 {wrong_actions}건",
        f"- 빠른 길 모델 호출 {fast_calls}회",
        f"- 전체 모델 호출 {calls}회 (응답 없음 {failed_calls}회, 규칙 대체 {fallback_rows}건)",
        f"- 평균 {statistics.mean(times):.1f} ms · p95 {p95:.1f} ms (최근접 순위)",
        "", "| 발화 | 상태 | 기대 | 실제 | 판정 경로 | 결과 | 모델 호출 | 시간(ms) |",
        "|---|---|---|---|---|---|---:|---:|", *rows,
    ]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf8")
    print("\n".join(lines[:8]))
    return int(bool(fast_calls or failed_calls or fallback_rows))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "reports/understanding-eval.md")
    raise SystemExit(asyncio.run(evaluate(parser.parse_args().out)))
