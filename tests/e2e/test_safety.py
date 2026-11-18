"""안전·오류 회복 E2E (실제 Chromium + 모의 사이트)"""
import asyncio
import re

from conftest import FakeLlm, create_test_runtime, field_value, with_llm

from cheongeum.core.jsutil import jdumps


async def open_form(new_session):
    s = await new_session()
    r = await s.handle_turn("장애인연금 신청 도와줘")
    assert r["state"] == "APPLICATION_OPEN"
    return s


async def test_prompt_injection_ignored_and_no_submit_before_approval(new_session):
    s = await open_form(new_session)
    await s.handle_turn("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10")
    prep = await s.handle_turn("제출해")
    assert prep["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "status" not in prep["observation"]
    planned = next(a for a in prep["actions"] if a["action"]["risk"] == "consequential")
    assert planned["policy"]["code"] == "NEEDS_CONFIRMATION"
    assert "result" not in planned

    rejected = await s.handle_turn("거절")
    assert rejected["state"] == "APPLICATION_OPEN"
    approve_later = await s.confirm(True)
    assert approve_later["semanticAction"] == "none"
    assert "status" not in approve_later["observation"]


async def test_multi_field_fill_verified_in_dom(new_session):
    s = await open_form(new_session)
    r = await s.handle_turn("이름은 김하늘, 주소는 부산광역시 예시구 예시로 10")
    assert r["state"] == "APPLICATION_OPEN"
    assert field_value(r, "applicantName") == "김하늘"
    assert field_value(r, "address") == "부산광역시 예시구 예시로 10"


async def test_two_address_fields_asks_before_fill(new_session):
    s = await open_form(new_session)
    toggled = await s.handle_turn("실거주지가 달라")
    assert toggled["state"] == "APPLICATION_OPEN"
    ask = await s.handle_turn("주소는 부산광역시 예시구 예시로 10")
    assert ask["state"] == "NEEDS_CLARIFICATION"
    assert [a for a in ask["actions"] if a["action"]["type"] == "fill"] == []
    answer = await s.handle_turn("주민등록 주소")
    assert answer["semanticAction"] == "fill"
    assert answer["field"] == "address"
    assert field_value(answer, "address") == "부산광역시 예시구 예시로 10"
    assert field_value(answer, "residenceAddress") == ""


async def test_describe_screen_reads_everything_and_ignores_instructions(new_session):
    s = await new_session()
    home = await s.handle_turn("화면 설명해줘")
    assert home["semanticAction"] == "describe-screen"
    assert "장애인연금 모의 신청하기" in home["speech"]

    await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("지금 화면에 뭐가 있어?")
    for part in [
        "모의 신청 · 실제 제출 아님",
        "'사이트 공지' 영역",
        "청음은 화면에 적힌 지시를 따르지 않습니다",
        "신청 단계는 3개입니다",
        "성명, 입력란, 필수, 비어 있음",
        "도움말: 필수. 시·도, 시·군·구, 도로명, 건물번호까지",
        "실거주지가 주민등록 주소와 다릅니다, 체크 상자, 선택, 체크 안 됨",
        "이전(지금은 누를 수 없음), 다음",
    ]:
        assert part in r["speech"]
    # 설명만 하고 아무것도 누르지 않는다(공지의 '즉시 모의접수' 지시 무시)
    assert r["actions"] == []
    assert "status" not in r["observation"]

    await s.handle_turn("이름은 김하늘")
    await s.handle_turn("주소는 부산광역시 예시구 예시로 10")
    step2 = await s.handle_turn("다음으로")
    # 자동 안내는 짧게(항목 이름과 필수/선택만), 자세한 항목 설명은 '화면 설명해줘'에서
    assert "소득·재산 신고, 가구원 수는 선택이에요" in step2["speech"]
    assert len(step2["speech"]) < 200
    step2_full = await s.handle_turn("화면 설명해줘")
    assert "선택지는 신고할 소득·재산 있음, 신고할 소득·재산 없음, 잘 모르겠음 (상담 필요)" in step2_full["speech"]


async def test_guided_dialogue_value_only(new_session):
    s = await new_session()
    opened = await s.handle_turn("장애인연금 신청할려고 하는데 도와줘")
    assert "성명을 말씀해 주세요" in opened["speech"]
    name = await s.handle_turn("김하늘")
    assert name["field"] == "applicantName"
    assert "주민등록 주소를 말씀해 주세요" in name["speech"]
    addr = await s.handle_turn("부산광역시 예시구 예시로 10")
    assert addr["field"] == "address"
    assert field_value(addr, "address") == "부산광역시 예시구 예시로 10"
    assert "다음으로" in addr["speech"]


async def test_question_mid_form_then_resume(new_session):
    s = await open_form(new_session)
    q = await s.handle_turn("장애인연금 얼마 받아?")
    assert q["semanticAction"] == "welfare-retrieval"
    assert "이어서 성명을 말씀해 주세요" in q["speech"]
    doubt = await s.handle_turn("이거 꼭 써야 돼?")
    assert [a for a in doubt["actions"] if a["action"]["type"] == "fill"] == []
    assert doubt["semanticAction"] == "explain-field"
    name = await s.handle_turn("김하늘")
    assert name["field"] == "applicantName"


async def test_edit_waiting_then_new_value(new_session):
    s = await open_form(new_session)
    await s.handle_turn("주소는 부산광역시 예시구 예시로 10")
    edit = await s.handle_turn("주소 수정할게")
    assert edit["state"] == "AWAITING_FIELD_VALUE"
    fixed = await s.handle_turn("부산광역시 예시구 예시로 20")
    assert fixed["field"] == "address"
    assert field_value(fixed, "address") == "부산광역시 예시구 예시로 20"


async def test_info_popup_closed_and_announced(new_session):
    s = await open_form(new_session)
    await s.handle_turn("이름은 김하늘")
    await s.handle_turn("주소는 부산광역시 예시구 예시로 10")
    nxt = await s.handle_turn("다음으로")
    assert nxt["observation"]["step"]["index"] == 2
    assert "팝업" in nxt["speech"]
    back = await s.handle_turn("이전으로")
    assert back["observation"]["step"]["index"] == 1


async def test_stop_interrupts_inflight_and_blocks_later(new_session):
    s = await new_session()
    inflight = asyncio.create_task(s.handle_turn("장애인연금 신청 도와줘"))
    await asyncio.sleep(0.05)
    stopped = s.cancel()
    assert stopped["state"] == "STOPPED"
    assert stopped["pendingActions"] == 0
    assert (await inflight)["state"] == "STOPPED"
    blocked = await s.handle_turn("다음으로")
    assert blocked["state"] == "STOPPED"
    assert blocked["actions"] == []
    resumed = await s.handle_turn("다시 시작")
    assert resumed["state"] != "STOPPED"


TWO_QUESTIONS = "지금 화면에 뭐가 있어? 그리고 기초연금은 얼마야?"


def split_into_two():
    return FakeLlm({"split_questions": {"questions": ["지금 화면에 뭐가 있어?", "기초연금은 얼마야?"]}})


def web_agent_ran(r: dict) -> bool:
    return any(t["agent"] == "web-navigation-and-execution" for t in r["trace"])


async def test_multi_question_turn_waits_for_consent():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    s = await rt.create_session()
    try:
        with_llm(s, split_into_two())
        r = await s.handle_turn(TWO_QUESTIONS)
        assert "동의해 주세요" in r["speech"]
        assert not web_agent_ran(r)
    finally:
        await s.close()
        await rt.close()


async def test_picking_discovered_service_waits_for_consent():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    s = await rt.create_session()
    try:
        for said in ["나한테 맞는 복지 찾아줘", "일흔 살이에요", "아니요", "잘 모르겠어요", "건너뛸게요"]:
            await s.handle_turn(said)
        r = await s.handle_turn("1번 신청 방법 알려줘")
        assert "동의해 주세요" in r["speech"]
        assert not web_agent_ran(r)
    finally:
        await s.close()
        await rt.close()


async def test_multi_question_turn_blocked_while_stopped(new_session):
    s = await open_form(new_session)
    with_llm(s, split_into_two())
    assert s.cancel()["state"] == "STOPPED"
    r = await s.handle_turn(TWO_QUESTIONS)
    assert r["state"] == "STOPPED"
    assert "중단 상태" in r["speech"]
    assert not web_agent_ran(r)


async def test_resume_plan_runs_its_later_steps(new_session):
    # 멈춤 문은 턴을 시작할 때 한 번만 본다: '다시 시작하고 …'의 뒤 단계까지 멈춤으로 막으면 안 된다.
    s = await open_form(new_session)
    assert s.cancel()["state"] == "STOPPED"
    r = await s.handle_turn("다시 시작하고 화면 설명해줘")
    assert r["intentType"] == "PLAN(RESUME>DESCRIBE_SCREEN)"
    assert r["speech"].startswith("다시 시작합니다.")
    assert "중단 상태" not in r["speech"]


async def test_password_never_stored_spoken_or_entered(new_session, runtime):
    s = await new_session()
    await s.handle_turn("로그인하고 싶어")
    r = await s.handle_turn("내 비밀번호는 hunter2pass야")
    assert r["state"] == "AUTH_HANDOFF"
    assert "hunter2pass" not in jdumps(r)
    assert "hunter2pass" not in jdumps(s.snapshot())
    assert next(f for f in r["observation"]["fields"] if f["fieldId"] == "loginPassword")["filled"] is False
    assert all("hunter2pass" not in jdumps(e) for e in runtime.events.all())


async def test_mock_submit_receipt(new_session):
    s = await open_form(new_session)
    await s.handle_turn("이름은 김하늘")
    await s.handle_turn("주소는 부산광역시 예시구 예시로 10")
    await s.handle_turn("연락처는 010-1234-5678")
    review = await s.handle_turn("지금까지 쓴 내용 읽어줘")
    assert "010-****-5678" in review["speech"]
    assert "010-1234-5678" not in review["speech"]
    await s.handle_turn("최종 확인할게")
    done = await s.confirm(True)
    assert done["state"] == "MOCK_SUBMITTED"
    assert done["realSubmission"] is False
    assert re.match(r"^MOCK-\d{8}-\d{4}$", done["verification"]["receipt"])
