"""
공통 REST API(FastAPI). PC 웹 클라이언트와 데스크톱 앱이 쓴다.
요청 본문(발화)은 로그로 남기지 않는다.
"""
from __future__ import annotations

import json
import secrets
import logging
import mimetypes
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from cheongeum.core.choices import CHOICE_KEYS
from cheongeum.core.region import CTPV
from cheongeum.core.turn import LANGS
from cheongeum.orchestrator import SessionOrchestrator
from cheongeum.core.voice_profile import VOICE_PROFILE, speech_pace
from cheongeum.safety import detect_sensitive, redact_text
from cheongeum.server.key_check import check_openai_key
from cheongeum.server.live_audio import LiveAudio, TranscriptTooLong, turn_transcript
from cheongeum.server.voice_edge import VoiceEdge
from cheongeum.server.recovery import RequestConflict, Sessions
from cheongeum.server.request_policy import AUDIO_LIMIT, JSON_LIMIT, TURN_TEXT_LIMIT, bounded_body, request_refusal
from cheongeum.server.runtime import AgentRuntime
from cheongeum.personal.store import MOBILE
from cheongeum.server.settings import SettingsInput
from cheongeum.server.workflows import Workflows, register_workflows
from cheongeum.understanding.rules import is_progress_question, is_stop_utterance
from cheongeum.voice import VoiceNotSupportedError, VoiceProviderError

log = logging.getLogger("cheongeum.server")

# 윈도 레지스트리가 .js를 text/plain으로 알려 주면 모듈 스크립트가 막히므로 직접 정한다.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")

MAX_SESSIONS = 3


def _err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": code, "message": message}, status_code=status)


def _input_action(session: SessionOrchestrator, supplied: str | None) -> str:
    if supplied is not None:
        return supplied
    # Older clients may omit a browser approval ID. A vault confirmation must
    # have been presented on this input's client before they started replying.
    shown = session.dialogue.confirmation or {}
    return "" if shown.get("kind") in ("vault-save", "vault-clear") else shown.get("actionId", "")


async def _json_body(request: Request) -> dict | None:
    raw = await bounded_body(request, JSON_LIMIT)
    if raw is None:
        return None
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return body if isinstance(body, dict) else None


def create_app(runtime: AgentRuntime, voice: Any = None, lifespan: Any = None, *, port: int | None = None,
               workflow_dsn: str = "") -> tuple[FastAPI, Sessions]:
    """→ (app, sessions). 종료 시 close_all(sessions)를 부른다."""
    audio_services = voice if voice is not None else runtime
    app = FastAPI(title="청음 API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    sessions = Sessions()
    live_audio = LiveAudio()
    app.state.sessions = sessions
    app.state.runtime = runtime
    workflows = app.state.workflows = Workflows(runtime, workflow_dsn)

    @app.middleware("http")
    async def local_requests(request: Request, call_next):
        path = request.scope["path"]
        if path.startswith("/api/"):
            denied = request_refusal(request, port)
            if denied:
                status, code = denied
                log.info("[server] request refused %s", code)
                return _err(status, code, "로컬 API 요청 형식을 확인해 주세요.")
            if request.method in ("POST", "DELETE") and (
                request.method == "DELETE" or "content-type" not in request.headers
                or path.endswith(("/cancel", "/detach", "/resume"))
            ):
                if await bounded_body(request, 0) is None:
                    log.info("[server] request refused UNEXPECTED_BODY")
                    return _err(415, "UNEXPECTED_BODY", "이 요청은 본문을 받지 않습니다.")
        response = await call_next(request)
        if path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def voice_error(e: Exception) -> JSONResponse:
        if isinstance(e, TranscriptTooLong):
            return _err(422, "TRANSCRIPT_TOO_LONG", "말씀이 길어서 실행하지 않았어요. 요청을 나눠서 말씀해 주세요.")
        if isinstance(e, RequestConflict):
            return _err(409, "REQUEST_CONFLICT", "이 녹음은 끝났거나 작업이 바뀌었어요. 다시 말씀해 주세요.")
        if isinstance(e, VoiceNotSupportedError):
            return _err(501, "NOT_SUPPORTED", str(e))
        if isinstance(e, VoiceProviderError):
            if e.status in (401, 403):
                return _err(502, "VOICE_KEY", "음성 API 인증에 실패했어요. 이용 설정에서 키와 사용 권한을 확인해 주세요.")
            if e.status == 429:
                quota = e.provider_code == "insufficient_quota"
                response = _err(429, "VOICE_QUOTA" if quota else "VOICE_LIMIT", "음성 API 사용 한도에 도달했어요. API 잔액이나 요청 한도를 확인해 주세요.")
                if e.retry_after:
                    response.headers["Retry-After"] = e.retry_after
                return response
            if e.status == 404:
                return _err(502, "VOICE_MODEL", "설정한 음성 모델을 이용할 수 없어요. API 키의 모델 권한을 확인해 주세요.")
        log.error("[server] voice error %s", type(e).__name__)
        return _err(502, "VOICE_PROVIDER", "음성 서비스 호출에 실패했습니다. 잠시 후 다시 시도하거나 텍스트로 입력하세요.")

    async def transcribe(request: Request, language: str = "ko", audio: bytes | None = None, *, sid: str = "") -> str:
        stt = audio_services.stt
        if not stt.supported:
            raise VoiceNotSupportedError("음성 입력을 사용하려면 이용 설정에서 OpenAI API 키를 등록해 주세요.")
        content_type = request.headers["content-type"]
        if content_type.split(";")[0].strip() == "application/json" and sid:
            if audio is None:
                audio = await bounded_body(request, JSON_LIMIT)
            try:
                receipt = json.loads(audio or b"{}")
            except (ValueError, UnicodeError):
                raise RequestConflict from None
            if not isinstance(receipt, dict) or set(receipt) != {"receipt"} or not sessions.get(sid):
                raise RequestConflict
            return live_audio.take(receipt["receipt"], sid, sessions.ledgers[sid], sessions.get(sid).generation)
        if audio is None:
            audio = await bounded_body(request, AUDIO_LIMIT)
        if audio is None or len(audio) < 200:
            return ""
        return (await stt.transcribe(audio, language=language, mime_type=content_type))["text"]

    def not_found() -> JSONResponse:
        return _err(404, "SESSION_NOT_FOUND", "세션이 없습니다. 새 세션을 시작하세요.")

    def access(sid: str, request: Request, *, recovery_control: bool = False):
        return access_writer(sid, request.headers.get("x-cheongeum-writer") or "", recovery_control=recovery_control)

    def access_writer(sid: str, writer: str, *, recovery_control: bool = False):
        session = sessions.get(sid)
        if not session:
            return not_found()
        lease = sessions.leases.get(sid)
        if lease:
            if not lease.writer or not writer.isascii() or not secrets.compare_digest(lease.writer, writer):
                return _err(409, "SESSION_WRITER_REQUIRED", "이 탭에서 작업을 제어할 수 없어요.")
            if lease.waiting and not recovery_control:
                return _err(409, "RECOVERY_CONFIRMATION_REQUIRED", "이전 작업을 이어 할지 먼저 선택해 주세요.")
            sessions.keep_alive(sid, lease)
        elif sid in sessions.ephemeral:
            sessions.keep_ephemeral(sid)
        return session

    live_audio.register(app, audio_services, sessions, access_writer, voice_error, port)
    register_workflows(app, workflows, access, _json_body)
    VoiceEdge().register(app, audio_services, sessions, access_writer, voice_error, port)

    async def once(sid: str, request: Request, payload: bytes, work):
        ledger = sessions.ledgers[sid]
        session = sessions.get(sid)
        generation = session.generation

        async def run():
            if sessions.ledgers.get(sid) is not ledger or session.generation != generation:
                raise RequestConflict
            return await work()

        try:
            return await ledger.once(request.headers.get("x-cheongeum-request"), payload, run)
        except RequestConflict:
            return _err(409, "REQUEST_CONFLICT", "이 요청은 이미 만료됐거나 내용이 바뀌었어요.")

    @app.exception_handler(Exception)
    async def on_error(_request: Request, exc: Exception) -> JSONResponse:
        # 오류 메시지에 사용자 입력이 섞일 수 있어 이름만 기록한다.
        log.error("[server] error %s", type(exc).__name__)
        return _err(500, "INTERNAL", "서버 오류가 발생했습니다. 모의 사이트와 브라우저가 실행 중인지 확인하세요.")

    @app.get("/api/health")
    async def health() -> dict:
        roles = runtime.llm_roles()
        stt, tts = audio_services.stt, audio_services.tts
        return {
            "ok": True,
            "llmProvider": runtime.intent_provider.name,
            "llmRoles": roles,
            "welfareData": runtime.welfare_provider.mode,
            "datasets": [asdict(status) for status in runtime.open_data.statuses],
            "stt": {"provider": stt.name, "supported": stt.supported, "localLanguages": [],
                    "liveModel": getattr(getattr(stt, "live", None), "model", None)},
            "tts": {"provider": tts.name, "supported": tts.supported},
            "voiceEdge": getattr(stt, "edge_model", None),
            "mockOnly": not runtime.config.readOnlyWeb and not runtime.config.extraAllowedOrigins,
            "submissionScope": "practice-only",
            "practiceMode": runtime.config.practiceMode,
            "voiceSpeed": getattr(tts, "speed", None) or (runtime.settings.preferences.speed if runtime.settings else runtime.config.voice.ttsSpeed),
            "setupRequired": bool(runtime.settings and not runtime.settings.completed),
            "firstRun": runtime.settings.first_run if runtime.settings else "done",
            "settingsAvailable": runtime.settings is not None,
            "workspaceAvailable": workflows.personal,
            "recoveryAvailable": getattr(getattr(runtime, "config", None), "pilotProfile", None) == "personal",
        }

    @app.get("/api/settings")
    async def get_settings() -> Any:
        store = runtime.settings
        if store is None:
            return _err(404, "NO_SETTINGS", "이 실행 환경에는 이용 설정이 없습니다.")
        return {**store.preferences.model_dump(), "sharedDevice": runtime.config.pilotProfile == "shared", "hasKey": audio_services.stt.supported,
                "loadError": store.load_error, "regions": list(dict.fromkeys(CTPV.values())),
                "browserFallback": bool(getattr(runtime, "browser_fallback", False))}

    @app.post("/api/personal/guardian")
    async def save_guardian(request: Request) -> Any:
        """첫 실행 설정(도와주는 분): 보호자 연락처. 개인 PC에서만 봉인한 금고에 둔다. 값은 응답에 담지 않는다."""
        store = runtime.personal_store() if hasattr(runtime, "personal_store") else None
        if store is None:
            return _err(409, "NOT_PERSONAL", "개인 PC로 설정했을 때만 보호자 연락처를 저장할 수 있어요.")
        body = await _json_body(request) or {}
        name, phone = body.get("name"), body.get("phone")
        name = name.strip() if isinstance(name, str) else ""
        phone = "".join(ch for ch in phone if ch.isdigit()) if isinstance(phone, str) else ""
        if not (0 < len(name) <= 20) or not MOBILE.fullmatch(phone):
            return _err(400, "INVALID_GUARDIAN", "보호자 이름과 휴대전화 번호를 확인해 주세요.")
        store.set_guardian({"name": name, "phone": phone})
        return {"saved": True}

    @app.post("/api/settings/check-key")
    async def check_key(request: Request) -> Any:
        """첫 실행 설정: 입력한 키로 한 번 불러 본다. 결과만 돌려주고 키는 어디에도 남기지 않는다."""
        body = await _json_body(request)
        try:
            key = SettingsInput.model_validate({"apiKey": (body or {}).get("apiKey")}).apiKey.get_secret_value()
        except ValidationError:
            key = ""
        if not key:
            return _err(400, "INVALID_SETTINGS", "API 키를 확인해 주세요.")
        return {"result": await check_openai_key(key, runtime.config.voice.baseUrl)}

    @app.post("/api/settings")
    async def save_settings(request: Request) -> Any:
        store = runtime.settings
        if store is None:
            return _err(404, "NO_SETTINGS", "이 실행 환경에는 이용 설정이 없습니다.")
        try:
            values = SettingsInput.model_validate(await _json_body(request))
        except ValidationError:
            return _err(400, "INVALID_SETTINGS", "API 키, 언어, 시·도와 속도를 확인해 주세요.")
        # 키는 꼭 있어야 한다(주인 결정 2026-11-19). 저장된 키나 환경 설정의 키가 없으면 저장하지 않는다.
        if not values.apiKey.get_secret_value() and not audio_services.stt.supported:
            return _err(400, "KEY_REQUIRED", "OpenAI API 키를 입력해 주세요.")
        old = store.preferences
        if runtime.config.pilotProfile == "shared":
            values = values.model_copy(update={"deviceUse": "shared", "rememberService": False})
        try:
            store.save(values)
        except Exception:
            return _err(503, "SETTINGS_STORAGE", "이 PC에 설정을 저장할 수 없어요. 계정의 자격 증명 저장소와 폴더 권한을 확인해 주세요.")
        runtime.refresh_services()
        await workflows.reconfigure()
        for session in sessions.values():
            workflows.bind(session)
            session.stage_settings(runtime.session_models(), language=values.language if values.language != old.language else None,
                                   region=values.region if values.region != old.region else None)
        return {"saved": True}

    @app.post("/api/session")
    async def create_session(request: Request) -> Any:
        if getattr(runtime, "settings", None) and not runtime.settings.completed:
            return _err(409, "SETUP_REQUIRED", "먼저 청음 이용 설정을 저장해 주세요.")
        body = await _json_body(request)
        if body is None or any(key not in ("recovery", "attached") or not isinstance(value, bool) for key, value in body.items()):
            return _err(400, "BAD_REQUEST", "세션 설정을 확인해 주세요.")
        enable = body.get("recovery", False)
        if enable and getattr(runtime.config, "pilotProfile", None) != "personal":
            return _err(403, "RECOVERY_UNAVAILABLE", "확인된 개인 프로필에서만 작업 복구를 켤 수 있어요.")
        async with sessions.creating:
            if len(sessions) >= MAX_SESSIONS:
                return _err(409, "SESSION_LIMIT", "열린 세션이 세 개예요. 사용 중인 탭에서 먼저 이용을 종료해 주세요.")
            s = await runtime.create_session()
            workflows.bind(s)
            sessions.add(s)
            lease = sessions.enable(s.id) if enable else None
            if body.get("attached") and lease is None:
                sessions.keep_ephemeral(s.id)
        return {
            "sessionId": s.id,
            "state": s.state,
            "llmProvider": runtime.intent_provider.name,
            "mockOnly": not runtime.config.readOnlyWeb and not runtime.config.extraAllowedOrigins,
            "submissionScope": "practice-only",
            "consentRequired": s.consent_status != "granted",
            "firstStartupGuide": runtime.settings.claim_startup_guide()
            if getattr(runtime, "settings", None) and s.consent_status == "pending" else None,
            "speechPrefs": s.snapshot().get("speechPrefs"),
            "lang": s.lang,
            **(lease.credentials() if lease else {}),
        }

    @app.post("/api/session/recover")
    async def recover(request: Request) -> Any:
        body = await _json_body(request)
        token = (body or {}).get("token")
        attempt = (body or {}).get("attempt")
        if (not isinstance(token, str) or len(token) != 43 or not token.isascii()
                or not isinstance(attempt, str) or len(attempt) != 36 or not attempt.isascii()):
            return _err(400, "BAD_REQUEST", "복구 정보를 확인해 주세요.")
        try:
            recovered = sessions.recover(token, attempt)
        except RequestConflict:
            return _err(409, "SESSION_WRITER_ACTIVE", "이전 연결에서 작업을 제어하고 있어요.")
        if not recovered:
            return not_found()
        sid, lease = recovered
        return {"sessionId": sid, "checkpoint": lease.checkpoint, **lease.credentials()}

    @app.post("/api/session/{sid}/resume")
    async def resume(sid: str, request: Request) -> Any:
        s = access(sid, request, recovery_control=True)
        if isinstance(s, Response):
            return s
        lease = sessions.leases.get(sid)
        if not lease:
            return _err(409, "RECOVERY_NOT_WAITING", "연결할 작업이 없어요.")
        writer = lease.writer

        async def continue_session():
            if not lease.waiting:
                return _err(409, "RECOVERY_NOT_WAITING", "연결할 작업이 없어요.")
            result = await s.resume_for_recovery(lease.checkpoint or {})
            if sessions.leases.get(sid) is not lease or lease.writer != writer:
                return _err(409, "SESSION_WRITER_REQUIRED", "이 탭에서 작업을 제어할 수 없어요.")
            if result.get("interrupted"):
                sessions.remove(sid)
                await s.close()
                return _err(410, "BROWSER_INTERRUPTED", "이전 브라우저가 닫혔어요. 새 작업을 시작해 주세요.")
            lease.waiting = False
            lease.checkpoint = None
            lease.previous = None
            return result

        return await once(sid, request, b"resume", continue_session)

    @app.get("/api/session/{sid}/heartbeat")
    async def heartbeat(sid: str, request: Request) -> Any:
        s = access(sid, request, recovery_control=True)
        return s if isinstance(s, Response) else {"ok": True}

    @app.post("/api/session/{sid}/detach")
    async def detach(sid: str, request: Request) -> Any:
        s = access(sid, request, recovery_control=True)
        if isinstance(s, Response):
            return s
        sessions.detach(sid)
        return {"ok": True}


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
            or not (1 <= len(text.strip()) <= TURN_TEXT_LIMIT)
            or platform != "pc"
        ):
            return _err(400, "BAD_REQUEST", "sessionId와 text(1~500자)가 필요합니다.")
        s = access(sid, request)
        if isinstance(s, Response):
            return s
        approval_id = (body or {}).get("actionId")
        if approval_id is not None and not isinstance(approval_id, str):
            return _err(400, "BAD_REQUEST", "actionId는 문자열이어야 합니다.")
        if is_stop_utterance(redact_text(text)):
            return await s.handle_turn(text.strip())
        payload = json.dumps(["turn", text.strip(), approval_id]).encode()
        presented = _input_action(s, approval_id)
        return await once(sid, request, payload, lambda: s.handle_turn(text.strip(), approval_id=presented))

    @app.get("/api/session/{sid}/state")
    async def state(sid: str, request: Request) -> Any:
        s = access(sid, request)
        return s if isinstance(s, Response) else s.snapshot()

    @app.post("/api/session/{sid}/wake")
    async def wake(sid: str, request: Request) -> Any:
        body = await _json_body(request)
        generation = (body or {}).get("stopGeneration")
        if type(generation) is not int or generation < 0:
            return _err(400, "BAD_REQUEST", "멈춤 요청 번호를 확인해 주세요.")
        s = access(sid, request)
        if isinstance(s, Response):
            return s
        # A cached success for an earlier Stop no longer applies after another Stop.
        if generation != s.generation:
            return _err(409, "STALE_STOP", "다시 멈췄어요. 시작하려면 다시 눌러 주세요.")
        result = await once(sid, request, f"wake:{generation}".encode(), lambda: s.wake(generation))
        if isinstance(result, Response):
            return result
        if result is None or generation != s.generation:
            return _err(409, "STALE_STOP", "다시 멈췄어요. 시작하려면 다시 눌러 주세요.")
        return {"state": s.state}

    @app.post("/api/session/{sid}/confirm")
    async def confirm(sid: str, request: Request) -> Any:
        body = await _json_body(request)
        if not body or not isinstance(body.get("approve"), bool):
            return _err(400, "BAD_REQUEST", "approve(boolean)가 필요합니다.")
        s = access(sid, request)
        if isinstance(s, Response):
            return s
        action_id = body.get("actionId", "")
        if not isinstance(action_id, str):
            return _err(400, "BAD_REQUEST", "actionId는 문자열이어야 합니다.")
        payload = json.dumps(["confirm", body["approve"], action_id]).encode()
        return await once(sid, request, payload, lambda: s.confirm(body["approve"], action_id))

    @app.post("/api/session/{sid}/choice")
    async def choice(sid: str, request: Request) -> Any:
        """제안한 선택지 고르기(아바타·대화 창 버튼). 그 응답·인계·화면이 그대로일 때만 실행하고, 아니면 409 CHOICE_EXPIRED."""
        body = await _json_body(request) or {}
        turn_id, key, handoff_id = body.get("turnId"), body.get("key"), body.get("handoffId")
        if not isinstance(turn_id, str) or not turn_id or key not in CHOICE_KEYS or (handoff_id is not None and not isinstance(handoff_id, str)):
            return _err(400, "BAD_REQUEST", "turnId와 key가 필요합니다.")
        s = access(sid, request)
        if isinstance(s, Response):
            return s

        async def run():
            result = await s.choose(turn_id, key, handoff_id)
            return result if result is not None else _err(409, "CHOICE_EXPIRED", "선택지가 바뀌었어요. 지금 안내를 다시 확인해 주세요.")

        return await once(sid, request, json.dumps(["choice", turn_id, key, handoff_id]).encode(), run)

    @app.post("/api/session/{sid}/consent")
    async def consent(sid: str, request: Request) -> Any:
        """시작 동의(화면 읽기·브라우저 조작·음성 외부 전송). 동의 전에는 받아쓰기도 하지 않는다."""
        body = await _json_body(request)
        if not body or not isinstance(body.get("granted"), bool):
            return _err(400, "BAD_REQUEST", "granted(boolean)가 필요합니다.")
        s = access(sid, request)
        if isinstance(s, Response):
            return s
        return await s.consent_to(body["granted"])

    @app.get("/api/session/{sid}/reminders")
    async def reminders(sid: str, request: Request) -> Any:
        """신청 기록 중 기한이 가까운 것(데스크톱 앱이 주기적으로 물어 소리로 알린다)"""
        s = access(sid, request)
        if isinstance(s, Response):
            return s
        return {"text": s.reminders() if s.consent_status == "granted" else None}

    @app.get("/api/session/{sid}/progress")
    async def progress(sid: str, request: Request) -> Any:
        """
        목표 수행 진행 상황. 화면은 일하는 동안 몇 초마다 물어 새 단계(seq가 커짐)를 소리로 알린다.
        latest는 코드가 행동·대상 이름·사이트로 만든 문장뿐이다(화면 글·모델 글 아님). spoken = 묻지 않아도 알릴지.
        """
        s = access(sid, request)
        return s if isinstance(s, Response) else s.progress.snapshot()

    @app.post("/api/session/{sid}/language")
    async def language(sid: str, request: Request) -> Any:
        """대화 언어 바꾸기(ko/en/zh/ja). 음성 "영어로 말해줘"와 같은 경로."""
        body = await _json_body(request)
        lang = (body or {}).get("lang")
        if lang not in LANGS:
            return _err(400, "BAD_REQUEST", "lang은 ko, en, zh, ja 중 하나입니다.")
        s = access(sid, request)
        if isinstance(s, Response):
            return s
        return await s.set_language(lang)

    @app.post("/api/session/{sid}/cancel")
    async def cancel(sid: str, request: Request) -> Any:
        s = access(sid, request, recovery_control=True)
        if isinstance(s, Response):
            return s
        result = s.cancel()
        lease = sessions.leases.get(sid)
        if lease and lease.waiting:
            lease.checkpoint = s.detach_for_recovery()
            result["stopGeneration"] = s.generation
        return result

    @app.delete("/api/session/{sid}")
    async def delete(sid: str, request: Request) -> Any:
        s = access(sid, request, recovery_control=True)
        if isinstance(s, Response):
            return s
        sessions.remove(sid)
        await s.close()
        return {"ok": True}

    @app.post("/api/audio/turn")
    async def audio_turn(request: Request, sessionId: str = "") -> Any:  # noqa: N803 — 원본 API의 쿼리 이름
        """
        음성 한 턴: 받아쓰기 → 곧바로 세션 턴 처리. 받아쓴 원문은 클라이언트로 돌려주지 않는다
        (응답의 userUtterance는 비식별화된 문장). 비밀번호 등을 말해도 화면·로그에 남지 않게 하기 위함.
        """
        s = access(sessionId, request)
        if isinstance(s, Response):
            return s
        # 동의 전에는 음성을 외부 받아쓰기 서비스로 보내지 않는다.
        if s.consent_status != "granted":
            return _err(403, "CONSENT_REQUIRED", "먼저 시작 안내에 동의해 주세요.")
        supplied = request.headers.get("x-cheongeum-action")
        approval_id = _input_action(s, supplied)
        limit = JSON_LIMIT if request.headers["content-type"].split(";")[0].strip() == "application/json" else AUDIO_LIMIT
        audio = await bounded_body(request, limit)
        if audio is None:
            return _err(413, "BODY_TOO_LARGE", "녹음 길이를 줄여 주세요.")
        current = access(sessionId, request)
        if isinstance(current, Response):
            return current
        ledger = sessions.ledgers[sessionId]
        generation = s.generation

        async def run_audio():
            try:
                text = turn_transcript(await transcribe(request, s.lang, audio, sid=sessionId))
            except Exception as e:  # noqa: BLE001
                return voice_error(e)
            if sessions.ledgers.get(sessionId) is not ledger:
                return _err(409, "SESSION_WRITER_REQUIRED", "이 탭에서 작업을 제어할 수 없어요.")
            if not text:
                return _err(422, "EMPTY_TRANSCRIPT", s.missed_speech_hint())
            if generation != s.generation and not is_stop_utterance(redact_text(text)):
                return _err(409, "REQUEST_CONFLICT", "멈춤 전에 시작한 음성 요청을 취소했어요.")
            return await s.handle_turn(text, approval_id=approval_id, from_voice=True)

        payload = json.dumps(["audio", request.headers["content-type"], supplied]).encode() + b"\0" + audio
        return await once(sessionId, request, payload, run_audio)

    @app.post("/api/audio/stop")
    async def audio_stop(request: Request, sessionId: str = "") -> Any:  # noqa: N803
        """
        일하는 동안 들은 말: 멈춤 말과 진행 상황 물음('지금 어디까지 했어?')만 받는다. 둘 다 턴 대기열을 거치지 않는다.
        그 밖의 말은 받아쓴 뒤 버린다. 기록에도 남기지 않는다.
        """
        s = access(sessionId, request)
        if isinstance(s, Response):
            return s
        ledger = sessions.ledgers[sessionId]
        if s.consent_status != "granted":
            return _err(403, "CONSENT_REQUIRED", "먼저 시작 안내에 동의해 주세요.")
        try:
            text = await transcribe(request, s.lang, sid=sessionId)
        except Exception as e:  # noqa: BLE001
            return voice_error(e)
        if sessions.ledgers.get(sessionId) is not ledger:
            return _err(409, "SESSION_WRITER_REQUIRED", "이 탭에서 작업을 제어할 수 없어요.")
        said = redact_text(text) if text else ""
        if is_stop_utterance(said):
            return {"stopped": True, "result": await s.handle_turn(turn_transcript(text))}
        if is_progress_question(said):
            return {"stopped": False, "result": await s.handle_turn(said.strip())}
        return {"stopped": False}

    @app.post("/api/audio/transcribe")
    @app.post("/api/audio/recording")
    async def recording_transcript(request: Request, sessionId: str = "") -> Any:  # noqa: N803
        session = access(sessionId, request)
        if isinstance(session, Response):
            return session
        if session.consent_status != "granted" or session.state in ("AUTH_HANDOFF", "STOPPED"):
            return _err(403, "CONSENT_REQUIRED", "녹음 파일을 보내려면 대화를 시작하고 동의해 주세요.")
        ledger, generation = sessions.ledgers[sessionId], session.generation

        def current():
            return (sessions.ledgers.get(sessionId) is ledger and session.generation == generation
                    and session.consent_status == "granted" and session.state not in ("AUTH_HANDOFF", "STOPPED"))

        audio = await bounded_body(request, AUDIO_LIMIT)
        if audio is None:
            return _err(413, "BODY_TOO_LARGE", "10 MiB 이하인 녹음 파일을 선택해 주세요.")
        if not current():
            return _err(409, "REQUEST_CONFLICT", "녹음 요청이 취소되었습니다.")
        try:
            text = await transcribe(request, session.lang, audio)
        except Exception as exc:
            return voice_error(exc)
        if not current():
            return _err(409, "REQUEST_CONFLICT", "녹음 요청이 취소되었습니다.")
        if not text:
            return _err(422, "EMPTY_TRANSCRIPT", session.missed_speech_hint())
        return {"text": redact_text(text), "secretDetected": detect_sensitive(text).hasSecretValue,
                "provider": audio_services.stt.name}

    @app.post("/api/audio/speak")
    async def audio_speak(request: Request) -> Any:
        body = await _json_body(request)
        text = (body or {}).get("text")
        lang = (body or {}).get("lang")
        if not isinstance(text, str) or not (1 <= len(text.strip()) <= 1000) or (lang is not None and lang not in LANGS):
            return _err(400, "BAD_REQUEST", "text(1~1000자)가 필요합니다.")
        try:
            speed = body.get("absoluteSpeed")
            pace = (speed / (getattr(audio_services.tts, "speed", None) or VOICE_PROFILE.speed)
                    if type(speed) in (int, float) and 0.5 <= speed <= 2 else speech_pace(body.get("rate")))
            out = await audio_services.tts.synthesize(text.strip(), language=lang or "ko", pace=pace)
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
# 아바타 창: 3D 모델(glb) 안의 그림을 blob 주소로 풀어 읽으므로 그 문서에만 blob:을 더 허용한다.
AVATAR_CSP = CSP.replace("img-src 'self' data:", "img-src 'self' data: blob:").replace("connect-src 'self'", "connect-src 'self' blob:")


def mount_web_ui(app: FastAPI, csp: bool = False) -> FastAPI:
    """웹 UI(빌드 없는 정적 파일)를 같은 포트로 서빙한다. 모든 /api 경로를 등록한 뒤에 부른다."""
    if csp:

        @app.middleware("http")
        async def _csp(request: Request, call_next):
            # 앱 화면은 자기 출처만 쓴다(외부 스크립트 차단). 음성 재생은 blob/data URL을 쓸 수 있다.
            response = await call_next(request)
            response.headers["Content-Security-Policy"] = AVATAR_CSP if request.url.path.startswith("/avatar/") else CSP
            return response

    @app.get("/voice-profile.json", include_in_schema=False)
    async def voice_profile():
        return VOICE_PROFILE.model_dump()

    # 개발 체크아웃과 설치한 wheel 모두 같은 공개 안내 녹음을 제공한다.
    setup_audio = Path(__file__).resolve().parents[3] / "web" / "public" / "setup-audio"
    app.mount("/setup-audio", StaticFiles(directory=setup_audio if setup_audio.is_dir() else WEB_DIR / "setup-audio"), name="setup-audio")
    app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
    return app


async def close_all(sessions: Sessions) -> None:
    for s in sessions.values():
        try:
            await s.close()
        except Exception:  # noqa: BLE001
            pass
    sessions.clear()
