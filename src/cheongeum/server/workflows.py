"""Consented, personal-device features that outlive the foreground conversation."""
from __future__ import annotations

import asyncio
import logging
import re
from contextlib import suppress
from uuid import UUID
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from cheongeum.safety import REDACTED, detect_sensitive
from cheongeum.safety.privacy import redact_picture_text
from cheongeum.server.workflow_store import LEASE_SECONDS, WorkflowStore, installation_owner

log = logging.getLogger("cheongeum.workflows")


def safe_input(value, maximum):
    if not isinstance(value, str):
        return None
    value = value.strip()
    if (not 1 <= len(value) <= maximum or REDACTED in value or detect_sensitive(value).hasSecretValue
            or re.search(r"\bsk-[a-zA-Z0-9_-]{12,}|https?://[^\s/]+@|https?://[^\s]+\?", value, re.I)
            or redact_picture_text(value) != value):
        return None
    return value


def public_result(state, result):
    sources = []
    for item in result.get("sources", [])[:8]:
        url = item.get("url", "")
        try:
            parts = urlsplit(url)
            if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
                continue
        except ValueError:
            continue
        # Keep checked public reference URLs only. No browser state, screenshots, or raw turn records.
        sources.append({"title": redact_picture_text(item.get("title") or parts.hostname)[:180], "url": url[:2048]})
    text = redact_picture_text(result.get("text") or "")[:2400]
    if state in ("completed", "partial") and (not sources or not text):
        return "incomplete", None
    if state not in ("completed", "partial", "needs_input"):
        return "incomplete", None
    return state, {"text": text, "sources": sources}


class Workflows:
    def __init__(self, runtime, dsn=""):
        self.runtime, self.dsn = runtime, dsn
        self._store = None
        self._opening = asyncio.Lock()
        self._wake = asyncio.Event()
        self._worker = None
        self._active = None
        self._job_id = None

    @property
    def personal(self):
        settings = getattr(self.runtime, "settings", None)
        return bool(settings and settings.completed and settings.preferences.deviceUse == "personal"
                    and self.runtime.config.pilotProfile != "shared")

    async def store(self):
        async with self._opening:
            if self._store is None:
                directory = self.runtime.settings.path.parent
                def open_store():
                    return WorkflowStore(directory / "workflows.sqlite3", installation_owner(directory), self.dsn)
                self._store = await asyncio.to_thread(open_store)
            return self._store

    async def reconfigure(self):
        if self.personal:
            if self._worker is None or self._worker.done():
                self._worker = asyncio.create_task(self._loop(), name="cheongeum-public-research")
            self._wake.set()
        else:
            await self.close()

    async def close(self):
        if self._worker:
            self._worker.cancel()
            with suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None

    async def _research(self, job):
        session = await self.runtime.create_session(background=True)
        try:
            state, result = await session.research_public(job["prompt"], job["language"])
            return public_result(state, result)
        finally:
            session.cancel()
            await session.close()

    async def _loop(self):
        while self.personal:
            self._wake.clear()
            try:
                store = await self.store()
                job = await asyncio.to_thread(store.claim)
                if job:
                    await self._run(store, job)
                    continue
            except Exception as exc:
                log.warning("Research worker unavailable (%s)", type(exc).__name__)
            with suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), 8)

    async def _run(self, store, job):
        self._job_id = job["id"]
        self._active = asyncio.create_task(self._research(job))
        try:
            async with asyncio.timeout(LEASE_SECONDS - 15):
                while not self._active.done():
                    await asyncio.wait((self._active,), timeout=3)
                    if not self._active.done() and not await asyncio.to_thread(store.owns_claim, job):
                        self._active.cancel()
                state, result = await self._active
        except asyncio.CancelledError:
            # Shutdown releases the claim. An explicit cancellation has already revoked its lease in SQL.
            if asyncio.current_task().cancelling():
                await asyncio.to_thread(store.retry, job, shutdown=True)
                raise
            return
        except Exception as exc:
            log.warning("Research lookup failed (%s)", type(exc).__name__)
            await asyncio.to_thread(store.retry, job)
            return
        finally:
            if not self._active.done():
                self._active.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await self._active
            self._job_id, self._active = None, None
        await asyncio.to_thread(store.finish, job, state, result)

    async def cancel(self, store, job_id):
        changed = await asyncio.to_thread(store.cancel, job_id)
        if changed and self._job_id == job_id and self._active:
            self._active.cancel()
        return changed

    async def embedded(self, text):
        provider = getattr(self.runtime, "embedding", None)
        if provider:
            try:
                vector = await asyncio.wait_for(provider.embed(text), 4)
                return vector, provider.model
            except Exception:
                pass
        return None, None

    async def enqueue(self, session, request_id, query, current=lambda: True):
        if not self.personal or session.consent_status != "granted" or not safe_input(query, 600):
            raise ValueError("input")
        screen = getattr(self.runtime, "moderation", None)
        if screen:
            try:
                flagged = await asyncio.wait_for(screen.screen(query), 4)
            except Exception:
                flagged = None
            if flagged:
                raise ValueError("input")
        store = await self.store()
        if not self.personal or session.consent_status != "granted" or not current():
            raise ValueError("input")
        job_id = await asyncio.to_thread(store.enqueue, request_id, query, session.lang)
        await self.reconfigure()
        return job_id

    async def recall(self, session, query):
        if not self.personal or session.consent_status != "granted" or not safe_input(query, 600):
            return []
        try:
            store = await self.store()
            if not await asyncio.to_thread(store.has_notes):
                return []
            vector, model = await self.embedded(query)
            if not self.personal or session.consent_status != "granted":
                return []
            matches = await asyncio.to_thread(store.search, query, vector, model)
            return matches if self.personal and session.consent_status == "granted" else []
        except Exception:
            # Unavailable optional memory must not prevent a foreground public-service lookup.
            return []

    def bind(self, session):
        if getattr(session, "deps", None) is not None:
            async def recall(query):
                return [n["body"] for n in await self.recall(session, query)]
            session.deps.recall_notes = recall
            async def delegate(request_id, query):
                try:
                    current_generation = session.generation
                    return bool(await self.enqueue(session, request_id, query, lambda: session.generation == current_generation))
                except Exception:
                    return False
            session.deps.delegate_research = delegate if self.personal else None


def register_workflows(app, service, access, body):
    base = "/api/session/{sid}/workspace"

    def reject(code, status=400):
        return JSONResponse({"error": code}, status_code=status)

    def authorize(sid, request):
        session = access(sid, request)
        if isinstance(session, Response):
            return session
        if not service.personal or session.consent_status != "granted":
            return reject("WORKSPACE_PERSONAL_REQUIRED", 403)
        return session

    @app.get(base)
    async def workspace(sid: str, request: Request):
        session = authorize(sid, request)
        if isinstance(session, Response):
            return session
        store = await service.store()
        jobs, notes = await asyncio.gather(asyncio.to_thread(store.jobs), asyncio.to_thread(store.notes))
        return {"jobs": jobs, "notes": notes}

    @app.post(base + "/research")
    async def research(sid: str, request: Request):
        session = authorize(sid, request)
        if isinstance(session, Response):
            return session
        payload = await body(request) or {}
        query = safe_input(payload.get("text"), 600)
        if not query or payload.get("consent") is not True:
            return reject("PUBLIC_TEXT_REQUIRED")
        try:
            request_id = str(UUID(str(payload.get("requestId"))))
        except ValueError:
            return reject("REQUEST_ID_REQUIRED")
        try:
            job_id = await service.enqueue(session, request_id, query, lambda: authorize(sid, request) is session)
        except ValueError as exc:
            if str(exc) == "input":
                return reject("PUBLIC_TEXT_REQUIRED")
            return reject("WORKSPACE_LIMIT" if str(exc) == "limit" else "REQUEST_CONFLICT", 409)
        return {"id": job_id}

    @app.delete(base + "/research/{job_id}/claim")
    async def cancel(sid: str, job_id: str, request: Request):
        session = authorize(sid, request)
        if isinstance(session, Response):
            return session
        return {"cancelled": await service.cancel(await service.store(), job_id)}

    @app.delete(base + "/research/{job_id}")
    async def delete_job(sid: str, job_id: str, request: Request):
        session = authorize(sid, request)
        if isinstance(session, Response):
            return session
        store = await service.store()
        return {"deleted": await asyncio.to_thread(store.delete_job, job_id)}

    @app.post(base + "/notes")
    async def save_note(sid: str, request: Request):
        session = authorize(sid, request)
        if isinstance(session, Response):
            return session
        payload = await body(request) or {}
        text = safe_input(payload.get("text"), 300)
        if not text or payload.get("consent") is not True:
            return reject("PUBLIC_TEXT_REQUIRED")
        vector, model = await service.embedded(text)
        if isinstance(check := authorize(sid, request), Response):
            return check
        store = await service.store()
        try:
            note_id = await asyncio.to_thread(store.note, text, vector, model)
        except ValueError:
            return reject("WORKSPACE_LIMIT", 409)
        return {"id": note_id}

    @app.post(base + "/notes/search")
    async def search(sid: str, request: Request):
        session = authorize(sid, request)
        if isinstance(session, Response):
            return session
        query = safe_input((await body(request) or {}).get("text"), 600)
        if not query:
            return reject("PUBLIC_TEXT_REQUIRED")
        return {"notes": await service.recall(session, query)}

    @app.delete(base + "/notes/{note_id}")
    async def forget(sid: str, note_id: str, request: Request):
        session = authorize(sid, request)
        if isinstance(session, Response):
            return session
        store = await service.store()
        return {"deleted": await asyncio.to_thread(store.delete_note, note_id)}
