"""요청 경계를 합성 ASGI 요청으로 확인한다."""

from types import SimpleNamespace

import httpx
import pytest

from cheongeum.server.app import create_app


@pytest.mark.parametrize(
    ("method", "path", "headers", "body", "status", "code"),
    [
        ("GET", "/api/health", {"host": "example.invalid:8790"}, b"", 400, "INVALID_HOST"),
        ("GET", "/api/health", {"host": "[invalid]:8790"}, b"", 400, "INVALID_HOST"),
        ("POST", "/api/session", {"host": "localhost:8787"}, b"", 400, "INVALID_HOST"),
        ("POST", "/api/session", {"origin": "null"}, b"", 403, "INVALID_ORIGIN"),
        ("POST", "/api/session", {"origin": "http://localhost:8787"}, b"", 403, "INVALID_ORIGIN"),
        ("POST", "/api/session", {"sec-fetch-site": "cross-site"}, b"", 403, "INVALID_ORIGIN"),
        ("POST", "/api/turn", {"content-type": "text/plain"}, b"{}", 415, "UNSUPPORTED_MEDIA_TYPE"),
        ("POST", "/api/audio/transcribe", {"content-type": "application/json"}, b"{}", 415, "UNSUPPORTED_MEDIA_TYPE"),
        ("POST", "/api/audio/speak", {"content-type": "audio/webm"}, b"a", 415, "UNSUPPORTED_MEDIA_TYPE"),
    ],
)
async def test_refused_requests_never_reach_runtime(method, path, headers, body, status, code):
    absent_provider = SimpleNamespace(supported=False)
    app, sessions = create_app(SimpleNamespace(stt=absent_provider, tts=absent_provider), port=8790)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:8790") as client:
        response = await client.request(method, path, headers=headers, content=body)
    assert (response.status_code, response.json()["error"]) == (status, code)
    assert len(sessions) == 0


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
async def test_local_api_accepts_same_origin_and_non_browser_clients(host):
    absent_provider = SimpleNamespace(supported=False)
    app, _ = create_app(SimpleNamespace(stt=absent_provider, tts=absent_provider), port=8790)
    url = f"http://{host}:8790"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=url) as client:
        for headers in ({}, {"origin": url, "sec-fetch-site": "same-origin"}):
            response = await client.post("/api/turn", headers=headers, json={})
            assert response.json()["error"] == "BAD_REQUEST"
        assert (await client.delete("/api/session/synthetic")).json()["error"] == "SESSION_NOT_FOUND"
