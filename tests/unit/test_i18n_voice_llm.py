import json

import httpx
import pytest
from conftest import FakeLlm

from cheongeum.agents.web import create_mock_welfare_profile, field_vocabulary
from cheongeum.core.llm import LlmConfig
from cheongeum.language import detect_lang_switch, detect_script_lang, foreign_confirmation, translate_out, untranslated_korean
from cheongeum.safety import unsupported_numbers
from cheongeum.understanding import (
    INTENT_JSON_SCHEMA,
    IntentContext,
    OpenAICompatibleIntentProvider,
    RuleBasedIntentProvider,
    create_intent_provider,
    flat_to_intent,
    is_stop_utterance,
)
from cheongeum.voice import OpenAISttProvider, OpenAITtsProvider, VoiceConfig, VoiceProviderError, audio_extension, create_voice_providers, is_prompt_echo

# ---------------------------------------------------------------- 다국어


@pytest.mark.parametrize(
    "text,lang",
    [
        ("영어로 말해줘", "en"),
        ("Speak English", "en"),
        ("English please", "en"),
        ("English, please.", "en"),
        ("Korean, please.", "ko"),
        ("중국어로 대답해 줘", "zh"),
        ("说中文", "zh"),
        ("일본어로 해줘", "ja"),
        ("日本語で話して", "ja"),
        ("한국어로", "ko"),
        ("Korean please", "ko"),
        ("韓国語でお願いします", "ko"),
    ],
)
def test_lang_switch(text, lang):
    assert detect_lang_switch(text) == lang


def test_lang_name_inside_long_sentence_is_not_command():
    assert detect_lang_switch("네이버에서 영어로 된 복지 안내 사이트를 찾아서 알려줘") is None
    assert detect_lang_switch("영어 사전 열어줘") is None


def test_script_lang():
    assert detect_script_lang("What is this website?") == "en"
    assert detect_script_lang("这个网站是做什么的") == "zh"
    assert detect_script_lang("このサイトは何ですか") == "ja"
    assert detect_script_lang("네이버 열어줘") == "ko"
    assert detect_script_lang("Open 네이버 뉴스.") is None
    assert detect_script_lang("gov.kr") is None
    assert detect_script_lang("yes") is None


def test_foreign_confirmation():
    assert foreign_confirmation("Yes", "en") == "approve"
    assert foreign_confirmation("Yes, approve", "en") == "approve"
    assert foreign_confirmation("确认", "zh") == "approve"
    assert foreign_confirmation("はい、お願いします", "ja") == "approve"
    assert foreign_confirmation("No", "en") == "reject"
    assert foreign_confirmation("不要", "zh") == "reject"
    assert foreign_confirmation("OK open Naver", "en") is None
    assert foreign_confirmation("Yes but change the address first", "en") is None


def test_stop_words_multilingual():
    assert is_stop_utterance("stop")
    assert is_stop_utterance("停止")
    assert is_stop_utterance("止めて")
    assert is_stop_utterance("ストップ")
    assert not is_stop_utterance("附近的停车场在哪里")


def test_translation_number_units():
    assert unsupported_numbers("每月30万韩元", ["매월 30만 원"]) == []
    assert unsupported_numbers("月30万ウォン", ["월 300,000원"]) == []
    assert unsupported_numbers("1.2 million won", ["120만 원"]) == []


async def test_translate_out_retries_on_changed_numbers():
    outputs = ["You get 400,000 won.", "You get 300,000 won a month."]
    seen: list[str] = []

    def fn(*, system, user, schemaName, schema):
        seen.append(system)
        return {"text": outputs.pop(0)}

    assert await translate_out(FakeLlm(fn=fn), "매월 30만 원을 받아요.", "en") == "You get 300,000 won a month."
    assert "changed or added these numbers" in seen[1]
    liar = FakeLlm(fn=lambda **_: {"text": "You get 999 won."})
    assert await translate_out(liar, "매월 30만 원을 받아요.", "en") is None


async def test_translate_out_retries_when_korean_left():
    assert untranslated_korean("I opened Bokjiro (복지로, a welfare portal).") is False
    assert untranslated_korean("内容是：“로그아웃 복지소식 복지로 소개 고객센터 사이트맵 검색어를 입력하세요”") is True
    outputs = ["内容是：“로그아웃 복지소식 복지로 소개 고객센터 사이트맵 검색어를 입력하세요”", "内容是：“退出 福利新闻 福利路介绍 客服中心”"]
    llm = FakeLlm(fn=lambda **_: {"text": outputs.pop(0)})
    assert await translate_out(llm, '내용은 "로그아웃 복지소식 복지로 소개 고객센터"로 시작해요.', "zh") == "内容是：“退出 福利新闻 福利路介绍 客服中心”"


# ---------------------------------------------------------------- 음성


CFG = {"api_key": "sk-test", "base_url": "https://api.openai.com/v1", "model": "stt-model"}


def form_fields(req: httpx.Request) -> dict:
    """multipart 본문에서 이름=값(파일은 파일 이름)을 뽑는다."""
    body = req.content.decode("utf-8", errors="ignore")
    out = {}
    for part in body.split("--")[1:]:
        if 'name="' not in part:
            continue
        name = part.split('name="', 1)[1].split('"', 1)[0]
        if 'filename="' in part:
            out[name] = part.split('filename="', 1)[1].split('"', 1)[0]
        else:
            out[name] = part.split("\r\n\r\n", 1)[1].rsplit("\r\n", 1)[0] if "\r\n\r\n" in part else ""
    return out


async def test_stt_sends_model_language_extension(http_mock):
    calls = http_mock(lambda req: httpx.Response(200, json={"text": " 다음으로 "}))
    out = await OpenAISttProvider(**CFG).transcribe(bytes(500), language="ko", mime_type="audio/webm;codecs=opus")
    assert out["text"] == "다음으로"
    assert str(calls[0].url) == "https://api.openai.com/v1/audio/transcriptions"
    f = form_fields(calls[0])
    assert f["model"] == "stt-model"
    assert f["language"] == "ko"
    assert f["file"] == "speech.webm"


async def test_stt_prompt_echo_retries_without_language(http_mock):
    echo = "장애인연금 신청 대화. 성명, 주민등록 주소, 실거주지, 연락처, 소득·재산 신고, 가구원 수, 모의접수, 다음으로, 이전으로, 멈춰."
    replies = [echo, "Korean please"]
    calls = http_mock(lambda req: httpx.Response(200, json={"text": replies.pop(0)}))
    out = await OpenAISttProvider(**CFG).transcribe(bytes(500), language="ko", mime_type="audio/webm")
    assert out["text"] == "Korean please"
    second = form_fields(calls[1])
    assert "language" not in second
    assert "prompt" not in second


async def test_stt_echo_twice_returns_empty(http_mock):
    echo = "성명, 주민등록 주소, 실거주지, 연락처, 모의접수, 멈춰."
    http_mock(lambda req: httpx.Response(200, json={"text": echo}))
    out = await OpenAISttProvider(**CFG).transcribe(bytes(500), language="ko", mime_type="audio/webm")
    assert out["text"] == ""


async def test_stt_no_korean_prompt_for_other_languages(http_mock):
    calls = http_mock(lambda req: httpx.Response(200, json={"text": "Open Naver"}))
    await OpenAISttProvider(**CFG).transcribe(bytes(500), language="en", mime_type="audio/webm")
    f = form_fields(calls[0])
    assert f["language"] == "en"
    assert "prompt" not in f


async def test_tts_body_and_mp3(http_mock):
    calls = http_mock(lambda req: httpx.Response(200, content=bytes([1, 2, 3])))
    out = await OpenAITtsProvider(api_key="sk-test", base_url="https://api.openai.com/v1", model="tts-model", voice="coral", instructions="천천히").synthesize(
        "안녕하세요", language="ko"
    )
    assert out == {"audio": bytes([1, 2, 3]), "mimeType": "audio/mpeg"}
    assert json.loads(calls[0].content) == {"model": "tts-model", "voice": "coral", "input": "안녕하세요", "response_format": "mp3", "instructions": "천천히"}


async def test_provider_error_status_only(http_mock):
    http_mock(lambda req: httpx.Response(401, text='{"error":"bad"}'))
    with pytest.raises(VoiceProviderError):
        await OpenAISttProvider(**CFG).transcribe(bytes(500), language="ko", mime_type="audio/webm")


def test_voice_fallback_without_key_or_model():
    stt, tts = create_voice_providers(VoiceConfig(stt="openai", tts="openai", sttModel="m"))
    assert not stt.supported and not tts.supported
    stt, tts = create_voice_providers(VoiceConfig(stt="openai", tts="mock", apiKey="sk", sttModel="m"))
    assert stt.supported and not tts.supported


def test_audio_extension():
    assert audio_extension("audio/mp4") == "mp4"
    assert audio_extension("audio/ogg;codecs=opus") == "ogg"
    assert audio_extension("weird/type") == "webm"


def test_prompt_echo_detection():
    assert is_prompt_echo(
        "Disability pension application conversation. Name, resident registration address, actual residence, contact information, mock application, next, stop."
    )
    assert is_prompt_echo("성명, 주민등록 주소, 실거주지, 연락처, 모의접수, 멈춰.")
    assert not is_prompt_echo("주소는 부산광역시 예시구 예시로 10, 다음으로")
    assert not is_prompt_echo("English please")


# ---------------------------------------------------------------- LLM 의도 분석

VOCAB = field_vocabulary(create_mock_welfare_profile("http://localhost:5174"))
CTX = IntentContext(state="APPLICATION_OPEN")


def reply(content, ok=True):
    return lambda req: httpx.Response(200 if ok else 400, json={"choices": [{"message": {"content": json.dumps(content, ensure_ascii=False)}}]})


def provider(structured=True):
    return OpenAICompatibleIntentProvider(
        model="test-model",
        base_url="https://api.openai.com/v1",
        api_key="sk-test",
        structured=structured,
        rules=RuleBasedIntentProvider(VOCAB),
        vocabulary=VOCAB,
    )


async def test_rules_first_no_llm_call(http_mock):
    calls = http_mock(reply({}))
    assert (await provider().parse("다음으로", CTX))["type"] == "NEXT"
    assert calls == []


async def test_openai_strict_schema_no_temperature(http_mock):
    calls = http_mock(
        reply({"type": "FILL", "fills": [{"fieldMention": "주소", "value": "부산광역시 예시구 예시로 10"}], "fieldMention": None, "topic": None, "text": None})
    )
    intent = await provider().parse("살고 있는 데가 부산광역시 예시구 예시로 10이에요", CTX)
    assert intent == {"type": "FILL", "fills": [{"fieldMention": "주소", "value": "부산광역시 예시구 예시로 10"}]}
    body = json.loads(calls[0].content)
    assert str(calls[0].url) == "https://api.openai.com/v1/chat/completions"
    assert body["response_format"] == {"type": "json_schema", "json_schema": INTENT_JSON_SCHEMA}
    assert "temperature" not in body
    assert body["model"] == "test-model"


async def test_compatible_mode_json_object(http_mock):
    calls = http_mock(reply({"type": "HELP_HUMAN"}))
    await provider(False).parse("누구랑 직접 얘기하고 싶어", CTX)
    assert json.loads(calls[0].content)["response_format"] == {"type": "json_object"}


async def test_llm_cannot_approve_or_stop(http_mock):
    http_mock(reply({"type": "APPROVE", "fills": None, "fieldMention": None, "topic": None, "text": None}))
    assert (await provider().parse("그래 그렇게 해", CTX))["type"] == "UNKNOWN"
    enum = INTENT_JSON_SCHEMA["schema"]["properties"]["type"]["enum"]
    assert "APPROVE" not in enum and "STOP" not in enum


async def test_llm_failures_fall_back(http_mock):
    http_mock(reply({}, ok=False))
    assert (await provider().parse("음 뭐였더라", CTX))["type"] == "UNKNOWN"
    http_mock(reply({"type": "FILL", "fills": [], "fieldMention": None, "topic": None, "text": None}))
    assert (await provider().parse("음 뭐였더라", CTX))["type"] == "UNKNOWN"

    def offline(req):
        raise httpx.ConnectError("offline")

    http_mock(offline)
    assert (await provider().parse("음 뭐였더라", CTX))["type"] == "UNKNOWN"


def test_flat_unknown_uses_utterance():
    assert flat_to_intent({"type": "UNKNOWN", "text": "조작된 텍스트"}, "원래 발화") == {"type": "UNKNOWN", "text": "원래 발화"}


def test_no_key_means_rules():
    assert create_intent_provider(LlmConfig(provider="openai", model="m"), VOCAB).name == "mock-rule"
    assert create_intent_provider(LlmConfig(provider="openai", model="m", apiKey="sk"), VOCAB).name == "openai(m)+mock-rule"
