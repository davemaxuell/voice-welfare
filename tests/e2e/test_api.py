"""공통 REST API·음성 API (가짜 STT/TTS + 실제 브라우저). 서버는 ASGI로 직접 부른다(포트 없음)."""
from dataclasses import dataclass

import httpx
import pytest_asyncio

from ieum.core.jsutil import jdumps
from ieum.core.turn import TurnResult
from ieum.server import close_all, create_app


@pytest_asyncio.fixture(scope="module")
async def api(runtime):
    app, sessions = create_app(runtime)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client
    await close_all(sessions)


class FakeStt:
    name = "fake"
    supported = True
    next_transcript = ""

    async def transcribe(self, audio, *, language, mime_type, signal=None):
        return {"text": FakeStt.next_transcript}


class FakeTts:
    name = "fake"
    supported = True

    async def synthesize(self, text, *, language, signal=None):
        return {"audio": bytes([0xFF, 0xF3]), "mimeType": "audio/mpeg"}


@dataclass
class Voice:
    stt: FakeStt
    tts: FakeTts


@pytest_asyncio.fixture(scope="module")
async def voice_api(runtime):
    app, sessions = create_app(runtime, Voice(FakeStt(), FakeTts()))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client
    await close_all(sessions)


AUDIO = bytes(1000)


async def say(client, session_id: str, transcript: str):
    FakeStt.next_transcript = transcript
    res = await client.post(f"/api/audio/turn?sessionId={session_id}", content=AUDIO, headers={"Content-Type": "audio/webm"})
    return res.status_code, res.json()


# ---------------------------------------------------------------- Shared REST API


async def test_session_turn_state_cancel(api):
    created = await api.post("/api/session")
    assert created.status_code == 200
    sid = created.json()["sessionId"]

    turn = await api.post("/api/turn", json={"sessionId": sid, "text": "장애인연금 신청 도와줘"})
    assert turn.status_code == 200
    assert TurnResult.model_validate(turn.json()).state == "APPLICATION_OPEN"

    no_pending = await api.post(f"/api/session/{sid}/confirm", json={"approve": True})
    assert no_pending.json()["state"] == "APPLICATION_OPEN"

    await api.post("/api/turn", json={"sessionId": sid, "text": "비밀번호는 987654야"})
    snap = (await api.get(f"/api/session/{sid}/state")).json()
    assert "987654" not in jdumps(snap)

    cancelled = await api.post(f"/api/session/{sid}/cancel")
    assert cancelled.json()["state"] == "STOPPED"


async def test_bad_requests_and_unsupported_voice(api):
    assert (await api.post("/api/turn", json={"sessionId": "x"})).status_code == 400
    assert (await api.post("/api/turn", json={"sessionId": "nope", "text": "안녕"})).status_code == 404
    assert (await api.post("/api/audio/transcribe")).status_code == 501
    services = (await api.get("/api/welfare/services", params={"q": "장애인연금"})).json()
    assert services["mode"] == "fixture"
    assert services["services"][0]["source"]["url"].startswith("https://")


# ---------------------------------------------------------------- 음성 API


async def test_voice_turn_reaches_screen(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]
    assert (await say(voice_api, sid, "장애인연금 신청 도와줘"))[1]["state"] == "APPLICATION_OPEN"
    _, filled = await say(voice_api, sid, "이름은 김하늘")
    assert filled["field"] == "applicantName"
    assert filled["value"] == "김하늘"


async def test_spoken_password_never_returned(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]
    _, body = await say(voice_api, sid, "비밀번호는 556677이야")
    assert body["state"] == "AUTH_HANDOFF"
    assert "556677" not in jdumps(body)
    snap = (await voice_api.get(f"/api/session/{sid}/state")).text
    assert "556677" not in snap

    FakeStt.next_transcript = "주민번호 900101-1234567"
    t = (await voice_api.post("/api/audio/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"})).json()
    assert t["secretDetected"] is True
    assert "1234567" not in t["text"]


async def test_empty_transcript_tts_health(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]
    assert (await say(voice_api, sid, ""))[0] == 422
    speak = await voice_api.post("/api/audio/speak", json={"text": "안녕하세요"})
    assert "audio/mpeg" in speak.headers["content-type"]
    health = (await voice_api.get("/api/health")).json()
    assert health["stt"] == {"provider": "fake", "supported": True}
