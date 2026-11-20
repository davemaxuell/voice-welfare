"""Relay microphone audio. A one-use receipt lets existing turn and Stop endpoints consume the final privately."""
from __future__ import annotations

import asyncio
import json
import secrets

from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from cheongeum.safety import redact_text
from cheongeum.server.recovery import RequestConflict
from cheongeum.server.request_policy import TURN_TEXT_LIMIT, origin_refusal
from cheongeum.understanding.rules import is_stop_utterance
from cheongeum.voice.live import SAMPLE_RATE


class TranscriptTooLong(Exception):
    pass


def turn_transcript(text: str) -> str:
    text = text.strip()
    if len(text) <= TURN_TEXT_LIMIT:
        return text
    if is_stop_utterance(redact_text(text)):
        return "멈춰"
    raise TranscriptTooLong


class LiveAudio:
    def __init__(self):
        self._receipts: dict[str, tuple[str, object, int, str]] = {}
        self._active: dict[str, int] = {}

    def take(self, token, sid: str, ledger, generation: int) -> str:
        record = self._receipts.get(token) if isinstance(token, str) else None
        if record is None or record[0] != sid or record[1] is not ledger or record[2] != generation:
            raise RequestConflict
        del self._receipts[token]
        return record[3]

    def register(self, app, audio_services, sessions, access_writer, voice_error, port):
        @app.websocket("/api/session/{sid}/audio/live")
        async def microphone(socket: WebSocket, sid: str):
            scheme = "https" if socket.url.scheme == "wss" else "http"
            if origin_refusal(socket.headers, scheme, port, required=True):
                await socket.close(code=1008)
                return
            await socket.accept()
            active = False
            try:
                async with asyncio.timeout(5):
                    hello = await socket.receive_json()
                writer = hello.get("writer", "") if isinstance(hello, dict) else None
                if not isinstance(writer, str) or len(writer) > 128:
                    raise RequestConflict
                session = access_writer(sid, writer)
                if isinstance(session, Response) or session.consent_status != "granted" or session.dialogue.auth_waiting:
                    raise RequestConflict
                upstream = getattr(audio_services.stt, "live", None)
                if upstream is None:
                    await socket.send_json({"error": "NOT_SUPPORTED", "message": "이용 설정에서 음성 API 키를 확인해 주세요."})
                    return
                ledger, generation = sessions.ledgers[sid], session.generation
                if self._active.get(sid, 0) >= 2:
                    raise RequestConflict
                self._active[sid] = self._active.get(sid, 0) + 1
                active = True

                def current():
                    if (sessions.ledgers.get(sid) is not ledger or session.generation != generation
                            or session.consent_status != "granted" or session.dialogue.auth_waiting
                            or getattr(audio_services.stt, "live", None) is not upstream):
                        raise RequestConflict

                async def frames():
                    size = 0
                    while True:
                        message = await socket.receive()
                        if message["type"] == "websocket.disconnect":
                            raise WebSocketDisconnect()
                        current()
                        if message.get("text") == "commit":
                            return
                        frame = message.get("bytes")
                        if not frame or len(frame) % 2 or len(frame) > 65536:
                            raise ValueError("invalid PCM frame")
                        size += len(frame)
                        if size > SAMPLE_RATE * 2 * 30:
                            raise ValueError("utterance too long")
                        yield frame

                async with asyncio.timeout(55):
                    text = turn_transcript(await upstream.transcribe(frames(), session.lang))
                current()
                # Only the server holds the final. A dropped recording cannot dispatch an action.
                for old in [k for k, row in self._receipts.items() if row[0] == sid][:-1]:
                    self._receipts.pop(old, None)
                token = secrets.token_urlsafe(24)
                self._receipts[token] = (sid, ledger, generation, text)
                asyncio.get_running_loop().call_later(30, self._receipts.pop, token, None)
                await socket.send_json({"receipt": token})
            except WebSocketDisconnect:
                return
            except (ValueError, RequestConflict):
                await socket.send_json({"error": "REQUEST_CONFLICT", "message": "듣기가 끝났어요. 다시 말씀해 주세요."})
            except Exception as exc:
                await socket.send_json(json.loads(voice_error(exc).body))
            finally:
                if active:
                    self._active[sid] -= 1
                    if not self._active[sid]:
                        del self._active[sid]
                if socket.client_state.name != "DISCONNECTED":
                    try:
                        await socket.close()
                    except (RuntimeError, WebSocketDisconnect):
                        pass
