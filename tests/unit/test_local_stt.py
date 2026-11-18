"""로컬 받아쓰기(faster-whisper)·언어별 공급자 고르기·설정 순서. 실제 모델 없이 가짜 엔진으로 돈다."""
import httpx
import pytest

from cheongeum.core.jsutil import AbortController, AbortError
from cheongeum.evaluation.asr import cer, digit_runs
from cheongeum.voice import (
    LanguageRoutedStt,
    LocalWhisperStt,
    OpenAISttProvider,
    UnsupportedSttProvider,
    VoiceConfig,
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


@pytest.mark.parametrize("reply", ["시청해 주셔서 감사합니다.", "구독과 좋아요 부탁드립니다", "MBC 뉴스 이덕영입니다.", "성명, 주민등록 주소, 실거주지, 연락처, 모의접수, 멈춰."])
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


def fake_model_dir(tmp_path):
    (tmp_path / "model.bin").write_bytes(b"x")
    (tmp_path / "tokenizer.json").write_text("{}", encoding="utf-8")
    return str(tmp_path)


def test_config_precedence(tmp_path):
    # STT_BASE_URL이 있으면 기존 OpenAI 호환 로컬 서버
    stt, _ = create_voice_providers(VoiceConfig(stt="local", sttBaseUrl="http://127.0.0.1:8000/v1", sttLocalModel=fake_model_dir(tmp_path)))
    assert isinstance(stt, OpenAISttProvider) and stt.name == "local(http://127.0.0.1:8000/v1)"
    # 모델 폴더가 비었으면 끈다: 한국어 음성을 몰래 OpenAI로 보내지 않는다
    stt, _ = create_voice_providers(VoiceConfig(stt="local", sttLocalModel=str(tmp_path / "missing"), apiKey="sk", sttModel="m"))
    assert isinstance(stt, UnsupportedSttProvider)


def test_config_local_with_and_without_openai(tmp_path):
    model_dir = fake_model_dir(tmp_path)
    stt, _ = create_voice_providers(VoiceConfig(stt="local", sttLocalModel=model_dir, apiKey="sk", sttModel="gpt-4o-mini-transcribe", sttLocalBeam=3))
    assert isinstance(stt, LanguageRoutedStt)
    assert stt.localLanguages == ["ko"] and isinstance(stt.other, OpenAISttProvider)
    assert stt.local.beam_size == 3
    stt, _ = create_voice_providers(VoiceConfig(stt="local", sttLocalModel=model_dir))
    assert stt.other is None and stt.localLanguages == ["ko", "en", "zh", "ja"]


def test_cer_and_digit_runs():
    assert cer("다음으로 가줘", "다음으로 가 줘.") == 0.0
    assert cer("네이버 열어줘", "네이버 열어") == pytest.approx(1 / 6)
    assert cer("", "") == 0.0 and cer("", "아") == 1.0
    assert digit_runs("연락처는 010-1234-5678이에요") == ["01012345678"]
    assert digit_runs("공일공 일이삼사 오육칠팔") == ["01012345678"]
