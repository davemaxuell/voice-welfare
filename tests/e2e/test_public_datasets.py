from pathlib import Path

from conftest import flat, FakeLlm, create_test_runtime

from cheongeum.agents.welfare.open_data import OpenData


async def test_directory_before_consent_disambiguates_and_preserves_short_speech(new_session):
    snapshots = Path(__file__).resolve().parents[2] / "src/cheongeum/agents/welfare/open_data/snapshots"
    rt = create_test_runtime({"REQUIRE_CONSENT": "true", "DATASETS_DIR": str(snapshots)})
    try:
        session = await new_session(rt)
        await session.handle_turn("받을 수 있는 복지 찾아줘")
        choices = await session.handle_turn("서울 강남구 개포동 주민센터 어디야?")
        assert choices["intentType"] == "FIND_PLACE"
        assert "개포1동" in choices["speech"] and "개포2동" in choices["speech"]
        assert session.dialogue.profile_question is None
        session._personal.save_speech({"length": "short"})
        found = await session.handle_turn("1번")
        assert found["semanticAction"] == "find-place" and found["actions"] == []
        assert "선릉로 35" in found["speech"] and "전화번호가 없어요" in found["speech"]
        assert "기준" in found["speech"] and "15059715" in found["sources"][0]["url"]

        session.deps.llm = FakeLlm({"intent_plan": {"steps": [
            flat("FIND_PLACE", topic="서울 강남구 개포1동 주민센터"),
            flat("POLICY_QUESTION", topic="기초연금은 몇 살부터야?"),
        ]}})
        multi = await session.handle_turn("우리 동네 주민센터 어디야? 그리고 기초연금은 몇 살부터야?")
        assert multi["intentType"] == "PLAN(FIND_PLACE>POLICY_QUESTION)"
        assert "선릉로" not in multi["speech"] and not any("15059715" in s["url"] for s in multi["sources"])
        session.deps.llm = None

        await session.handle_turn("우리 동네 주민센터 어디야?")
        await session.handle_turn("멈춰")
        assert (await session.handle_turn("서울 강남구 개포1동"))["state"] == "STOPPED"
        assert session.dialogue.place_ask is None
    finally:
        await rt.close()


async def test_private_program_discovery_followups_use_its_own_record(new_session, monkeypatch):
    session = await new_session()
    welfare = session.deps.welfare
    welfare._shelf = OpenData.load().programs
    monkeypatch.setattr("cheongeum.agents.welfare.agent.today_iso", lambda: "2026-11-18")
    await welfare.discover({"age": 15, "income": "basic"})
    # Use the actual discovery ranking; unrelated updates may move this program up or down.
    match = next(i for i, m in enumerate(welfare._matches, 1) if m.service["servNm"] == "꿈장학(초중고등학생)")
    detail = await session.handle_turn(f"{match}번 자세히")
    assert "민간 사업" in detail["speech"] and "15116392" in detail["sources"][0]["url"]
    assert detail["answerCard"]["dataKind"] == "private-program"
    assert detail["answerCard"]["fields"] == ["target"]
    deadline = await session.handle_turn("지금 신청할 수 있어?")
    assert "확인하지 못했어요" in deadline["speech"]
    prep = await session.handle_turn("신청 도와줘")
    assert "제출서류" in prep["speech"] and "15116392" in prep["sources"][0]["url"]
    assert prep["actions"] == []
    unknown = await session.handle_turn("없는연금 신청 도와줘")
    assert unknown["semanticAction"] == "clarify" and unknown["actions"] == []


async def test_direct_links_cover_local_bokjiro_csv_related_sites_and_official_hints(new_session):
    from conftest import scripted, step

    snapshots = Path(__file__).resolve().parents[2] / "src/cheongeum/agents/welfare/open_data/snapshots"
    rt = create_test_runtime({"DATASETS_DIR": str(snapshots), "PRACTICE_MODE": "false"})
    try:
        session = await new_session(rt)
        local_url = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00006793&wlfareInfoReldBztpCd=02"
        childcare_bokjiro = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00000024&wlfareInfoReldBztpCd=01"

        await session.web.adapter.page.route("https://www.bokjiro.go.kr/**", lambda route: route.fulfill(
            content_type="text/html; charset=utf-8",
            body="<title>복지로 상세</title><main>신분증과 신청서를 준비합니다.</main>",
        ))
        await session.web.adapter.page.route("https://www.mnuri.kr/**", lambda route: route.fulfill(
            content_type="text/html; charset=utf-8",
            body="<title>문화누리카드</title><main>문화누리카드 공식 누리집입니다.</main>",
        ))
        await session.web.adapter.page.route("https://idolbom.go.kr/**", lambda route: route.fulfill(
            content_type="text/html; charset=utf-8",
            body="<title>아이돌봄 서비스</title><main>아이돌봄 서비스 안내입니다.</main>",
        ))

        # 1) 15083323 CSV 관련 사이트 직접 열기
        opened = await session.handle_turn("문화누리카드 열어줘")
        assert opened["intentType"] == "OPEN_SITE"
        assert opened["observation"]["url"].startswith("https://www.mnuri.kr")

        # 2) 15083323 CSV 서비스 관련 사이트 직접 열기 + 공식 안내(복지로 상세) 열기
        site = await session.handle_turn("아이돌봄서비스 관련 사이트 열어줘")
        assert site["intentType"] == "OPEN_SITE"
        assert site["observation"]["url"].startswith("https://idolbom.go.kr/")

        official = await session.handle_turn("아이돌봄서비스 공식 안내 열어줘")
        assert official["intentType"] == "OPEN_OFFICIAL"
        assert official["observation"]["url"] == childcare_bokjiro

        # 3) 15108347 지자체 목록으로 복지로 상세 직접 이동(신청 방법 외 서류 질문 포함)
        seen = scripted(session, [step("answer", None, "신분증과 신청서를 준비합니다.", ["신분증과 신청서를 준비합니다."])])
        local = await session.handle_turn("복지로에서 부산 해운대구 첫째아 출산지원금 서류 알려줘")
        assert seen[0]["page"]["url"] == local_url
        assert local["sources"][0]["url"] == local_url

        # 4) 15083323 중앙 CSV 복지로 상세 이동 + officialLinks(관련 사이트) 힌트 전달
        seen_csv = scripted(session, [step("answer", None, "신분증과 신청서를 준비합니다.", ["신분증과 신청서를 준비합니다."])])
        csv_goal = await session.handle_turn("복지로에서 아이돌봄서비스 서류 알려줘")
        assert seen_csv[0]["page"]["url"] == childcare_bokjiro
        assert seen_csv[0]["conversation"]["officialLinks"]["relatedSites"][0]["url"] == "https://idolbom.go.kr/"
        assert csv_goal["sources"][0]["url"] == childcare_bokjiro
    finally:
        await rt.close()
