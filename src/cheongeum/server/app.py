"""
공통 REST API(FastAPI). PC 웹 클라이언트와 데스크톱 앱이 쓴다.
요청 본문(발화)은 로그로 남기지 않는다.
"""
from __future__ import annotations

import json
import logging
import mimetypes
from collections import OrderedDict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from cheongeum.core.turn import LANGS
from cheongeum.orchestrator import SessionOrchestrator
from cheongeum.safety import detect_sensitive, redact_text
from cheongeum.server.runtime import AgentRuntime
from cheongeum.understanding.rules import is_progress_question, is_stop_utterance
from cheongeum.voice import VoiceNotSupportedError

log = logging.getLogger("cheongeum.server")

# 윈도 레지스트리가 .js를 text/plain으로 알려 주면 모듈 스크립트가 막히므로 직접 정한다.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")

MAX_SESSIONS = 3
JSON_LIMIT = 16 * 1024
AUDIO_LIMIT = 10 * 1024 * 1024


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": code, "message": message}, status_code=status)


def _local_languages(stt: Any) -> list[str]:
    """음성이 이 컴퓨터 밖으로 나가지 않는 언어(동의·도움말 문구용). 로컬 OpenAI 호환 서버면 모든 언어."""
    if not stt.supported:
        return []
    langs = getattr(stt, "localLanguages", None)
    if langs is not None:
        return list(langs)
    return list(LANGS) if str(stt.name).startswith("local(") else []


async def _json_body(request: Request) -> dict | None:
    raw = await request.body()
    if len(raw) > JSON_LIMIT:
        return None
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


class Sessions:
    """세션 저장소(오래된 것부터 닫는다)."""

    def __init__(self) -> None:
        self._items: "OrderedDict[str, SessionOrchestrator]" = OrderedDict()

    def get(self, sid: str) -> SessionOrchestrator | None:
        return self._items.get(sid)

    def __len__(self) -> int:
        return len(self._items)

    def add(self, s: SessionOrchestrator) -> None:
        self._items[s.id] = s

    def pop_oldest(self) -> SessionOrchestrator:
        _, s = self._items.popitem(last=False)
        return s

    def remove(self, sid: str) -> None:
        self._items.pop(sid, None)

    def values(self) -> list[SessionOrchestrator]:
        return list(self._items.values())

    def clear(self) -> None:
        self._items.clear()


def create_app(runtime: AgentRuntime, voice: Any = None, lifespan: Any = None) -> tuple[FastAPI, Sessions]:
    """→ (app, sessions). 종료 시 close_all(sessions)를 부른다."""
    stt = voice.stt if voice is not None else runtime.stt
    tts = voice.tts if voice is not None else runtime.tts
    app = FastAPI(title="청음 API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    sessions = Sessions()
    app.state.sessions = sessions
    app.state.runtime = runtime

    def voice_error(e: Exception) -> JSONResponse:
        if isinstance(e, VoiceNotSupportedError):
            return _err(501, "NOT_SUPPORTED", str(e))
        log.error("[server] voice error %s", type(e).__name__)
        return _err(502, "VOICE_PROVIDER", "음성 서비스 호출에 실패했습니다. 잠시 후 다시 시도하거나 텍스트로 입력하세요.")

    async def transcribe(request: Request, language: str = "ko") -> str:
        if not stt.supported:
            raise VoiceNotSupportedError("서버 STT가 설정되지 않았습니다. 브라우저 음성 인식이나 텍스트 입력을 사용하세요.")
        content_type = request.headers.get("content-type") or "audio/webm"
        audio = await request.body() if content_type.startswith("audio/") or content_type.startswith("application/octet-stream") else b""
        if len(audio) > AUDIO_LIMIT:
            audio = b""
        if len(audio) < 200:
            return ""
        return (await stt.transcribe(audio, language=language, mime_type=content_type))["text"]

    def not_found() -> JSONResponse:
        return _err(404, "SESSION_NOT_FOUND", "세션이 없습니다. 새 세션을 시작하세요.")

    @app.exception_handler(Exception)
    async def on_error(_request: Request, exc: Exception) -> JSONResponse:
        # 오류 메시지에 사용자 입력이 섞일 수 있어 이름만 기록한다.
        log.error("[server] error %s", type(exc).__name__)
        return _err(500, "INTERNAL", "서버 오류가 발생했습니다. 모의 사이트와 브라우저가 실행 중인지 확인하세요.")

    @app.get("/api/health")
    async def health() -> dict:
        roles = runtime.llm_roles()
        return {
            "ok": True,
            "llmProvider": runtime.intent_provider.name,
            "llmRoles": roles,
            "welfareData": runtime.welfare_provider.mode,
            "stt": {"provider": stt.name, "supported": stt.supported, "localLanguages": _local_languages(stt)},
            "tts": {"provider": tts.name, "supported": tts.supported},
            "mockOnly": True,
        }

    @app.post("/api/session")
    async def create_session() -> dict:
        # 새로고침 등으로 세션이 쌓이면 오래된 것부터 닫는다(브라우저 창도 함께 닫힘).
        while len(sessions) >= MAX_SESSIONS:
            oldest = sessions.pop_oldest()
            try:
                await oldest.close()
            except Exception:  # noqa: BLE001
                pass
        s = await runtime.create_session()
        sessions.add(s)
        return {
            "sessionId": s.id,
            "state": s.state,
            "llmProvider": runtime.intent_provider.name,
            "mockOnly": True,
            "consentRequired": s.consent_status != "granted",
            "speechPrefs": s.snapshot().get("speechPrefs"),
        }

    @app.post("/api/turn")
    async def turn(request: Request) -> Any:
        body = await _json_body(request)
        sid = body.get("sessionId") if body else None
        text = body.get("text") if body else None
        platform = (body or {}).get("clientPlatform", "pc")
        if (
            not isinstance(sid, str)
            or not sid
            or not isinstance(text, str)
            or not (1 <= len(text.strip()) <= 500)
            or platform != "pc"
        ):
            return _err(400, "BAD_REQUEST", "sessionId와 text(1~500자)가 필요합니다.")
        s = sessions.get(sid)
        if not s:
            return _err(404, "SESSION_NOT_FOUND", "세션이 없습니다.")
        return await s.handle_turn(text.strip())

    @app.get("/api/session/{sid}/state")
    async def state(sid: str) -> Any:
        s = sessions.get(sid)
        return s.snapshot() if s else not_found()

    @app.post("/api/session/{sid}/confirm")
    async def confirm(sid: str, request: Request) -> Any:
        body = await _json_body(request)
        if not body or not isinstance(body.get("approve"), bool):
            return _err(400, "BAD_REQUEST", "approve(boolean)가 필요합니다.")
        s = sessions.get(sid)
        if not s:
            return not_found()
        return await s.confirm(body["approve"])

    @app.post("/api/session/{sid}/consent")
    async def consent(sid: str, request: Request) -> Any:
        """시작 동의(화면 읽기·브라우저 조작·음성 외부 전송). 동의 전에는 받아쓰기도 하지 않는다."""
        body = await _json_body(request)
        if not body or not isinstance(body.get("granted"), bool):
            return _err(400, "BAD_REQUEST", "granted(boolean)가 필요합니다.")
        s = sessions.get(sid)
        if not s:
            return not_found()
        return await s.consent_to(body["granted"])

    @app.get("/api/session/{sid}/reminders")
    async def reminders(sid: str) -> Any:
        """신청 기록 중 기한이 가까운 것(데스크톱 앱이 주기적으로 물어 소리로 알린다)"""
        s = sessions.get(sid)
        if not s:
            return not_found()
        return {"text": s.reminders() if s.consent_status == "granted" else None}

    @app.get("/api/session/{sid}/progress")
    async def progress(sid: str) -> Any:
        """
        목표 수행 진행 상황. 화면은 일하는 동안 몇 초마다 물어 새 단계(seq가 커짐)를 소리로 알린다.
        latest는 코드가 행동·대상 이름·사이트로 만든 문장뿐이다(화면 글·모델 글 아님). spoken = 묻지 않아도 알릴지.
        """
        s = sessions.get(sid)
        return s.progress.snapshot() if s else not_found()

    @app.post("/api/session/{sid}/language")
    async def language(sid: str, request: Request) -> Any:
        """대화 언어 바꾸기(ko/en/zh/ja). 음성 "영어로 말해줘"와 같은 경로."""
        body = await _json_body(request)
        lang = (body or {}).get("lang")
        if lang not in LANGS:
            return _err(400, "BAD_REQUEST", "lang은 ko, en, zh, ja 중 하나입니다.")
        s = sessions.get(sid)
        if not s:
            return not_found()
        return await s.set_language(lang)

    @app.post("/api/session/{sid}/cancel")
    async def cancel(sid: str) -> Any:
        s = sessions.get(sid)
        return s.cancel() if s else not_found()

    @app.delete("/api/session/{sid}")
    async def delete(sid: str) -> Any:
        s = sessions.get(sid)
        if not s:
            return not_found()
        sessions.remove(sid)
        await s.close()
        return {"ok": True}

    @app.post("/api/audio/turn")
    async def audio_turn(request: Request, sessionId: str = "") -> Any:  # noqa: N803 — 원본 API의 쿼리 이름
        """
        음성 한 턴: 받아쓰기 → 곧바로 세션 턴 처리. 받아쓴 원문은 클라이언트로 돌려주지 않는다
        (응답의 userUtterance는 비식별화된 문장). 비밀번호 등을 말해도 화면·로그에 남지 않게 하기 위함.
        """
        s = sessions.get(sessionId)
        if not s:
            return _err(404, "SESSION_NOT_FOUND", "세션이 없습니다.")
        # 동의 전에는 음성을 외부 받아쓰기 서비스로 보내지 않는다.
        if s.consent_status != "granted":
            return _err(403, "CONSENT_REQUIRED", "먼저 시작 안내에 동의해 주세요.")
        try:
            # 받아쓰기 언어는 세션의 대화 언어를 따른다(영어 모드면 영어로 받아씀)
            text = await transcribe(request, s.lang)
        except Exception as e:  # noqa: BLE001
            return voice_error(e)
        if not text:
            return _err(422, "EMPTY_TRANSCRIPT", "말씀을 알아듣지 못했습니다. 다시 말씀해 주세요.")
        return await s.handle_turn(text[:500])

    @app.post("/api/audio/stop")
    async def audio_stop(request: Request, sessionId: str = "") -> Any:  # noqa: N803
        """
        일하는 동안 들은 말: 멈춤 말과 진행 상황 물음('지금 어디까지 했어?')만 받는다. 둘 다 턴 대기열을 거치지 않는다.
        그 밖의 말은 받아쓴 뒤 버린다. 기록에도 남기지 않는다.
        """
        s = sessions.get(sessionId)
        if not s:
            return _err(404, "SESSION_NOT_FOUND", "세션이 없습니다.")
        if s.consent_status != "granted":
            return _err(403, "CONSENT_REQUIRED", "먼저 시작 안내에 동의해 주세요.")
        try:
            text = await transcribe(request, s.lang)
        except Exception as e:  # noqa: BLE001
            return voice_error(e)
        said = redact_text(text) if text else ""
        if is_stop_utterance(said):
            return {"stopped": True, "result": await s.handle_turn(text[:500])}
        if is_progress_question(said):
            return {"stopped": False, "result": await s.handle_turn(text[:500])}
        return {"stopped": False}

    @app.post("/api/audio/transcribe")
    async def audio_transcribe(request: Request) -> Any:
        """받아쓰기만(PRD API). 결과는 비식별화해서 돌려준다."""
        try:
            text = await transcribe(request)
        except Exception as e:  # noqa: BLE001
            return voice_error(e)
        return {"text": redact_text(text), "secretDetected": detect_sensitive(text).hasSecretValue, "provider": stt.name}

    @app.post("/api/audio/speak")
    async def audio_speak(request: Request) -> Any:
        body = await _json_body(request)
        text = (body or {}).get("text")
        lang = (body or {}).get("lang")
        if not isinstance(text, str) or not (1 <= len(text.strip()) <= 1000) or (lang is not None and lang not in LANGS):
            return _err(400, "BAD_REQUEST", "text(1~1000자)가 필요합니다.")
        try:
            out = await tts.synthesize(text.strip(), language=lang or "ko")
        except Exception as e:  # noqa: BLE001
            return voice_error(e)
        return Response(content=out["audio"], media_type=out["mimeType"])

    @app.get("/api/events")
    async def events() -> dict:
        """사용자 테스트 분석용 비식별 이벤트(액션 종류·성공·지연·오류 코드만, 발화·입력값 없음)"""
        return {"events": runtime.events.all()}

    @app.get("/api/welfare/services")
    async def welfare_services(q: str = "") -> dict:
        services = await runtime.welfare_provider.list_services(q)
        return {"mode": runtime.welfare_provider.mode, "services": services}

    return app, sessions


WEB_DIR = Path(__file__).resolve().parents[1] / "web" / "static"
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "media-src 'self' blob: data:; connect-src 'self'"
)


def mount_web_ui(app: FastAPI, csp: bool = False) -> FastAPI:
    """웹 UI(빌드 없는 정적 파일)를 같은 포트로 서빙한다. 모든 /api 경로를 등록한 뒤에 부른다."""
    if csp:

        @app.middleware("http")
        async def _csp(request: Request, call_next):
            # 앱 화면은 자기 출처만 쓴다(외부 스크립트 차단). 음성 재생은 blob/data URL을 쓸 수 있다.
            response = await call_next(request)
            response.headers["Content-Security-Policy"] = CSP
            return response

    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
    return app


async def close_all(sessions: Sessions) -> None:
    for s in sessions.values():
        try:
            await s.close()
        except Exception:  # noqa: BLE001
            pass
    sessions.clear()
