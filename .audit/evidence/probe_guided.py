import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]

from conftest import create_test_runtime  # noqa: E402
from cheongeum.practice_site import ensure_mock_site  # noqa: E402


async def go():
    ensure_mock_site(5174)
    rt = create_test_runtime()
    s = await rt.create_session()
    portal = "http://127.0.0.1:5174/external.html"
    r = await s.handle_turn(f"{portal} 열어줘")
    print("open", r["state"], r["speech"][:80])
    r = await s.handle_turn("입력 칸 하나씩 채워줘")
    print("start", r["state"], r["speech"][:120])
    r = await s.handle_turn("홍길동")
    print("val", r["state"], r["speech"][:200])
    print("pending", r.get("pendingConfirmation"))
    print("guided", s.dialogue.guided)
    print("approval keys", list((s.dialogue.approval or {}).keys()))
    r = await s.handle_turn("응")
    print("ok", r["state"], r["speech"][:240])
    fields = (r.get("observation") or {}).get("fields") or []
    print("fields", [(f["fieldId"], f.get("value")) for f in fields])
    print(
        "actions",
        [(a["action"]["type"], a.get("result", {}).get("ok"), a.get("policy", {}).get("code"), a.get("result", {}).get("errorCode")) for a in r.get("actions") or []],
    )
    await s.close()
    await rt.close()


asyncio.run(go())
