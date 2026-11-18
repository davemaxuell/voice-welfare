import asyncio, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / "tests"))
from conftest import create_test_runtime, MOCK_URL
from cheongeum.mock_welfare import is_reachable, start_mock_site
from cheongeum.browser_adapter import stop_playwright

async def main():
    site = None if is_reachable(MOCK_URL) else start_mock_site(5174)
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    s = await rt.create_session()
    try:
        for t in ["나한테 맞는 복지 찾아줘", "일흔 살이에요", "아니요", "잘 모르겠어요", "건너뛸게요", "1번 신청 방법 알려줘"]:
            r = await s.handle_turn(t)
        agents = sorted({x["agent"] for x in r["trace"]})
        print("state:", r["state"], "| agents:", agents, "| actions:", [a.get("type") for a in r.get("actions", [])])
        print("speech:", r["speech"][:200])
    finally:
        await s.close(); await rt.close(); await stop_playwright()
        if site: site.close()
asyncio.run(main())
