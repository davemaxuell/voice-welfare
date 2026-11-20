"""첫 실행 설정의 키 확인: 한 번 불러 보고 결과를 네 가지로만 알린다(키는 돌려주지 않는다)."""
import httpx
import pytest

from conftest import create_test_runtime
from cheongeum.server import app as app_module
from cheongeum.server.app import close_all, create_app
from cheongeum.server.key_check import check_openai_key


@pytest.mark.parametrize(("status", "expected"), [(200, "ok"), (401, "invalid"), (403, "invalid"), (429, "quota"), (500, "network")])
async def test_key_check_maps_status(http_mock, status, expected):
    def handle(req):
        assert req.method == "GET" and req.url == "https://api.openai.com/v1/models"
        assert req.headers["Authorization"] == "Bearer sk-test"
        return httpx.Response(status, json={})

    calls = http_mock(handle)
    assert await check_openai_key("sk-test", "https://api.openai.com/v1/") == expected
    assert len(calls) == 1


async def test_key_check_network_error(http_mock):
    def down(req):
        raise httpx.ConnectError("down", request=req)

    http_mock(down)
    assert await check_openai_key("sk-test", "https://api.openai.com/v1") == "network"


async def test_check_key_endpoint_never_echoes_the_key(monkeypatch):
    seen = []

    async def fake(key, base_url, **_):
        seen.append((key, base_url))
        return "invalid"

    monkeypatch.setattr(app_module, "check_openai_key", fake)
    rt = create_test_runtime()
    app, sessions = create_app(rt)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            r = await c.post("/api/settings/check-key", json={"apiKey": "sk-secret-123"})
            assert r.json() == {"result": "invalid"} and "sk-secret-123" not in r.text
            assert seen == [("sk-secret-123", rt.config.voice.baseUrl)]
            bad = await c.post("/api/settings/check-key", json={"apiKey": "has space"})
            assert bad.status_code == 400 and "has space" not in bad.text
            assert (await c.post("/api/settings/check-key", json={})).status_code == 400
    finally:
        await close_all(sessions)
        await rt.close()
