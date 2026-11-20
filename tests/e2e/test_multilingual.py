import pytest
from conftest import PORTAL, FakeLlm, with_llm

from cheongeum.core.jsutil import jdumps


def with_translator(s, table: dict, out_override=None) -> FakeLlm:
    """
    가짜 통역 LLM(네트워크 없음): translate_in은 표에서 찾고, translate_out은 "[en] 원문"처럼 표시만 붙인다(숫자 보존).
    out_override로 번역 결과를 바꿔 검증 실패를 흉내 낸다.
    """

    def fn(*, system, user, schemaName, schema):
        if schemaName == "translate_in":
            return {"text": table[user]} if user in table else None
        if schemaName == "translate_out":
            return {"text": out_override(user) if out_override else f"[en] {user}"}
        return None

    llm = FakeLlm(fn=fn)
    with_llm(s, llm)
    return llm


async def test_switch_to_english_then_translate(new_session):
    s = await new_session()
    with_translator(s, {"Open the practice application form": "장애인연금 신청 도와줘"})
    sw = await s.handle_turn("영어로 말해줘")
    assert sw["intentType"] == "SET_LANGUAGE"
    assert sw["lang"] == "en"
    assert "English" in sw["speech"]

    r = await s.handle_turn("Open the practice application form")
    assert r["lang"] == "en"
    assert r["userUtterance"] == "Open the practice application form"  # 화면에는 사용자가 한 말 그대로
    assert r["observation"]["step"]["index"] == 1  # 한국어 흐름으로 모의 신청서가 열림
    assert r["speech"].startswith("[en] ")
    assert any(t.get("note") == "번역 en→ko" for t in r["trace"])
    assert any(t.get("note") == "응답 번역 ko→en" for t in r["trace"])


async def test_stop_without_translation(new_session):
    s = await new_session()
    llm = with_translator(s, {})
    await s.handle_turn("중국어로 말해줘")
    r = await s.handle_turn("停止")
    assert r["intentType"] == "STOP"
    assert r["lang"] == "zh"
    assert "已全部停止" in r["speech"]
    assert [c for c in llm.calls if c["schemaName"] == "translate_in"] == []


@pytest.mark.parametrize("lang,mention,value", [
    ("en", "Where do I enter my password?", "BlueMeadow"),
    ("ja", "パスワードはどこに入力しますか", "青いしずく"),
    ("zh", "在哪里输入密码？", "蓝色草地"),
    ("ko", "비밀번호를 어디에 입력하죠?", "푸른언덕"),
])
async def test_only_the_first_bare_reply_to_a_password_mention_is_screened_locally(new_session, lang, mention, value):
    s = await new_session()
    llm = with_translator(s, {})  # the initial translation may also be unavailable
    await s.set_language(lang)
    await s.handle_turn(mention)
    llm.calls.clear()
    blocked = await s.handle_turn(value)
    assert all(value not in call["user"] for call in llm.calls)
    assert blocked["intentType"] == "SECRET_DISCLOSURE"
    assert value not in jdumps(blocked) and value not in jdumps(s.export_history())
    assert blocked["lang"] == lang
    if lang == "en":
        await s.handle_turn("Read the page")
        assert any("Read the page" in call["user"] for call in llm.calls)


async def test_private_readback_is_localized_without_sending_profile_to_the_translator(new_session):
    s = await new_session()
    await s.handle_turn("내 이름은 별구름이라고 저장해줘")
    await s.handle_turn("응")
    llm = with_translator(s, {"Read my saved information": "내 정보 알려줘"})
    await s.set_language("en")
    read = await s.handle_turn("Read my saved information")
    assert all("별구름" not in call["user"] for call in llm.calls)
    assert read["lang"] == "en" and "별구름" in read["speech"]
    assert read["localSpeechOnly"]


@pytest.mark.parametrize("lang,request_text,fields", [
    ("en", "Please remember my name as Melody Finch", {"name": "Melody Finch"}),
    ("en", "Save my address as 27 Maple Lane", {"address": "27 Maple Lane"}),
    ("ja", "私の名前は星空です。覚えてください", {"name": "星空"}),
    ("ja", "私の住所は月見町七番地です。保存してください", {"address": "月見町七番地"}),
    ("zh", "请记住我的名字是云舟", {"name": "云舟"}),
    ("zh", "请保存我的地址：月光路七号", {"address": "月光路七号"}),
    ("en", "Remember my name is Cloud Finch and my address is 가상특별시 달빛나루구 새봄마을 은빛길",
     {"name": "Cloud Finch", "address": "가상특별시 달빛나루구 새봄마을 은빛길"}),
    ("ja", "私の名前は星空、住所は月見町七番地です。保存してください", {"name": "星空", "address": "月見町七番地"}),
    ("zh", "请保存我的姓名是云舟，地址是月光路七号", {"name": "云舟", "address": "月光路七号"}),
])
async def test_explicit_vault_save_never_sends_the_supplied_value_to_a_model(new_session, lang, request_text, fields):
    s = await new_session()
    llm = with_translator(s, {})
    s.deps.public_planning = True
    prompt = await s.handle_turn(request_text)
    assert all(value not in call["user"] for call in llm.calls for value in fields.values())
    assert prompt["pendingConfirmation"]["kind"] == "vault-save"
    assert prompt["lang"] == lang and prompt["localSpeechOnly"] and all(value in prompt["speech"] for value in fields.values())
    decline, approve = {"en": ("no", "yes"), "ja": ("いいえ", "はい"), "zh": ("不用", "是的")}[lang]
    assert not (await s.handle_turn(decline)).get("pendingConfirmation")
    assert s._personal.vault() == {}
    assert all(value not in jdumps(s.recent_voice_dialogue()) for value in fields.values())
    await s.handle_turn(request_text)
    await s.handle_turn(approve)
    assert s._personal.vault() == fields
    assert all(value not in call["user"] for call in llm.calls for value in fields.values())


async def test_question_about_saving_an_address_still_reaches_general_language_routing(new_session):
    s = await new_session()
    llm = with_translator(s, {})
    text = "How do I save my address on a public form?"
    result = await s.handle_turn(text)
    assert any(text in call["user"] for call in llm.calls)
    assert "pendingConfirmation" not in result


@pytest.mark.parametrize("request_text,private", [
    ("Save the address 77 Pineview Orchard on this computer", "77 Pineview Orchard"),
    ("Keep Aurelia Rowan as the name I use for applications", "Aurelia Rowan"),
    ("把云舟作为我的名字保存下来", "云舟"),
    ("星空を私の名前として覚えてください", "星空"),
])
async def test_recognizable_personal_saves_can_clarify_locally(new_session, request_text, private):
    s = await new_session()
    llm = with_translator(s, {})
    s.deps.public_planning = True
    reply = await s.handle_turn(request_text)
    assert all(private not in call["user"] for call in llm.calls)
    assert private not in jdumps(s.recent_voice_dialogue())
    assert reply["intentType"] == "PERSONAL_VAULT_SAVE"
    assert s._personal.vault() == {}


async def test_foreign_secret_blocked_before_translation(new_session):
    # 외국어로 말한 비밀번호는 번역(외부 LLM)에 넘기기 전에 막는다
    s = await new_session()
    llm = with_translator(s, {})
    await s.handle_turn("영어로 말해줘")
    r = await s.handle_turn("my password is 4821")
    assert r["semanticAction"] == "auth-handoff"
    assert "4821" not in jdumps(r)
    assert all("4821" not in c["user"] for c in llm.calls)
    assert [c for c in llm.calls if c["schemaName"] == "translate_in"] == []


async def test_only_rule_words_approve(new_session):
    s = await new_session()
    with_translator(s, {"Put Kim Haneul in the name field": "이름 칸에 김하늘 써줘", "Well, I guess you could do that thing": "승인"})
    await s.handle_turn(f"{PORTAL} 열어줘")
    await s.handle_turn("Speak English")
    ask = await s.handle_turn("Put Kim Haneul in the name field")
    assert ask["state"] == "WAITING_FOR_USER_CONFIRMATION"

    vague = await s.handle_turn("Well, I guess you could do that thing")
    assert "yes, approve" in vague["speech"]
    assert vague["actions"] == []
    assert vague["state"] == "WAITING_FOR_USER_CONFIRMATION"

    for other_language in ("승인", "진행해"):
        refused = await s.handle_turn(other_language)
        assert refused["lang"] == "en" and refused["actions"] == []
        assert refused["state"] == "WAITING_FOR_USER_CONFIRMATION"

    yes = await s.handle_turn("Yes")
    assert yes["actions"][0]["policy"]["code"] == "APPROVED"
    assert next(f for f in yes["observation"]["fields"] if f["fieldId"] == "opinionName")["value"] == "김하늘"


async def test_changed_numbers_fall_back_to_korean(new_session):
    s = await new_session()
    with_translator(s, {"Open the practice application form": "장애인연금 신청 도와줘"}, lambda ko: "There are 99 steps in total.")
    await s.handle_turn("English please")
    r = await s.handle_turn("Open the practice application form")
    assert r["lang"] == "ko"
    assert "Translation could not be verified" in r["speech"]
    assert "99" not in r["speech"]
    assert "단계" in r["speech"]


async def test_auto_switch_by_script(new_session):
    s = await new_session()
    with_translator(s, {"What can you do for me?": "뭐 할 수 있어?"})
    r = await s.handle_turn("What can you do for me?")
    assert r["lang"] == "en"
    back = await s.handle_turn("장애인연금 신청 도와줘")
    assert back["lang"] == "ko"
    assert "[en]" not in back["speech"]


async def test_no_llm_no_switch(new_session):
    s = await new_session()
    r = await s.handle_turn("일본어로 말해줘")
    assert r["lang"] == "ko"
    assert "AI 모델 설정이 필요해요" in r["speech"]
    assert s.lang == "ko"


async def test_about_unknown_site(new_session):
    s = await new_session()
    await s.handle_turn(f"{PORTAL} 열어줘")
    r = await s.handle_turn("이 사이트 뭐야?")
    assert r["intentType"] == "ABOUT_SITE"
    assert "'[테스트] 외부 포털" in r["speech"]
    assert "주요 메뉴는 뉴스, 복지, 날씨" in r["speech"]
    assert "이 사이트에서 검색" in r["speech"]


async def test_about_practice_site(new_session):
    s = await new_session()
    await s.handle_turn("장애인연금 신청 도와줘")
    r = await s.handle_turn("여기 무슨 사이트야")
    assert "연습용 모의 복지 신청 사이트" in r["speech"]
