"""
Two checks on the vault and the stop gate. Local practice site, rules only, no LLM, no network.
The vault is in memory (CHEONGEUM_DATA_DIR is not set), so no file is written. Run from the repository root:

    uv run python "drafts/research results/probes/gate_checks.py"

S5: does a vault command run while the session is stopped, or before the user consents?
S6: does "취소" leave a vault save pending, so that a later "응" saves it?
"""
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))

from conftest import MOCK_URL, create_test_runtime  # noqa: E402

from cheongeum.agents.web.browser import stop_playwright  # noqa: E402
from cheongeum.practice_site import is_reachable, start_mock_site  # noqa: E402


async def say(s, text):
    r = await s.handle_turn(text)
    print(f"  {text!r:38} -> {r['intentType']:22} {r['state']:30} {r['speech'][:70]}")
    return r


async def main():
    site = None if is_reachable(MOCK_URL) else start_mock_site(5174)
    rt = create_test_runtime()
    try:
        print("S6: save, then '취소', then '응'")
        s = await rt.create_session()
        await say(s, "내 이름은 김하늘이라고 저장해줘")
        await say(s, "취소")
        print("  vault after 취소:", s._personal.vault(), "| confirmation still pending:", bool(s.dialogue.vault_confirm))
        await say(s, "응")
        print("  vault after 응:  ", s._personal.vault())
        await s.close()

        print("S5: vault read while stopped")
        s = await rt.create_session()
        await say(s, "멈춰")
        r = await say(s, "내 정보 알려줘")
        print("  state stayed STOPPED:", r["state"] == "STOPPED", "| vault value spoken:", "김하늘" in r["speech"])
        await s.close()

        print("S5: vault and records before consent")
        rt_consent = create_test_runtime({"REQUIRE_CONSENT": "true"})
        s = await rt_consent.create_session()
        print("  consent:", s.consent_status)
        for text in ["화면 설명해줘", "내 이름은 김하늘이라고 저장해줘", "응", "기초연금 신청했어 접수번호는 AB12345", "내 정보 알려줘"]:
            await say(s, text)
        print("  consent still:", s.consent_status, "| vault:", s._personal.vault(), "| records:", len(s._personal.applications()))
        await s.close()
        await rt_consent.close()
    finally:
        await rt.close()
        await stop_playwright()
        if site:
            site.close()


asyncio.run(main())
