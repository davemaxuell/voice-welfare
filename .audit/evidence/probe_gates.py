import asyncio, sys
from pathlib import Path
ROOT = Path(sys.argv[1])
sys.path.insert(0, str(ROOT / "tests"))
from conftest import create_test_runtime, FakeLlm, with_llm, MOCK_URL
from cheongeum.mock_welfare import is_reachable, start_mock_site
from cheongeum.browser_adapter import stop_playwright

SPLIT = FakeLlm({"split_questions": {"questions": ["지금 화면에 뭐가 있어?", "기초연금은 얼마야?"]}})
TWO = "지금 화면에 뭐가 있어? 그리고 기초연금은 얼마야?"

def show(label, r):
    phases = [t.get("phase") + ":" + str(t.get("agent")) for t in r.get("trace", [])]
    print(f"--- {label}\n state={r['state']} intent-trace={phases}\n speech={r['speech'][:220]}")

async def main():
    site = None if is_reachable(MOCK_URL) else start_mock_site(5174)
    try:
        rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
        s = await rt.create_session()
        with_llm(s, SPLIT)
        show("consent pending, one screen question", await s.handle_turn("지금 화면에 뭐가 있어?"))
        show("consent pending, two questions", await s.handle_turn(TWO))
        await s.close(); await rt.close()

        rt = create_test_runtime()
        s = await rt.create_session()
        with_llm(s, SPLIT)
        show("open mock site", await s.handle_turn("모의 신청 사이트 열어줘"))
        show("stop", await s.handle_turn("멈춰"))
        show("stopped, one screen question", await s.handle_turn("지금 화면에 뭐가 있어?"))
        show("stopped, two questions", await s.handle_turn(TWO))
        await s.close(); await rt.close()
    finally:
        await stop_playwright()
        if site: site.close()

asyncio.run(main())
