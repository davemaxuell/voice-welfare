"""Live microphone transport, consent and final-only turn dispatch."""
import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from starlette.testclient import TestClient
from websockets.asyncio.server import serve

from cheongeum.server.app import create_app
from cheongeum.voice.live import LIVE_MODEL, LiveTranscriber


async def test_streams_before_commit_and_uses_only_the_matching_final():
    first_frame = asyncio.Event()
    async def upstream(ws):
        assert ws.request.path == "/v1/realtime?intent=transcription"
        assert ws.request.headers["Authorization"] == "Bearer test-key"
        config = json.loads(await ws.recv())["session"]["audio"]["input"]
        assert config["transcription"]["model"] == LIVE_MODEL
        assert "ko" in config["transcription"]["languages"] and "정부24" in config["transcription"]["keywords"]
        assert config["turn_detection"] is None and config["format"] == {"type": "audio/pcm", "rate": 24000}
        await ws.send(json.dumps({"type": "session.updated"}))
        total = bytearray()
        async for msg in ws:
            event = json.loads(msg)
            if event["type"] == "input_audio_buffer.append":
                total.extend(base64.b64decode(event["audio"]))
                first_frame.set()
                continue
            assert event["type"] == "input_audio_buffer.commit" and len(total) == 9600
            for event in [
                {"type": "input_audio_buffer.committed", "item_id": "mine"},
                {"type": "conversation.item.input_audio_transcription.delta", "item_id": "mine", "delta": "로그인해"},
                {"type": "conversation.item.input_audio_transcription.completed", "item_id": "other", "transcript": "멈춰"},
                {"type": "conversation.item.input_audio_transcription.completed", "item_id": "mine", "transcript": "국가장학금 서류 알려줘"},
            ]:
                await ws.send(json.dumps(event))
            break

    async def frames():
        yield bytes(4800)
        await asyncio.wait_for(first_frame.wait(), 3)
        yield bytes(4800)

    async with serve(upstream, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        client = LiveTranscriber(f"http://127.0.0.1:{port}/v1", "test-key")
        assert await client.transcribe(frames(), "ko") == "국가장학금 서류 알려줘"


def test_live_receipt_requires_consent_preserves_privacy_and_is_consumed_once():
    class Provider:
        text = "등본 발급 방법"
        async def transcribe(self, frames, language):
            assert sum([len(f) async for f in frames]) == 6000
            return self.text

    rt = SimpleNamespace(stt=SimpleNamespace(supported=True, live=Provider()))
    app, sessions = create_app(rt)
    session = SimpleNamespace(id="test", lang="ko", dialogue=SimpleNamespace(auth_waiting=False, confirmation=None),
                              consent_status="pending", generation=0, handle_turn=AsyncMock(return_value={"actions": []}))
    sessions.add(session)
    addr = "/api/session/test/audio/live"
    with TestClient(app, base_url="http://localhost") as client:
        def recording(send=True):
            with client.websocket_connect(addr, headers={"host": "localhost", "origin": "http://localhost"}) as ws:
                ws.send_json({"writer": ""})
                if send:
                    ws.send_bytes(bytes(6000))
                    ws.send_text("commit")
                return ws.receive_json()
        assert recording(False)["error"] == "REQUEST_CONFLICT"
        session.consent_status = "granted"
        with client.websocket_connect(addr, headers={"host": "localhost", "origin": "http://localhost"}) as cancelled:
            cancelled.send_json({"writer": ""})
            cancelled.send_bytes(bytes(3000))
        session.handle_turn.assert_not_called()
        receipt = recording()
        assert set(receipt) == {"receipt"} and "등본" not in str(receipt)
        session.handle_turn.assert_not_called()
        sessions.add(SimpleNamespace(**{**vars(session), "id": "second"}))
        assert client.post("/api/audio/turn?sessionId=second", json=receipt).status_code == 409
        headers = {"X-Cheongeum-Request": "1"}
        for _ in range(2):
            res = client.post("/api/audio/turn?sessionId=test", json=receipt, headers=headers)
            assert res.json() == {"actions": []}
        session.handle_turn.assert_awaited_once_with("등본 발급 방법", approval_id="", from_voice=True)
        assert client.post("/api/audio/turn?sessionId=test", json=receipt).status_code == 409
        receipt = recording()
        session.generation += 1
        assert client.post("/api/audio/turn?sessionId=test", json=receipt).status_code == 409
        assert client.post("/api/audio/stop?sessionId=test", json=recording()).json() == {"stopped": False}
        rt.stt.live.text = "멈춰"
        assert client.post("/api/audio/stop?sessionId=test", json=recording()).json()["stopped"]
        rt.stt.live.text = "응" + "!" * 499 + " 지우지 마세요"
        assert recording()["error"] == "TRANSCRIPT_TOO_LONG"
