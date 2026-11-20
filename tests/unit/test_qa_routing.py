"""2026-11-19 07:00 QA 보고서의 말 이해 실패(정확한 발화 그대로)."""
import pytest

from cheongeum.agents.web import create_mock_welfare_profile, field_vocabulary
from cheongeum.core.places import is_place_request
from cheongeum.personal.commands import parse_speech_pref
from cheongeum.understanding import IntentContext, RuleBasedIntentProvider
from cheongeum.understanding.understand import Understanding

VOCAB = field_vocabulary(create_mock_welfare_profile("http://localhost:5174"))
parser = RuleBasedIntentProvider(VOCAB)


def parse(t: str, state: str = "IDLE") -> dict:
    return parser.parse_sync(t, IntentContext(state=state))


class _NoLlm:
    llm = None
    intent_provider = parser


async def understand(text: str, state: str = "IDLE") -> list[dict]:
    u = Understanding(parser, _NoLlm(), VOCAB)
    out = await u.understand(text, IntentContext(state=state), awaited=None, clarifying=False, page=None, recent=[], trace=lambda _n: None)
    return out.intents


# ---------------------------------------------------------------- 하지 말라는 말은 그 일을 하라는 말이 아니다(L1.3, L5.1)


@pytest.mark.parametrize(
    "text",
    [
        "정부24에서 주민등록등본 발급 안내 찾아줘. 로그인하거나 신청하지 말고",
        "기초연금 안내 화면을 열어줘. 신청하거나 로그인하지 말고",
        "로그인은 하지 말고 화면만 읽어줘",
        "로그인 없이 볼 수 있는 안내 찾아줘",
        "로그인하지 마",
    ],
)
def test_negated_login_is_not_login(text):
    assert parse(text)["type"] != "LOGIN"


@pytest.mark.parametrize("text", ["로그인하고 싶어", "로그인해줘", "복지로 로그인 도와줘", "본인인증 해야 해"])
def test_plain_login_still_login(text):
    assert parse(text)["type"] == "LOGIN"


async def test_named_site_goal_keeps_whole_request():
    text = "정부24에서 주민등록등본 발급 안내 찾아줘. 로그인하거나 신청하지 말고, 어떤 단계부터 내가 직접 해야 하는지만 알려줘."
    intents = await understand(text)
    assert [i["type"] for i in intents] == ["GOAL"]
    assert "어떤 단계부터" in intents[0]["goal"] and "로그인하거나 신청하지 말고" in intents[0]["goal"]


# ---------------------------------------------------------------- 'X 사이트에서'는 그 사이트에 가서 볼 일(L4.1, V1.1)


@pytest.mark.parametrize(
    "text",
    [
        "국민연금공단 사이트에서 고객센터 전화번호와 평일 상담 시간을 찾아줘. 검색 결과 말고 공식 화면에서 확인해줘.",
        "국민연금공단 사이트에서 고객센터 전화번호 찾아줘.",
        "국민연금공단 홈페이지에서 고객센터 번호 알려줘",
    ],
)
def test_site_named_with_saiteu_is_goal(text):
    assert parse(text)["type"] == "GOAL"


def test_branch_lookup_still_place():
    assert parse("가까운 국민연금공단 지사 전화번호 알려줘")["type"] == "FIND_PLACE"
    assert parse("주민센터 어디 있어?")["type"] == "FIND_PLACE"


# ---------------------------------------------------------------- 사이트를 말했으면 복지 제도 답(B)보다 그 사이트에서(S3.1, L2.2)


@pytest.mark.parametrize(
    "text",
    [
        "127.0.0.1:57312/portal2.html에서 이의 신청 기한과 자세한 신청 서류를 찾아줘.",
        "장애수당 말고 장애인연금만 볼게. 장애인연금 신청할 때 필요한 서류랑 어디에 문의하면 되는지 복지로에서 확인해줘.",
    ],
)
def test_site_named_welfare_words_go_to_site(text):
    assert parse(text)["type"] == "GOAL"


def test_welfare_without_site_stays_welfare():
    assert parse("1번 신청 준비해줘")["type"] == "PREPARE_APPLY"
    assert parse("기초연금 신청에 필요한 서류 알려줘")["type"] in ("PREPARE_APPLY", "POLICY_QUESTION")


# ---------------------------------------------------------------- '어디서 본 정보인지'·'주소지'는 기관 위치 찾기가 아니다(L1.2)


def test_provenance_question_is_not_place_lookup():
    text = "그럼 꼭 내 주소지 주민센터에 가야 해? 어디서 본 정보인지 말하고, 확인 못한 건 확인 못했다고 알려줘."
    assert not is_place_request(text)
    assert parse(text)["type"] != "FIND_PLACE"


@pytest.mark.parametrize("text", ["주민센터 어디 있어?", "가까운 행정복지센터 알려줘", "우리 동네 주민센터 전화번호 알려줘", "국민연금공단 지사 주소 알려줘"])
def test_place_lookup_still_detected(text):
    assert is_place_request(text)


# ---------------------------------------------------------------- 이번 한 번 천천히는 말하기 설정을 바꾸지 않는다(L4.3, V1.2)


@pytest.mark.parametrize(
    "text",
    [
        "그 번호를 다시 천천히 말해줘",
        "어디서 확인했어? 그 번호를 다시 천천히 말해줘.",
        "확인한 전화번호를 천천히 읽어줘",
        "두 기관 중 기초연금 신청 전에 물어볼 곳은 어디야? 확인한 전화번호를 천천히 읽어줘.",
        "다시 천천히 말해줘",
    ],
)
def test_one_time_slow_repeat_is_not_a_setting(text):
    assert parse_speech_pref(text) is None


@pytest.mark.parametrize("text", ["천천히 말해줘", "천천히", "앞으로 천천히 말해줘", "좀 더 천천히 말해줘"])
def test_general_slow_is_a_setting(text):
    pref = parse_speech_pref(text)
    assert pref and pref["kind"] == "speech-set" and pref["values"].get("rate") == 0.9


def test_slow_repeat_routes_to_rephrase():
    assert parse("그 번호를 다시 천천히 말해줘", state="BROWSING")["type"] == "REPHRASE"
    assert parse("확인한 전화번호를 천천히 읽어줘", state="BROWSING")["type"] == "REPHRASE"


@pytest.mark.parametrize(
    "text,spoken",
    [
        ("국민연금공단 고객센터는 1355예요.", "국민연금공단 고객센터는 1 3 5 5예요."),
        ("보건복지상담센터 129(무료)", "보건복지상담센터 1 2 9(무료)"),
        ("문의는 051-709-4657.", "문의는 0 5 1, 7 0 9, 4 6 5 7."),
        ("대표번호 1588-1234", "대표번호 1 5 8 8, 1 2 3 4"),
        ("평일 09:00~18:00, 2026년 120만원 100명", "평일 09:00~18:00, 2026년 120만원 100명"),
    ],
)
def test_spell_phone_numbers(text, spoken):
    from cheongeum.speech.phrasing import spell_phone_numbers

    assert spell_phone_numbers(text) == spoken


# ---------------------------------------------------------------- 화면·사이트 제목 물음은 입력 칸 읽기가 아니다(S2.4, L2.3)


@pytest.mark.parametrize(
    "text",
    [
        "그 결과의 제목과 지금 보고 있는 사이트 이름을 알려줘.",
        "서류나 전화번호의 근거를 확인했다고 말할 수 있어? 그 페이지 제목이 뭐야?",
        "지금 페이지 제목이 뭐야?",
    ],
)
def test_page_title_is_not_field_read(text):
    assert parse(text, state="BROWSING")["type"] != "READ_FIELD"


def test_field_read_still_works_on_form():
    assert parse("주소 다시 읽어줘", state="APPLICATION_OPEN")["type"] == "READ_FIELD"
    assert parse("이름 뭐라고 썼어?", state="APPLICATION_OPEN")["type"] == "READ_FIELD"


# ---------------------------------------------------------------- 'X 말고 Y'는 Y(L2.2)


def test_correction_keeps_the_kept_service():
    r = parse("장애수당 말고 장애인연금 신청 준비해줘")
    assert r["type"] == "PREPARE_APPLY" and r.get("service") == "장애인연금"


# ---------------------------------------------------------------- 확인일은 한국 날짜(L3.3: 11월 19일 07:01에 '11월 18일')


def test_today_is_the_korean_date():
    from datetime import datetime, timezone

    from cheongeum.core.jsutil import today_iso

    assert today_iso(datetime(2026, 11, 18, 22, 1, tzinfo=timezone.utc)) == "2026-11-19"
    assert today_iso(datetime(2026, 11, 19, 14, 59, tzinfo=timezone.utc)) == "2026-11-19"
    assert today_iso(datetime(2026, 11, 19, 15, 0, tzinfo=timezone.utc)) == "2026-11-20"


# ---------------------------------------------------------------- 전체 주소를 말하면 그 주소를 연다(사이트 첫 화면이 아니라)


def test_full_url_opens_that_page():
    from cheongeum.understanding.sites import resolve_site

    url = "https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00001164&wlfareInfoReldBztpCd=01"
    assert resolve_site(f"{url} 열어줘")["url"] == url
    assert resolve_site("복지로 열어줘")["url"] == "https://www.bokjiro.go.kr"


# ---------------------------------------------------------------- 고른 제도의 공식 안내 열기(L3.4, 보충 재현)


def test_open_official_guide():
    assert parse("공식 안내 열어줘")["type"] == "OPEN_OFFICIAL"
    assert parse("공식 안내만 열어줘.")["type"] == "OPEN_OFFICIAL"
    # '출처'는 방금 웹 답의 출처일 수도 있어 제도 공식 안내로 보지 않는다(두 번째 검토)
    assert parse("출처 페이지 보여줘")["type"] != "OPEN_OFFICIAL"
    assert parse("복지로 공식 사이트 열어줘")["type"] == "OPEN_SITE"


async def test_prepare_then_open_official_is_two_steps():
    intents = await understand("1번 신청 준비해줘. 확인할 서류를 먼저 알려주고 공식 안내만 열어줘.")
    assert [i["type"] for i in intents] == ["PREPARE_APPLY", "OPEN_OFFICIAL"]


# ---------------------------------------------------------------- 서버 음성도 '천천히' 설정을 따른다(보고서 '말하기' 점검: 브라우저 음성에만 적용됨)


async def test_server_tts_follows_saved_pace(http_mock):
    import json

    import httpx

    from cheongeum.voice.tts import OpenAITtsProvider

    calls = http_mock(lambda req: httpx.Response(200, content=b"\x01"))
    tts = OpenAITtsProvider(api_key="sk-test", base_url="https://api.openai.com/v1", model="m", voice="coral", speed=1.1)
    await tts.synthesize("안녕하세요", language="ko", pace=0.9 / 1.25)
    await tts.synthesize("안녕하세요", language="ko")
    assert json.loads(calls[0].content)["speed"] == pytest.approx(1.1 * 0.72)
    assert json.loads(calls[1].content)["speed"] == pytest.approx(1.1)


def test_pace_from_saved_rate():
    from cheongeum.server.app import speech_pace

    assert speech_pace(1.25) == 1
    assert speech_pace(0.9) == pytest.approx(0.72)
    assert speech_pace(None) is None
    assert speech_pace("빠르게") is None
    assert speech_pace(50) is None


# ---------------------------------------------------------------- 기관 대표 고객센터는 지사 찾기가 아니라 그 기관 사이트에서(L4.1의 뜻)


@pytest.mark.parametrize("text", ["국민연금공단 고객센터 전화번호 알려줘", "국민연금공단 대표번호 찾아줘", "보건복지부 콜센터 번호 알려줘"])
def test_national_contact_of_a_named_agency_is_goal(text):
    assert parse(text)["type"] == "GOAL"


@pytest.mark.parametrize("text", ["가까운 국민연금공단 지사 전화번호 알려줘", "부산 국민연금 지사 어디야?"])
def test_branch_contact_stays_place(text):
    assert parse(text)["type"] == "FIND_PLACE"


# ================================================================ 독립 검토가 증명한 회귀(같은 날)


def test_lookalike_url_is_not_named_as_the_trusted_site():
    from cheongeum.understanding.sites import resolve_site

    assert resolve_site("https://bokjiro.go.kr.evil.example/login 열어줘")["label"] != "복지로"
    assert resolve_site("https://evil.example/naver/login 열어줘")["label"] != "네이버"
    real = "https://www.bokjiro.go.kr/ssis-tbu/index.do"
    assert resolve_site(f"{real} 열어줘")["label"] == "복지로"


@pytest.mark.parametrize(
    "text", ["정부24에서 등본 찾아줘. 로그인하거나 제출하지 말고 확인만 해줘", "로그인하거나 접수하지 말고 확인해줘", "접수하지 말고 확인해줘"]
)
def test_do_not_submit_is_not_submit(text):
    assert parse(text, state="APPLICATION_OPEN")["type"] != "PREPARE_SUBMIT"


def test_submit_after_a_login_negation_is_still_submit():
    assert parse("로그인하지 말고 모의접수 해줘", state="APPLICATION_OPEN")["type"] == "PREPARE_SUBMIT"


@pytest.mark.parametrize(
    "text", ["간편인증 말고 로그인해줘", "로그인 안 하면 못 보나? 로그인해줘", "로그인하지 않으면 안 되니까 로그인해줘", "본인인증 없이 로그인만 해줘", "로그인 없이는 안 되네, 로그인해줘"]
)
def test_positive_login_after_a_negation_is_login(text):
    assert parse(text)["type"] == "LOGIN"


@pytest.mark.parametrize("text", ["삼성전자 공식 사이트 열어줘", "주민센터 공식 사이트 열어줘", "청와대 공식 누리집 띄워줘", "비공식 자료 보여줘"])
def test_named_official_site_is_not_the_selected_service(text):
    assert parse(text)["type"] != "OPEN_OFFICIAL"


def test_open_official_keeps_the_named_service():
    assert parse("2번 공식 안내 열어줘") == {"type": "OPEN_OFFICIAL", "service": "2번"}
    assert parse("장애인연금 공식 안내 열어줘") == {"type": "OPEN_OFFICIAL", "service": "장애인연금"}
    assert parse("그 공식 안내 열어줘") == {"type": "OPEN_OFFICIAL"}


@pytest.mark.parametrize(
    "text,spoken",
    [
        ("전화번호는 1355, 평일 9시부터예요.", "전화번호는 1 3 5 5, 평일 9시부터예요."),
        ("국번 없이 1355번으로 거세요.", "국번 없이 1 3 5 5번으로 거세요."),
        ("보건복지상담센터는 129번이에요.", "보건복지상담센터는 1 2 9번이에요."),
        ("100분의 50", "100분의 50"),
        ("월 120시간", "월 120시간"),
        ("최대 100 만원", "최대 100 만원"),
        ("1955-03-02", "1955-03-02"),
        ("제102조", "제102조"),
        ("접수번호는 20261119-0042예요.", "접수번호는 20261119-0042예요."),
    ],
)
def test_spell_phone_numbers_edges(text, spoken):
    from cheongeum.speech.phrasing import spell_phone_numbers

    assert spell_phone_numbers(text) == spoken


@pytest.mark.parametrize("text", ["복지관에서 장애인연금 신청할 때 필요한 서류 알려줘", "신문사에서 본 지원금 받을 수 있는지 확인해줘"])
def test_fuzzy_place_word_is_not_a_named_site(text):
    assert parse(text)["type"] != "GOAL"


@pytest.mark.parametrize("text,rate", [("앞으로 답을 천천히 말해줘", 0.9), ("말을 좀 천천히 말해줘", 0.9), ("안내를 천천히 읽어줘", 0.9), ("말을 빨리 말해줘", 1.5)])
def test_general_speed_requests_with_an_object_are_settings(text, rate):
    pref = parse_speech_pref(text)
    assert pref and pref["values"].get("rate") == rate


@pytest.mark.parametrize("text", ["주소 다시 천천히 읽어줘", "연락처 다시 천천히 읽어줘"])
def test_field_slow_readback_is_field_read(text):
    assert parse(text, state="APPLICATION_OPEN")["type"] == "READ_FIELD"


@pytest.mark.parametrize("text", ["한글 이름 수정해줘", "화면 이름 틀렸어"])
def test_field_edit_with_page_words_is_still_an_edit(text):
    assert parse(text, state="APPLICATION_OPEN")["type"] in ("EDIT_FIELD", "FILL")


def test_correction_by_number_keeps_the_kept_number():
    assert parse("1번 말고 2번 신청 준비 알려줘").get("service") == "2번"


# ================================================================ 실제 사이트 재현(같은 날 09시)에서 나온 것


def test_asking_when_one_can_apply_is_not_starting_an_application():
    assert parse("언제 신청을 시작할 수 있는지 공식 안내 근거로 알려줘.")["type"] != "START_APPLICATION"
    assert parse("신청 시작해줘")["type"] == "START_APPLICATION"


async def test_l1_whole_request_stays_one_goal():
    text = "복지로에서 기초연금 신청 방법 찾아줘. 인터넷이 어려우니 어디로 직접 가면 되는지, 언제 신청을 시작할 수 있는지 공식 안내 근거로 알려줘."
    assert [i["type"] for i in await understand(text)] == ["GOAL"]


# ================================================================ 기록 검토(같은 날): 금액·기준값은 한 자리씩 읽지 않는다


@pytest.mark.parametrize(
    "text",
    ["기준 중위소득 100 이하 가구예요.", "월 1000, 연 12000이에요", "예산 1500.", "기초연금은 최대 334,810원이에요."],
)
def test_amounts_are_not_spelled(text):
    from cheongeum.speech.phrasing import spell_phone_numbers

    assert spell_phone_numbers(text) == text


@pytest.mark.parametrize(
    "text", ["로그인은 안 해도 돼 안내만 보여줘", "로그인하기 전에 안내부터 읽어줘"]
)
def test_more_login_negations(text):
    assert parse(text)["type"] != "LOGIN"


def test_cannot_log_in_asks_for_login_help():
    assert parse("로그인 못 하겠어, 도와줘")["type"] == "LOGIN"


# ================================================================ 두 번째 독립 검토(같은 날)


@pytest.mark.parametrize(
    "text",
    [
        "로그인은 안 할 거야, 안내만 읽어줘",
        "로그인 안 해, 그냥 화면 읽어줘",
        "로그인 필요 없어, 안내만 읽어줘",
        "로그인하면 안 돼, 읽기만 해줘",
        "로그인 버튼 누르지 마",
        "로그인 시키지 마",
        "로그인하라는 게 아니고 안내만 읽어줘",
        "로그인은 빼고 찾아줘",
        "로그인하고 싶지 않아",
        "로그인 도와주지 마",
    ],
)
def test_everyday_login_negations(text):
    assert parse(text)["type"] != "LOGIN"


@pytest.mark.parametrize("text", ["로그인이 안 돼, 도와줘", "로그인 도와줘", "로그인하고 싶어", "로그인해줘"])
def test_login_requests_still_login(text):
    assert parse(text)["type"] == "LOGIN"


@pytest.mark.parametrize(
    "text",
    ["접수는 안 할 거야, 확인만 해줘", "제출 안 해, 확인만 해줘", "아직 제출하면 안 돼, 다시 확인해줘", "제출은 나중에 하고 확인해줘", "제출 금지, 내용 확인해줘", "접수하는 건 아니고 확인해줘"],
)
async def test_everyday_submit_negations(text):
    assert all(i["type"] != "PREPARE_SUBMIT" for i in await understand(text, state="APPLICATION_OPEN"))


async def test_goal_with_a_trailing_login_refusal_stays_a_goal():
    assert [i["type"] for i in await understand("정부24에서 주민등록등본 발급 안내 찾아줘. 로그인은 안 할 거야.")] == ["GOAL"]


def test_excluded_program_is_not_opened():
    assert parse("기초연금 말고 장애인연금 공식 안내 열어줘") == {"type": "OPEN_OFFICIAL", "service": "장애인연금"}


@pytest.mark.parametrize("text", ["장애수당 아니고 장애인연금 신청 준비해줘", "장애수당이 아니라 장애인연금 신청 준비해줘"])
def test_correction_forms_keep_the_kept_program(text):
    r = parse(text)
    assert r["type"] == "PREPARE_APPLY" and r.get("service") == "장애인연금"


@pytest.mark.parametrize(
    "text,url",
    [
        ("https://www.bokjiro.go.kr로 들어가줘", "https://www.bokjiro.go.kr"),
        ("https://www.bokjiro.go.kr에 접속해줘", "https://www.bokjiro.go.kr"),
        ("https://www.bokjiro.go.kr/ssis-tbu/index.do를 열어줘", "https://www.bokjiro.go.kr/ssis-tbu/index.do"),
    ],
)
def test_full_url_followed_by_a_particle(text, url):
    from cheongeum.understanding.sites import resolve_site

    r = resolve_site(text)
    assert r["url"] == url and r["label"] == "복지로"


@pytest.mark.parametrize(
    "text",
    [
        "기준 중위소득 100 이하 가구는 주민센터에 문의하세요.",
        "소득이 150을 넘으면 행정복지센터에 문의하세요.",
        "올해 120가구가 주민센터로 신청했어요.",
        "센터 이용 정원은 100이에요.",
        "1950-1960년생은 주민센터에 문의하세요.",
    ],
)
def test_amounts_near_cue_words_are_not_spelled(text):
    from cheongeum.speech.phrasing import spell_phone_numbers

    assert spell_phone_numbers(text) == text


@pytest.mark.parametrize("text", ["신청 화면 열어줄 수 있어?", "신청 시작해줄 수 있어요?"])
def test_polite_application_start_is_still_a_start(text):
    assert parse(text)["type"] == "START_APPLICATION"


@pytest.mark.parametrize("text", ["방금 입력한 주소 천천히 읽어줘", "아까 쓴 연락처 천천히 읽어줘"])
def test_field_readback_on_the_form_with_just_said_words(text):
    assert parse(text, state="APPLICATION_OPEN")["type"] == "READ_FIELD"


def test_do_not_open_the_official_page():
    assert parse("공식 안내 보여주지 말고 요약해줘")["type"] != "OPEN_OFFICIAL"


@pytest.mark.parametrize(
    "text,guess",
    [
        ("복지관에서 하는 프로그램 알려줘", "복지로"),
        ("네이보 열어줘", "네이버"),
        ("복지루에서 기초연금 찾아줘", "복지로"),
        ("복지로에서 기초연금 신청 방법 찾아줘", None),
        ("보건복지부 사이트에서 상담 번호 찾아줘", None),
        ("네이버에서 복지관 프로그램 찾아줘", None),
    ],
)
def test_near_site_guess_only_for_a_near_miss_destination(text, guess):
    from cheongeum.understanding.sites import near_site_guess

    g = near_site_guess(text)
    assert (g[0].label if g else None) == guess
