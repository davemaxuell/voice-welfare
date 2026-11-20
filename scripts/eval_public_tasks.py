"""합성 공공업무 발화로 모델별 의도 정확도와 응답 시간을 비교한다. 사이트 조작은 하지 않는다."""
from __future__ import annotations

import argparse
import asyncio
import os
import statistics
import time
from dataclasses import dataclass, replace

from dotenv import dotenv_values

from cheongeum.core.jsutil import AbortSignal
from cheongeum.core.llm import OPENAI_BASE_URL, ModelConnections, create_structured_llm
from cheongeum.orchestrator.public_task import PublicTask, decide
from cheongeum.server.runtime import load_config


@dataclass(frozen=True)
class Case:
    id: str
    lang: str
    words: str
    kind: str
    agency: str | None = None
    facts: tuple[str, ...] = ()
    task: PublicTask = PublicTask()
    excluded: str | None = None
    skills: tuple[str, ...] = ()
    clarification_reply: str | None = None


SCHOLARSHIP = PublicTask(agency="한국장학재단", subject="국가장학금", goal="국가장학금 신청 기간", facts=("dates",))
DOCUMENT = PublicTask(agency="정부24", goal="주민등록 서류", question="Do you mean 등본 or 초본?", choices=("등본", "초본"))
CASES = [
    Case("unlisted-homepage", "ko", "하이코리아 홈페이지 열어줘", "existing"),
    Case("switch-unlisted-site", "en", "Open the Maple Library homepage instead.", "existing", task=SCHOLARSHIP),
    Case("open-screen-result", "ko", "지금 화면에서 두 번째 검색 결과를 열어 주세요.", "existing"),
    Case("skip-login", "ko", "정부24에서 로그인은 건너뛰고 주민등록등본 발급 서류만 알려줘", "find_information", "정부24", ("documents",), excluded="login"),
    Case("done-login", "ko", "로그인은 됐고 국가장학금 서류만 알려줘", "find_information", "한국장학재단", ("documents",)),
    Case("several-facts", "ko", "국가장학금 신청 기간이랑 준비할 서류를 한 번에 알려줘", "find_information", "한국장학재단", ("dates", "documents")),
    Case("ko-correction", "ko", "장학재단 말고 고용24에서 실업급여 받는 조건이 궁금해", "find_information", "고용24", ("eligibility",), SCHOLARSHIP),
    Case("ko-ambiguous", "ko", "민원이요. 증명서인지 불편 신고인지 설명을 못 들었어요", "clarify"),
    Case("en-followup", "en", "And what paperwork do I need for that?", "find_information", "한국장학재단", ("documents",), SCHOLARSHIP),
    Case("en-switch", "en", "Now open the 국민신문고 website instead.", "open_agency", "국민신문고", task=SCHOLARSHIP),
    Case("en-negation", "en", "On Gov24, just find the documents for a residence certificate. Skip signing in.", "find_information", "정부24", ("documents",), excluded="login",
         clarification_reply="I mean 주민등록표 등본. Which documents should I bring?"),
    Case("en-correction", "en", "I meant 초본. Which documents does it need?", "find_information", "정부24", ("documents",), DOCUMENT),
    Case("en-action", "en", "Log into the site for me.", "existing", clarification_reply="Gov24. Please help me sign in there."),
    Case("zh-scholarship", "zh", "请去韩国奖学财团查国家奖学金的申请时间和材料。", "find_information", "한국장학재단", ("dates", "documents")),
    Case("zh-followup", "zh", "那要准备什么材料？", "find_information", "한국장학재단", ("documents",), SCHOLARSHIP),
    Case("zh-switch", "zh", "换一个，打开政府24。", "open_agency", "정부24", task=SCHOLARSHIP),
    Case("zh-complaint", "zh", "请在韩国的国民申闻鼓上找投诉流程。", "find_information", "국민신문고", ("procedure",)),
    Case("zh-control", "zh", "请把刚才说的再慢慢读一遍。", "read_skill", skills=("REPHRASE",)),
    Case("ja-employment", "ja", "雇用24で失業給付の対象条件を調べてください。申請はしないで。", "find_information", "고용24", ("eligibility",), excluded="application"),
    Case("ja-followup", "ja", "その奨学金の提出書類は？", "find_information", "한국장학재단", ("documents",), SCHOLARSHIP),
    Case("ja-switch", "ja", "次は福祉ロ（복지로）を開いてください。", "open_agency", "복지로", task=SCHOLARSHIP),
    Case("ja-docs", "ja", "政府24で住民登録謄本の発行方法と必要書類を教えてください。", "find_information", "정부24", ("procedure", "documents")),
    Case("ja-control", "ja", "今の画面を読み上げてください。", "read_skill", skills=("DESCRIBE_SCREEN", "READ_MAIN")),
]


async def evaluate(models: list[str], parallel: int) -> bool:
    config = load_config({**dotenv_values(".env"), **os.environ}).llm
    if not config.apiKey:
        raise SystemExit("Set the API key for the configured planning provider.")
    limit = asyncio.Semaphore(parallel)

    async def run(model: str):
        cfg = replace(config, model=model)
        if cfg.provider == "openai" and (cfg.baseUrl or OPENAI_BASE_URL).rstrip("/") == OPENAI_BASE_URL:
            cfg = replace(cfg, reasoningEffort="low" if model.startswith("gpt-6") else None)
        pool = ModelConnections()
        llm = create_structured_llm(cfg, pool=pool)
        if llm is None:
            raise SystemExit("The configured planning provider is unavailable.")

        def matches(case, decision, task):
            if decision is None:
                return False
            actual = task.advance(decision)
            return bool(decision.kind == case.kind and (not case.agency or actual.agency == case.agency)
                        and set(case.facts) <= set(actual.facts) and (not case.excluded or case.excluded in actual.exclusions)
                        and (not case.skills or decision.skill in case.skills))

        async def trial(case: Case):
            async with limit:
                start = time.monotonic()
                decision = await decide(llm, case.words, case.lang, case.task, voice=True, recent=[], signal=AbortSignal())
                seconds = time.monotonic() - start
                direct = matches(case, decision, case.task)
                resolved = direct
                if not direct and decision and decision.kind == "clarify" and case.clarification_reply:
                    pending = case.task.advance(decision)
                    follow = await decide(llm, case.clarification_reply, case.lang, pending, voice=True, recent=[], signal=AbortSignal())
                    resolved = matches(case, follow, pending)
            return case.id, direct, resolved, seconds, decision.kind if decision else "unavailable"

        try:
            rows = await asyncio.gather(*(trial(case) for case in CASES))
        finally:
            await pool.close()
        direct = sum(ok for _, ok, _, _, _ in rows)
        passed = sum(ok for _, _, ok, _, _ in rows)
        times = [s for _, _, _, s, _ in rows]
        print(f"{model} first decision {direct}/{len(rows)}, after clarification {passed}/{len(rows)}; "
              f"first-decision median {statistics.median(times):.2f}s, p95 {statistics.quantiles(times, n=20, method='inclusive')[-1]:.2f}s")
        usage = getattr(llm, "usage", {})
        if usage:
            print(f"  {usage['calls']} calls, {usage['inputTokens']} input tokens, {usage['outputTokens']} output tokens")
        for case_id, _, ok, _, kind in rows:
            if not ok:
                print(f"  {case_id}: {kind}")
        return passed == len(rows)

    return all(await asyncio.gather(*(run(model) for model in models)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", action="append", required=True)
    parser.add_argument("--parallel", type=int, default=3, choices=range(1, 9))
    args = parser.parse_args()
    raise SystemExit(0 if asyncio.run(evaluate(args.model, args.parallel)) else 1)
