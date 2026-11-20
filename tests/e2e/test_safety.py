"""안전·오류 회복 E2E (실제 Chromium + 모의 사이트)"""
import asyncio
import re

from conftest import flat, FakeLlm, create_test_runtime, field_value, with_llm

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
    return FakeLlm({"intent_plan": {"steps": [flat("DESCRIBE_SCREEN"), flat("POLICY_QUESTION", topic="기초연금은 얼마야?")]}})


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


async def test_bare_password_on_login_page_not_sent_or_stored(new_session):
    # 로그인 화면에서 키워드 없이 값만 말해도(“사과나무”) LLM·기록에 넘기지 않는다
    s = await new_session()
    llm = FakeLlm()
    with_llm(s, llm)
    await s.handle_turn("로그인하고 싶어")
    llm.calls.clear()
    r = await s.handle_turn("사과나무")
    assert r["intentType"] == "SECRET_DISCLOSURE"
    assert r["semanticAction"] == "auth-handoff"
    assert r["state"] == "AUTH_HANDOFF"
    assert "사과나무" not in jdumps(r)
    assert "사과나무" not in jdumps(s.snapshot())
    assert llm.calls == []
    assert next(f for f in r["observation"]["fields"] if f["fieldId"] == "loginPassword")["filled"] is False

    # 끝맺음·명령은 그대로 처리한다
    done = await s.handle_turn("다 했어")
    assert done["intentType"] != "SECRET_DISCLOSURE"
    described = await s.handle_turn("화면 설명해줘")
    assert described["intentType"] == "DESCRIBE_SCREEN"
    # 인증 중에는 같은 비밀값 후보를 다시 말해도 기록이나 모델에 보내지 않는다.
    for _ in range(2):
        repeated = await s.handle_turn("바다거북")
        assert repeated["intentType"] == "SECRET_DISCLOSURE"
        assert "바다거북" not in jdumps(repeated)
    assert "바다거북" not in jdumps(s.snapshot()) and llm.calls == []


async def test_bare_word_after_password_mention(new_session):
    # 직전에 비밀번호를 값 없이 언급했으면 바로 다음의 짧은 낱말은 비밀값일 수 있다(한 턴만).
    s = await new_session()
    await s.handle_turn("비밀번호 알려줄게")
    first = await s.handle_turn("푸른하늘")
    assert first["intentType"] == "SECRET_DISCLOSURE"
    assert "푸른하늘" not in jdumps(s.snapshot())
    later = await s.handle_turn("푸른하늘")
    assert later["intentType"] != "SECRET_DISCLOSURE"


async def test_ordinary_words_pass_outside_login(new_session):
    s = await open_form(new_session)
    r = await s.handle_turn("이름은 사과나무")
    assert field_value(r, "applicantName") == "사과나무"


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


# ---------------------------------------------------------------- 승인: 읽어 준 그대로일 때만, 2분 안에만

FILLED = ["이름은 김하늘", "주소는 부산광역시 예시구 예시로 10"]


async def ask_to_submit(s) -> dict:
    for said in FILLED:
        await s.handle_turn(said)
    asked = await s.handle_turn("최종 확인할게")
    assert asked["state"] == "WAITING_FOR_USER_CONFIRMATION"
    return asked


def submit_clicks(r: dict) -> list[dict]:
    return [a for a in r["actions"] if (a["action"].get("target") or {}).get("name") == "모의접수" and (a.get("result") or {}).get("ok")]


async def test_value_changed_after_read_back_cancels_mock_submit(new_session):
    s = await open_form(new_session)
    await ask_to_submit(s)
    await s.web.adapter.page.evaluate("() => { document.getElementById('address').value = '부산광역시 예시구 예시로 99'; }")
    r = await s.confirm(True)
    assert r["speech"].startswith("주민등록 주소 칸 값이 바뀌었어요. 그래서 모의접수하지 않았어요.")
    assert not submit_clicks(r)
    assert "status" not in r["observation"]
    assert s.dialogue.approval is None
    assert (await s.handle_turn("모의접수 승인"))["speech"].startswith("지금 승인할 작업이 없습니다")


async def test_approval_after_two_minutes_reads_the_summary_again(new_session):
    s = await open_form(new_session)
    now = [1000.0]
    s.deps.clock = lambda: now[0]
    asked = await ask_to_submit(s)
    now[0] += 121
    again = await s.handle_turn("모의접수 승인")
    assert again["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert again["speech"] == f"여쭤본 지 2분이 지나서 다시 여쭤볼게요. {asked['speech']}"
    assert not submit_clicks(again)
    # 다시 물은 때부터 센다
    now[0] += 100
    done = await s.handle_turn("모의접수 승인")
    assert done["state"] == "MOCK_SUBMITTED"


# ---------------------------------------------------------------- 중요한 조작은 저절로 다시 하지 않는다


def time_out_first(s, name: str, really: bool = False) -> list[str]:
    """이름이 name인 클릭의 첫 번째는 시간 초과로 돌려준다(really면 실제로 누른 뒤). 그 클릭을 어댑터가 받은 횟수를 센다."""
    real = s.web.adapter.execute
    clicks: list[str] = []

    async def execute(action, signal=None):
        if action["type"] == "click" and (action.get("target") or {}).get("name") == name:
            clicks.append(action["id"])
            if len(clicks) == 1:
                if really:
                    await real(action, signal)
                return {"actionId": action["id"], "ok": False, "verified": False, "latencyMs": 0, "errorCode": "TIMEOUT"}
        return await real(action, signal)

    s.web.adapter.execute = execute
    return clicks


async def test_timed_out_mock_submit_is_not_sent_again(new_session):
    s = await open_form(new_session)
    await ask_to_submit(s)
    clicks = time_out_first(s, "모의접수")
    r = await s.confirm(True)
    assert len(clicks) == 1
    assert r["speech"].startswith("접수됐는지 확인하지 못했어요. 다시 할까요?")
    assert r["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert "status" not in r["observation"]
    # 두 번째 시도는 사용자만 시킨다
    done = await s.handle_turn("응")
    assert len(clicks) == 2
    assert done["state"] == "MOCK_SUBMITTED"


async def test_timed_out_mock_submit_that_went_through_reports_the_receipt(new_session):
    s = await open_form(new_session)
    await ask_to_submit(s)
    clicks = time_out_first(s, "모의접수", really=True)
    r = await s.confirm(True)
    assert len(clicks) == 1
    assert r["state"] == "MOCK_SUBMITTED"
    assert re.match(r"^MOCK-\d{8}-\d{4}$", r["verification"]["receipt"])


async def test_timed_out_low_risk_click_is_retried_once(new_session):
    s = await open_form(new_session)
    for said in FILLED:
        await s.handle_turn(said)
    clicks = time_out_first(s, "다음")
    r = await s.handle_turn("다음으로")
    assert len(clicks) == 2
    assert r["observation"]["step"]["index"] == 2


async def test_cancel_drops_a_pending_vault_save_and_says_so(new_session):
    s = await new_session()
    await s.handle_turn("내 이름은 박하늘이라고 저장해줘")
    stop = await s.handle_turn("취소")
    assert stop["state"] == "STOPPED"
    assert "박하늘" in stop["speech"] and "저장하지 않았어요" in stop["speech"]
    later = await s.handle_turn("응")
    assert later["state"] == "STOPPED"
    assert "박하늘" not in s._personal.vault().values()


async def test_vault_and_records_wait_while_stopped(new_session):
    s = await new_session()
    await s.handle_turn("내 이름은 최하늘이라고 저장해줘")
    await s.handle_turn("응")
    records = len(s._personal.applications())
    await s.handle_turn("멈춰")
    read = await s.handle_turn("내 정보 알려줘")
    assert read["state"] == "STOPPED" and "중단 상태" in read["speech"]
    assert "최하늘" not in read["speech"]
    recorded = await s.handle_turn("주거급여 신청했어")
    assert recorded["state"] == "STOPPED"
    assert len(s._personal.applications()) == records


async def test_vault_and_records_wait_for_consent():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    s = await rt.create_session()
    try:
        save = await s.handle_turn("내 이름은 김하늘이라고 저장해줘")
        assert "동의해 주세요" in save["speech"] and save["state"] == "AWAITING_CONSENT"
        await s.handle_turn("응")
        record = await s.handle_turn("기초연금 신청했어 접수번호는 AB12345")
        assert "동의해 주세요" in record["speech"]
        assert s._personal.vault() == {} and s._personal.applications() == []
    finally:
        await s.close()
        await rt.close()


async def test_web_answer_hides_resident_number_from_llm(new_session):
    """검색 결과 본문에 주민번호 패턴이 있어도 LLM user 페이로드에는 없다. 근거 검증은 통과한다."""
    from cheongeum.agents.web.agent import WebOutcome
    from cheongeum.safety import REDACTED

    s = await new_session()
    rrn = "900101-1234567"
    quote = "오늘 날씨 신청 방법"
    original_open = s.web.open_site

    async def open_with_rrn(url, ctx):
        out = await original_open(url, ctx)
        if out.status != "ok" or not out.view:
            return out
        outline = dict(out.view.get("outline") or {})
        main = outline.get("mainText") or ""
        if quote not in main:
            main = f"{quote}\n{main}"
        outline["mainText"] = f"{main}\n주민등록번호 예시 {rrn}"
        return WebOutcome(status="ok", actions=out.actions, view={**out.view, "outline": outline})

    s.web.open_site = open_with_rrn  # type: ignore[method-assign]
    llm = FakeLlm(
        {
            "chat_route": {"route": "web_search", "reply": "", "searchQuery": "오늘 날씨"},
            "web_answer": {"found": True, "answer": f"첫 검색 결과는 {quote}이에요.", "evidence": [quote]},
        }
    )
    with_llm(s, llm)
    r = await s.handle_turn("오늘 날씨 어때")
    assert r["semanticAction"] == "web-answer"
    assert quote in r["speech"]
    web_calls = [c for c in llm.calls if c["schemaName"] == "web_answer"]
    assert web_calls
    payload = web_calls[0]["user"]
    assert rrn not in payload
    assert "900101" not in payload
    assert REDACTED in payload


async def test_vault_values_hidden_in_history(new_session):
    """금고 값을 읽어 줘도 들은 말에는 있고, LLM용 _history 보조 턴에는 [비공개]로 바뀐다."""
    from cheongeum.safety import REDACTED

    s = await new_session()
    await s.handle_turn("내 이름은 박하늘이라고 저장해줘")
    await s.handle_turn("응")
    read = await s.handle_turn("내 정보 알려줘")
    assert "박하늘" in read["speech"]
    assistants = [h for h in s.export_history() if h["role"] == "assistant"]
    assert any("박하늘" not in h["text"] and REDACTED in h["text"] for h in assistants if "저장된 정보" in h["text"] or "이름" in h["text"])
    assert all("박하늘" not in h["text"] for h in assistants)


async def test_declined_vault_values_stay_out_of_later_model_requests(new_session):
    s = await new_session()
    name, address = "별구름", "가상시 달빛로 45"
    await s.handle_turn(f"내가 읽은 문서에 {name}이라고 적혀 있었어")
    prompt = await s.handle_turn(f"내 이름은 {name}이고 주소는 {address}라고 저장해줘")
    assert name in prompt["speech"] and address in prompt["speech"]
    await s.handle_turn("아니")
    assert name not in str(s.export_history())
    llm = FakeLlm()
    with_llm(s, llm)
    await s.handle_turn("내가 할 수 있는 일을 설명해 줄래")
    planner = next(call for call in llm.calls if call["schemaName"] == "intent_plan")
    for private in (name, address):
        assert private not in planner["user"]
        assert private not in str(s.recent_voice_dialogue())


async def test_stop_during_private_save_keeps_readback_on_device(new_session):
    s = await new_session()
    await s.handle_turn("내 이름은 별구름이라고 저장해줘")
    stopped = s.cancel()
    assert "별구름" in stopped["speech"]
    assert "별구름" not in str(s.recent_voice_dialogue())
    assert stopped["localSpeechOnly"]


async def test_short_speech_keeps_private_addresses_complete_on_device(new_session):
    s = await new_session()
    s._personal.save_speech({"length": "short"})
    address = "47 St. Elms Blvd. Building Seven, Green Arch Apartments near the west entrance, Sample City 00000"
    s._personal.save_vault({"address": address})
    read = await s.handle_turn("내 정보 알려줘")
    assert address in read["speech"] and read["localSpeechOnly"]
    assert "Elms" not in str(s.recent_voice_dialogue())
