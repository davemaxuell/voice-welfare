"""로컬 받아쓰기(faster-whisper)·언어별 공급자 고르기·설정 순서. 실제 모델 없이 가짜 엔진으로 돈다."""
import httpx
import pytest

from cheongeum.core.jsutil import AbortController, AbortError
from cheongeum.evaluation.asr import cer, digit_runs
from cheongeum.server.runtime import load_config
from cheongeum.voice import (
    LanguageRoutedStt,
    LocalWhisperStt,
    OpenAISttProvider,
    UnsupportedSttProvider,
    create_voice_providers,
    is_hallucination,
)
from cheongeum.voice.stt import STT_PROMPT


class FakeEngine:
    def __init__(self, reply: str = "다음으로") -> None:
        self.reply = reply
        self.calls: list[tuple] = []

    def __call__(self, audio, language, prompt):
        self.calls.append((audio, language, prompt))
        return self.reply


async def test_local_transcribes_without_prompt_by_default():
    engine = FakeEngine(" 장애인연금 신청 도와줘 ")
    out = await LocalWhisperStt("models/x", engine=engine).transcribe(b"abc", language="ko", mime_type="audio/webm;codecs=opus")
    assert out == {"text": "장애인연금 신청 도와줘"}
    assert engine.calls == [(b"abc", "ko", None)]


async def test_local_prompt_only_for_korean_when_enabled():
    engine = FakeEngine()
    stt = LocalWhisperStt("models/x", engine=engine, use_prompt=True)
    await stt.transcribe(b"a", language="ko", mime_type="audio/webm")
    await stt.transcribe(b"a", language="en", mime_type="audio/webm")
    assert [c[2] for c in engine.calls] == [STT_PROMPT, None]


@pytest.mark.parametrize("reply", ["시청해 주셔서 감사합니다.", "구독과 좋아요 부탁드립니다", "MBC 뉴스 이덕영입니다.", "정부24, 주민등록등본, 국민신문고, 민원, 한국장학재단, 국가장학금."])
async def test_local_drops_silence_hallucinations_and_prompt_echo(reply):
    out = await LocalWhisperStt("models/x", engine=FakeEngine(reply)).transcribe(b"a", language="ko", mime_type="audio/webm")
    assert out == {"text": ""}


def test_hallucination_keeps_real_utterances():
    assert is_hallucination("시청해주셔서 감사합니다")
    assert not is_hallucination("감사합니다")
    assert not is_hallucination("뉴스 읽어줘")
    assert not is_hallucination("구독 서비스 알려줘")


async def test_local_stop_signal_does_not_wait():
    controller = AbortController()
    controller.abort()
    with pytest.raises(AbortError):
        await LocalWhisperStt("models/x", engine=FakeEngine()).transcribe(b"a", language="ko", mime_type="audio/webm", signal=controller.signal)


async def test_routing_korean_local_others_openai(http_mock):
    calls = http_mock(lambda req: httpx.Response(200, json={"text": "Open Naver"}))
    engine = FakeEngine("네이버 열어줘")
    other = OpenAISttProvider(api_key="sk-test", base_url="https://api.openai.com/v1", model="stt-model")
    stt = LanguageRoutedStt(LocalWhisperStt("models/whisper-small-komixv2-ct2", engine=engine), other)
    assert stt.name == "local(whisper-small-komixv2)+openai(stt-model)"
    assert stt.localLanguages == ["ko"]

    assert (await stt.transcribe(b"a", language="ko", mime_type="audio/webm"))["text"] == "네이버 열어줘"
    assert calls == []  # 한국어 음성은 밖으로 나가지 않는다
    assert (await stt.transcribe(b"a", language="en", mime_type="audio/webm"))["text"] == "Open Naver"
    assert len(calls) == 1 and len(engine.calls) == 1


async def test_routing_without_openai_keeps_every_language_local():
    engine = FakeEngine("Open Naver")
    stt = LanguageRoutedStt(LocalWhisperStt("models/x", engine=engine), None, all_languages=("ko", "en", "zh", "ja"))
    assert stt.localLanguages == ["ko", "en", "zh", "ja"]
    await stt.transcribe(b"a", language="en", mime_type="audio/webm")
    assert engine.calls[0][1] == "en"


@pytest.mark.parametrize("legacy", ["local", "browser", "mock"])
def test_legacy_settings_use_only_authenticated_voice_apis(legacy):
    env = {"STT_PROVIDER": legacy, "TTS_PROVIDER": legacy, "STT_LOCAL_MODEL": "old/model", "STT_BASE_URL": "http://localhost:8000/v1"}
    stt, tts = create_voice_providers(load_config(env).voice)
    assert isinstance(stt, UnsupportedSttProvider) and not tts.supported
    stt, tts = create_voice_providers(load_config({**env, "OPENAI_API_KEY": "sk-test"}).voice)
    assert isinstance(stt, OpenAISttProvider) and tts.supported
    assert stt.base_url == tts.base_url == "https://api.openai.com/v1"


def test_cer_and_digit_runs():
    assert cer("다음으로 가줘", "다음으로 가 줘.") == 0.0
    assert cer("네이버 열어줘", "네이버 열어") == pytest.approx(1 / 6)
    assert cer("", "") == 0.0 and cer("", "아") == 1.0
    assert digit_runs("연락처는 010-1234-5678이에요") == ["01012345678"]
    assert digit_runs("공일공 일이삼사 오육칠팔") == ["01012345678"]
