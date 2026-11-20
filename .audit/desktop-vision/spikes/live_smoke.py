"""
실제 런타임(DESKTOP_APPS=true, 실제 Win32Port)으로 읽기만 하는 문장을 돌린다. 화면·소리·파일을 바꾸지 않는다.
창 제목·파일 이름은 출력하지 않는다(개수와 앞 문장만).
"""
import asyncio
import re
import sys

from cheongeum.server.runtime import AgentRuntime, load_config


def scrub(speech: str) -> str:
    # 첫 문장만, 따옴표 안 이름은 가린다
    first = re.split(r"(?<=[.?!])\s", speech, maxsplit=1)[0]
    return re.sub(r"'[^']*'", "'…'", first)


async def main() -> None:
    rt = AgentRuntime(
        load_config(
            {
                "MOCK_SITE_URL": "http://localhost:5174",
                "HEADLESS": "true",
                "LLM_PROVIDER": "mock",
                "REQUIRE_CONSENT": "false",
                "READ_ONLY_WEB": "true",
                "VISUAL_CURSOR": "false",
                "DESKTOP_APPS": "true",
                "WEB_SEARCH_URL": "http://127.0.0.1:5174/external.html?q={q}",
            }
        )
    )
    s = await rt.create_session()
    try:
        print("desktop on:", s.desktop is not None, "| port:", type(getattr(s.deps.desktop, "port", None)).__name__)
        for text in ["지금 몇 시야?", "오늘 며칠이야?", "배터리 얼마나 남았어?", "소리 크기 얼마야?", "와이파이 연결됐어?", "지금 열린 창 뭐 있어?", "메모장 열어줘", "공동인증서 열어줘"]:
            r = await s.handle_turn(text)
            print(f"{text} -> [{r['state']}] {scrub(r['speech'])}")
    finally:
        await s.close()
        await rt.close()


asyncio.run(main())
