"""공통 REST API·음성 API (가짜 STT/TTS + 실제 브라우저). 서버는 ASGI로 직접 부른다(포트 없음)."""
import asyncio
from dataclasses import dataclass

import httpx
import pytest
import pytest_asyncio
from conftest import PORTAL, Gate, step

from cheongeum.core.jsutil import jdumps
from cheongeum.core.turn import TurnResult
from cheongeum.server import close_all, create_app


@pytest_asyncio.fixture
async def api(runtime):
    app, sessions = create_app(runtime)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
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

    paces: list = []

    async def synthesize(self, text, *, language, signal=None, pace=None):
        FakeTts.paces.append(pace)
        return {"audio": bytes([0xFF, 0xF3]), "mimeType": "audio/mpeg"}


@dataclass
class Voice:
    stt: FakeStt
    tts: FakeTts


@pytest_asyncio.fixture
async def voice_api(runtime):
    app, sessions = create_app(runtime, Voice(FakeStt(), FakeTts()))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        yield client
    await close_all(sessions)


AUDIO = bytes(1000)


async def test_vault_replies_require_the_presented_id_across_inputs(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]

    async def turn(text, **body):
        return (await voice_api.post("/api/turn", json={"sessionId": sid, "text": text, **body})).json()

    ask = await turn("내 이름은 박하늘이라고 저장해줘")
    save = ask["pendingConfirmation"]
    assert save["kind"] == "vault-save" and "박하늘" not in str(save)
    missing = await turn("응")
    assert missing["pendingConfirmation"]["actionId"] == save["actionId"]
    await turn("응", actionId=save["actionId"])
    ask = await turn("내 정보 지워줘")
    clear = ask["pendingConfirmation"]
    assert clear["kind"] == "vault-clear" and clear["actionId"] != save["actionId"]
    FakeStt.next_transcript = "응" + "!" * 499 + " 지우지 마세요"
    long_reply = await voice_api.post(f"/api/audio/turn?sessionId={sid}", content=AUDIO,
                                      headers={"Content-Type": "audio/webm", "X-Cheongeum-Action": clear["actionId"]})
    assert long_reply.status_code == 422 and long_reply.json()["error"] == "TRANSCRIPT_TOO_LONG"
    FakeStt.next_transcript = "응"
    for headers in ({}, {"X-Cheongeum-Action": save["actionId"]}):
        stale = await voice_api.post(f"/api/audio/turn?sessionId={sid}", content=AUDIO,
                                     headers={"Content-Type": "audio/webm", **headers})
        assert stale.json()["pendingConfirmation"]["actionId"] == clear["actionId"]
    stale_button = await voice_api.post(f"/api/session/{sid}/confirm", json={"approve": True, "actionId": save["actionId"]})
    assert stale_button.json()["pendingConfirmation"]["actionId"] == clear["actionId"]
    confirmed = await voice_api.post(f"/api/session/{sid}/confirm", json={"approve": True, "actionId": clear["actionId"]})
    assert confirmed.json()["intentType"] == "VAULT_CONFIRM"
    assert "저장된 정보가 없어요" in (await turn("내 정보 알려줘"))["speech"]


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


async def test_wake_accepts_only_current_stop_and_does_not_replay_a_task(api):
    sid = (await api.post("/api/session")).json()["sessionId"]
    path = f"/api/session/{sid}"

    async def turn(text):
        return (await api.post("/api/turn", json={"sessionId": sid, "text": text})).json()

    await turn(f"{PORTAL} 열어줘")
    approval = (await turn("이름 칸에 김하늘 써줘"))["pendingConfirmation"]["actionId"]
    stopped = await turn("멈춰")
    token = {"stopGeneration": stopped["stopGeneration"]}
    assert (await turn("다음으로"))["state"] == "STOPPED"
    before = (await api.get(f"{path}/state")).json()
    assert before["stopGeneration"] == token["stopGeneration"]
    for invalid in ({}, {"stopGeneration": True}, {"stopGeneration": -1}):
        assert (await api.post(f"{path}/wake", json=invalid)).status_code == 400
    retry = {"x-cheongeum-request": "1"}
    assert (await api.post(f"{path}/wake", json=token, headers=retry)).json() == {"state": "IDLE"}
    assert (await api.post(f"{path}/wake", json=token)).json() == {"state": "IDLE"}
    after = (await api.get(f"{path}/state")).json()
    assert "stopGeneration" not in after and "pendingConfirmation" not in after
    assert before["observation"] == after["observation"] and before["history"] == after["history"]
    stale_approval = await api.post(f"{path}/confirm", json={"approve": True, "actionId": approval})
    assert stale_approval.json()["actions"] == []
    assert (await turn("화면 설명해줘"))["semanticAction"] == "describe-screen"
    newer = (await api.post(f"{path}/cancel")).json()
    assert newer["stopGeneration"] > token["stopGeneration"]
    assert (await api.post(f"{path}/wake", json=token, headers=retry)).status_code == 409
    assert (await api.get(f"{path}/state")).json()["state"] == "STOPPED"


async def test_stop_supersedes_a_wake_waiting_on_the_session_lock(new_session):
    session = await new_session()
    first = session.cancel()
    async with session._lock:
        waiting = asyncio.create_task(session.wake(first["stopGeneration"]))
        await asyncio.sleep(0)
        second = session.cancel()
    assert await waiting is None
    assert session.state == "STOPPED"
    assert await session.wake(second["stopGeneration"]) == "IDLE"


async def test_progress_endpoint_reports_code_built_steps(runtime):
    app, sessions = create_app(runtime)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        sid = (await client.post("/api/session")).json()["sessionId"]
        url = f"/api/session/{sid}/progress"
        assert (await client.get(url)).json() == {"running": False, "seq": 0, "latest": None, "spoken": True}
        gate = Gate(
            [step("open_url", f"http://{PORTAL}"), step("click", "장애인연금 안내"), step("answer", None, "안내 기사예요.", ["두 번째 페이지입니다"])],
            at=3,
        )
        sessions.get(sid).deps.llm = gate
        turn = asyncio.create_task(client.post("/api/turn", json={"sessionId": sid, "text": f"{PORTAL}에서 장애인연금 안내 기사 내용 알려줘"}))
        await asyncio.wait_for(gate.reached.wait(), 30)
        running = (await client.get(url)).json()
        assert running == {"running": True, "seq": 2, "latest": "127.0.0.1에서 '장애인연금 안내'를 눌렀어요.", "spoken": True}
        gate.release.set()
        await turn
        assert (await client.get(url)).json()["running"] is False
        assert (await client.get("/api/session/nope/progress")).status_code == 404
    await close_all(sessions)


async def test_bad_requests_and_unsupported_voice(api):
    assert (await api.post("/api/turn", json={"sessionId": "x"})).status_code == 400
    assert (await api.post("/api/turn", json={"sessionId": "nope", "text": "안녕"})).status_code == 404
    assert (await api.post("/api/audio/transcribe")).status_code == 415
    assert (await api.post("/api/audio/transcribe", content=AUDIO, headers={"Content-Type": "audio/webm"})).status_code == 404
    sid = (await api.post("/api/session")).json()["sessionId"]
    assert (await api.post(f"/api/audio/transcribe?sessionId={sid}", content=AUDIO, headers={"Content-Type": "audio/webm"})).status_code == 501
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


async def test_while_busy_only_a_stop_word_is_acted_on(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]
    await say(voice_api, sid, "장애인연금 신청 도와줘")

    async def heard_while_busy(transcript: str) -> dict:
        FakeStt.next_transcript = transcript
        res = await voice_api.post(f"/api/audio/stop?sessionId={sid}", content=AUDIO, headers={"Content-Type": "audio/webm"})
        assert res.status_code == 200
        return res.json()

    assert await heard_while_busy("이름은 김하늘") == {"stopped": False}
    state = (await voice_api.get(f"/api/session/{sid}/state")).json()
    assert state["state"] == "APPLICATION_OPEN"
    assert not any("김하늘" in h["text"] for h in state["history"])
    stopped = await heard_while_busy("멈춰")
    assert stopped["stopped"] is True
    assert stopped["result"]["state"] == "STOPPED"


async def test_while_busy_a_progress_question_is_answered(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]
    FakeStt.next_transcript = "청음아, 지금 어디까지 했어?"
    res = (await voice_api.post(f"/api/audio/stop?sessionId={sid}", content=AUDIO, headers={"Content-Type": "audio/webm"})).json()
    assert res["stopped"] is False
    assert res["result"]["intentType"] == "PROGRESS"
    assert res["result"]["speech"] == "지금 하고 있는 일은 없어요."


async def test_spoken_password_never_returned(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]
    _, body = await say(voice_api, sid, "비밀번호는 556677이야")
    assert body["state"] == "AUTH_HANDOFF"
    assert "556677" not in jdumps(body)
    snap = (await voice_api.get(f"/api/session/{sid}/state")).text
    assert "556677" not in snap

    FakeStt.next_transcript = "주민번호 900101-1234567"
    clean_session = (await voice_api.post("/api/session")).json()["sessionId"]
    t = (await voice_api.post(f"/api/audio/transcribe?sessionId={clean_session}", content=AUDIO, headers={"Content-Type": "audio/webm"})).json()
    assert t["secretDetected"] is True
    assert "1234567" not in t["text"]


async def test_empty_transcript_tts_health(voice_api):
    sid = (await voice_api.post("/api/session")).json()["sessionId"]
    assert (await say(voice_api, sid, ""))[0] == 422
    speak = await voice_api.post("/api/audio/speak", json={"text": "안녕하세요"})
    assert "audio/mpeg" in speak.headers["content-type"]
    # 웹 화면의 말 빠르기 설정(천천히 0.9, 보통 1.25)이 서버 음성 속도로 간다
    await voice_api.post("/api/audio/speak", json={"text": "안녕하세요", "rate": 0.9})
    assert FakeTts.paces[-2:] == [None, pytest.approx(0.72)]
    health = (await voice_api.get("/api/health")).json()
    # localLanguages: 음성이 이 컴퓨터 밖으로 나가지 않는 언어(가짜 STT는 외부로 보는 셈)
    assert health["stt"] == {"provider": "fake", "supported": True, "localLanguages": [], "liveModel": None}
