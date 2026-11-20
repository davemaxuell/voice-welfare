"""
실제 크롬 모드는 세션들이 영구 프로필 하나(공유 컨텍스트)를 함께 쓴다. 마지막 탭을 닫으면 크롬이 꺼지기 시작하고,
바로 뒤에 만든 세션(웹 화면 새로고침)은 꺼지는 중인 크롬에서 탭을 열지 못해 서버 오류가 난다.
테스트는 창 없는 Chromium의 영구 컨텍스트로 같은 공유 구성을 만든다(창 있는 크롬은 시험에서 띄우지 않는다).
"""
from cheongeum.agents.web.browser import PlaywrightExecutionAdapter, _pw


async def test_closing_the_last_shared_tab_leaves_a_tab_for_the_next_session(tmp_path):
    ctx = await (await _pw()).chromium.launch_persistent_context(str(tmp_path), headless=True)
    try:
        first = PlaywrightExecutionAdapter(context=ctx, allowed_origins=[], read_only_web=True)
        await first.start()
        assert ctx.pages == [first.page]
        await first.close()
        assert len(ctx.pages) == 1
        second = PlaywrightExecutionAdapter(context=ctx, allowed_origins=[], read_only_web=True)
        await second.start()
        assert ctx.pages == [second.page]
        await second.close()
    finally:
        await ctx.close()


async def test_two_shared_sessions_closing_at_once_leave_a_tab(tmp_path):
    # 화면 두 개가 동시에 닫히거나(새로고침 두 번) 오래된 세션을 비우는 사이 다른 세션이 닫힐 때
    import asyncio

    ctx = await (await _pw()).chromium.launch_persistent_context(str(tmp_path), headless=True)
    try:
        a = PlaywrightExecutionAdapter(context=ctx, allowed_origins=[], read_only_web=True)
        await a.start()
        b = PlaywrightExecutionAdapter(context=ctx, allowed_origins=[], read_only_web=True)
        await b.start()
        await asyncio.gather(a.close(), b.close())
        assert len(ctx.pages) >= 1
    finally:
        await ctx.close()


async def test_closing_one_of_two_shared_sessions_closes_only_its_tab(tmp_path):
    ctx = await (await _pw()).chromium.launch_persistent_context(str(tmp_path), headless=True)
    try:
        a = PlaywrightExecutionAdapter(context=ctx, allowed_origins=[], read_only_web=True)
        await a.start()
        b = PlaywrightExecutionAdapter(context=ctx, allowed_origins=[], read_only_web=True)
        await b.start()
        assert len(ctx.pages) == 2
        await a.close()
        assert ctx.pages == [b.page]
    finally:
        await ctx.close()
