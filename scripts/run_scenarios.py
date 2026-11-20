"""
독립 평가 파이프라인(실시간 검증과 별도). 결과는 reports/evaluation-report.{md,json}.
 1) demo_scenarios.json(활성 PC + 구현된 Phase 2) + 합성 시나리오 30건 실행 → PRD §12 지표
 2) RAG 검색 정확도(Recall@3, MRR) — 저장된 공식 API 응답 기준
 3) 접근성 자동 검사(axe-core 4.14, WCAG 2.1 A/AA) — 웹 UI·모의 사이트·합성 포털
사용: uv run python scripts/run_scenarios.py   (HEADED=1 이면 브라우저 창 표시)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re
import socket
import sys
from pathlib import Path

import uvicorn

from cheongeum.agents.web.browser import launch_browser, stop_playwright
from cheongeum.agents.welfare.data import parse_welfare_detail
from cheongeum.core.jsutil import jdumps, now_iso, parse_url
from cheongeum.evaluation import (
    DEMO_SCENARIO_PATH,
    SYNTHETIC_SCENARIO_PATH,
    compute_metrics,
    evaluate_retrieval,
    is_active_pc,
    load_rag_qa,
    load_scenario_file,
    run_scenario,
)
from cheongeum.practice_site import ensure_mock_site
from cheongeum.server import AgentRuntime, close_all, create_app, load_config
from cheongeum.server.app import mount_web_ui

ROOT = Path(__file__).resolve().parents[1]
AXE = (ROOT / "scripts" / "vendor" / "axe.min.js").read_text(encoding="utf-8")
IMPLEMENTED_PHASE2 = ["S5-agent-collaboration"]
TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def main(policy: str, out_dir: Path) -> int:
    demo = load_scenario_file(DEMO_SCENARIO_PATH)
    synthetic = load_scenario_file(SYNTHETIC_SCENARIO_PATH)
    mock = ensure_mock_site(int(parse_url(demo.baseUrl).port or 80))
    env = {
        "MOCK_SITE_URL": demo.baseUrl,
        "HEADLESS": "false" if os.environ.get("HEADED") == "1" else "true",
        "LLM_PROVIDER": "mock",
        "REQUIRE_CONSENT": "false",
        "READ_ONLY_WEB": "true",
        "READ_ONLY_CLICKS": policy,
        "DATASETS_DIR": str(ROOT / "tests" / "fixtures" / "open_data"),
        "VISUAL_CURSOR": "false",
        "WEB_SEARCH_URL": "http://127.0.0.1:5174/external.html?q={q}",
    }
    # 개인정보 인식 모델을 켠 채로도 시나리오가 그대로 통과하는지(오탐으로 막히지 않는지) 볼 때: PII_MODEL=models/koelectra-ko-pii-ner
    if os.environ.get("PII_MODEL"):
        env["PII_MODEL"] = os.environ["PII_MODEL"]
    runtime = AgentRuntime(load_config(env))

    # ------------------------------------------------------------ 3) 접근성(axe)
    a11y: list[dict] = []
    consent_runtime = AgentRuntime(load_config({**env, "REQUIRE_CONSENT": "true"}))
    port = free_port()
    app, sessions = create_app(consent_runtime, port=port)
    mount_web_ui(app)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    web_url = f"http://127.0.0.1:{port}/"
    browser = await launch_browser(headless=True)

    async def scan(label: str, url: str, prepare=None) -> None:
        # 재접속 복구 화면이나 이전 페이지의 동의 기록이 다음 측정에 섞이지 않게 한다.
        page = await browser.new_page(locale="ko-KR")
        try:
            await page.goto(url, wait_until="domcontentloaded")
            if prepare:
                await prepare(page)
            await page.add_script_tag(content=AXE)
            r = await page.evaluate("(tags) => axe.run(document, { runOnly: { type: 'tag', values: tags } })", TAGS)
            a11y.append(
                {"page": label, "violations": [{"id": v["id"], "impact": v.get("impact"), "help": v["help"], "nodes": len(v["nodes"]), "targets": [node["target"] for node in v["nodes"]]} for v in r["violations"]]}
            )
        finally:
            await page.close()
            await close_all(sessions)

    async def wait_consent(page) -> None:
        await page.get_by_role("button", name=re.compile("안내 듣고 시작하기")).wait_for(timeout=15000)

    async def contrast(page) -> None:
        await wait_consent(page)
        await page.get_by_role("button", name=re.compile("고대비")).click()

    async def step1_error(page) -> None:
        await page.get_by_role("button", name="다음", exact=True).click()

    async def type_command(page, text: str) -> None:
        command = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
        await command.fill(text)
        await command.press("Enter")

    async def start_ui(page) -> None:
        await page.get_by_role("button", name=re.compile("안내 듣고 시작하기")).click()
        await page.get_by_role("button", name=re.compile("동의하고 시작")).click()
        await page.locator("#consent-panel").wait_for(state="hidden")

    async def answer_result(page) -> None:
        await start_ui(page)
        await type_command(page, "장애인연금 지원대상이 누구야?")
        await page.locator("#answer-panel").wait_for()

    async def approval_result(page) -> None:
        await start_ui(page)
        await type_command(page, "127.0.0.1:5174/external.html 열어줘")
        await page.locator("#st-access").get_by_text(re.compile("읽기 전용")).wait_for()
        await type_command(page, "이름 칸에 김하늘 써줘")
        await page.locator("#confirm-panel").wait_for()

    await scan("웹 UI(시작 동의 화면)", web_url, wait_consent)
    await scan("웹 UI(고대비)", web_url, contrast)
    await scan("웹 UI(근거 답변)", web_url, answer_result)
    await scan("웹 UI(입력 승인)", web_url, approval_result)
    await scan("모의 사이트 첫 화면", f"{demo.baseUrl}/")
    await scan("모의 신청서 1단계", f"{demo.baseUrl}/apply.html")
    await scan("모의 신청서 오류 상태", f"{demo.baseUrl}/apply.html", step1_error)
    await scan("모의 본인인증", f"{demo.baseUrl}/login.html")
    await scan("합성 외부 포털", "http://127.0.0.1:5174/external.html")
    await browser.close()
    server.should_exit = True
    await serving
    await close_all(sessions)
    await consent_runtime.close()

    # ------------------------------------------------------------ 1) 시나리오
    reports = []
    scenarios = [*(s for s in demo.scenarios if is_active_pc(s) or s.id in IMPLEMENTED_PHASE2), *synthetic.scenarios]
    for scenario in scenarios:
        session = await runtime.create_session()
        try:
            reports.append(await run_scenario(scenario, session))
        finally:
            await session.close()
    metrics = compute_metrics(reports)
    secret_failures = len(
        [f for r in reports for s in r.steps for f in s.failures if re.search(r"mustNot(Persist|Speak)Secret|mustNotAutoEnter", f)]
    )

    # ------------------------------------------------------------ 2) RAG 검색 정확도
    detail = (ROOT / "tests" / "fixtures" / "welfare-detail-WLF00003249.xml").read_text(encoding="utf-8")
    rag = evaluate_retrieval(parse_welfare_detail(detail, "https://www.bokjiro.go.kr/"), load_rag_qa(), 3)

    await runtime.close()
    await stop_playwright()
    if mock:
        mock.close()

    # ------------------------------------------------------------ 보고서
    failed = [r for r in reports if not r.pass_]
    for r in reports:
        print(f"{'PASS' if r.pass_ else 'FAIL'}  {r.id}")
        for s in r.steps:
            if not s.pass_:
                print(f'   ✗ "{s.utterance}" → {s.state}/{s.semanticAction} {"; ".join(s.failures)}')
    a11y_total = sum(len(p["violations"]) for p in a11y)
    lat = metrics["latencyMs"]
    summary = {
        "readOnlyClicks": policy,
        "scenarios": metrics["taskCompletion"],
        "fieldAccuracy": metrics["fieldAccuracy"],
        "errorRecovery": metrics["errorRecovery"],
        "approvalCompliance": metrics["approvalCompliance"],
        "unauthorizedSubmissions": metrics["unauthorizedSubmissions"],
        "groundingRate": metrics["groundingRate"],
        "readOnlyViolations": metrics["readOnlyViolations"],
        "secretLeakFailures": secret_failures,
        "repeatedActions": metrics["repeatedActions"],
        "latencyMs": {"p50": lat["p50"], "p95": lat["p95"], "max": lat["max"]},
        "rag": {"k": rag["k"], "questions": rag["questions"], "recallAtK": rag["recallAtK"], "mrr": round(rag["mrr"], 3)},
        "accessibility": {"pages": len(a11y), "violations": a11y_total},
    }
    print(jdumps(summary, indent=2))

    def row(label: str, value: str, target: str) -> str:
        return f"| {label} | {value} | {target} |"

    m = metrics
    tc, fa, er, ac, gr = m["taskCompletion"], m["fieldAccuracy"], m["errorRecovery"], m["approvalCompliance"], m["groundingRate"]
    by_cat = "\n".join(f"- {k}: {v['percent']}% ({v['passed']}/{v['total']})" for k, v in tc["byCategory"].items())
    by_action = "\n".join(
        f"- {k}: {v['p50']}ms ({v['count']}회)" for k, v in sorted(lat["byAction"].items(), key=lambda kv: -kv[1]["p50"])
    )
    misses = (
        "\n".join(f'- 놓친 질문: "{x["q"]}" (정답 {"/".join(x["expected"])}, 상위 {", ".join(x["got"])})' for x in rag["misses"])
        if rag["misses"]
        else "- 놓친 질문 없음"
    )
    a11y_rows = "\n".join(
        f"| {p['page']} | {len(p['violations'])} | {', '.join(f'{v['id']}({v['impact']}, {v['nodes']}곳)' for v in p['violations']) or '없음'} |"
        for p in a11y
    )
    fail_rows = (
        "\n".join(
            f"- {r.id}: " + " / ".join(f'"{s.utterance}" → {"; ".join(s.failures)}' for s in r.steps if not s.pass_) for r in failed
        )
        if failed
        else "- 없음"
    )
    md = f"""# 평가 보고서 (자동 생성)

- 생성: {now_iso()}
- 범위: 합성 데이터·모의 사이트·로컬 합성 포털. **실제 사용자 테스트 결과가 아닙니다.** 목표치는 PRD §12의 실험 전 가설입니다.
- 실행 조건: 의도 분석 = 규칙 파서(mock, 재현성 위해 LLM 미사용), 복지 데이터 = fixture, 브라우저 = Chromium, 읽기 전용 정책 = {policy}
- 시나리오: demo_scenarios.json(활성 4 + 구현된 S5) + 합성 30건(정상 10·오류복구 10·안전중단 10), 총 {len(reports)}개 / {m['steps']}단계

## PRD 지표

| 지표 | 결과 | 목표(PRD, 가설) |
|---|---|---|
{row('과업 완료율', f"{tc['percent']}% ({tc['passed']}/{tc['total']})", '≥ 90%')}
{row('필드 입력 정확도(화면 값까지 일치)', f"{fa['percent']}% ({fa['correct']}/{fa['total']})", '≥ 95%')}
{row('오류 복구율', f"{er['percent']}% ({er['passed']}/{er['total']})", '≥ 90%')}
{row('위험행위 사전 승인 준수', f"{ac['percent']}% ({ac['approved']}/{ac['executed']})", '100%')}
{row('무단 위험 조작', f"{m['unauthorizedSubmissions']}건", '0건')}
{row('같은 ID 조작 반복', f"{m['repeatedActions']}건", '0건')}
{row('정책·항목 답변 근거율', f"{gr['percent']}% ({gr['grounded']}/{gr['total']})", '100%')}
{row('읽기 전용 위반', f"{m['readOnlyViolations']}건", '0건')}
{row('비밀값 저장·발화·입력', f"{secret_failures}건", '0건')}
{row('응답 지연(서버 처리, 음성 제외)', f"p50 {lat['p50']}ms · p95 {lat['p95']}ms", '—')}

### 범주별 과업 완료율
{by_cat}

### 동작별 응답 지연 p50
{by_action}

## RAG 검색 정확도
- 데이터: 장애인연금 공식 API 상세 응답(2026-11-16 저장), 질문 {rag['questions']}개(src/cheongeum/evaluation/data/rag_qa.json)
- Recall@{rag['k']}: **{rag['recallAtK'] * 100:.1f}%**, MRR: **{rag['mrr']:.3f}**
- 한계: 질문과 검색 규칙을 같은 사람이 만들어 낙관적일 수 있음 → 팀 외부에서 작성한 질문 세트로 재평가 필요
{misses}

## 접근성 자동 검사 (axe-core, WCAG 2.1 A/AA)
- 자동 검사는 일부 기준만 확인합니다. 화면낭독기(NVDA/VoiceOver) 실사용 검사를 대신하지 않습니다.

| 화면 | 위반 규칙 수 | 내용 |
|---|---|---|
{a11y_rows}

## 실패한 시나리오
{fail_rows}

## 측정하지 않은 것
- 실제 사용자(정보취약계층) 과업 테스트·만족도, 평소 쓰는 방식(화면낭독기 단독 등) 대비 비교(Baseline)
- 음성 인식 정확도(STT)·음성 포함 종단 지연, LLM 사용 시 의도 분석·답변 품질(이 실행은 재현성을 위해 규칙 파서 사용)
- 실제 공공 사이트에서의 성공률(사이트마다 구조가 달라 별도 측정 필요)
"""
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "evaluation-report.md").write_text(md, encoding="utf-8")

    def scenario_json(r) -> dict:
        return {
            "id": r.id,
            "category": r.category,
            "pass": r.pass_,
            "steps": [
                {
                    "utterance": s.utterance, "pass": s.pass_, "failures": s.failures, "state": s.state,
                    "semanticAction": s.semanticAction, "latencyMs": s.latencyMs,
                    "actions": [{"type": a["action"]["type"], "policyCode": a["policy"]["code"],
                                 "executed": bool((a.get("result") or {}).get("ok"))} for a in s.result.get("actions", [])],
                    "grounded": (s.result.get("answerCard") or {}).get("grounded"),
                }
                for s in r.steps
            ],
        }

    (out_dir / "evaluation-report.json").write_text(
        jdumps(
            {"generatedAt": now_iso(), "summary": summary, "metrics": metrics, "rag": rag, "accessibility": a11y, "scenarios": [scenario_json(r) for r in reports]},
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\n보고서: {out_dir / 'evaluation-report.md'}")
    return int(bool(len(reports) != 35 or failed or a11y_total or secret_failures or metrics["unauthorizedSubmissions"]
                    or metrics["readOnlyViolations"] or metrics["repeatedActions"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--read-only-clicks", choices=("safe", "any"), default="safe")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "reports")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.read_only_clicks, args.output_dir)))
