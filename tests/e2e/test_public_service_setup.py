"""첫 이용 설정부터 API 음성, 기관 전환과 후속 질문까지 같은 세션으로 확인한다."""
import json
from types import SimpleNamespace

import httpx
import pytest

from conftest import FakeLlm, create_test_runtime, step, with_llm
from cheongeum.agents.web.playbook import guide_section
from cheongeum.personal.seal import Seal
from cheongeum.server.app import close_all, create_app
from cheongeum.server.runtime import AgentRuntime
from cheongeum.server.settings import SettingsInput, SettingsStore


def test_scholarship_procedure_uses_selected_tab_for_evidence():
    view = {"url": "https://www.kosaf.go.kr/ko/scholar.do?pg=scholarship05_12_01_01&ttab1=2",
            "outline": {"mainText": "지난 학기 신청일정 8월 12일~9월 9일\n국가장학금Ⅰ유형(학생직접지원형) 지원절차\n온라인 신청\n가구원동의"}}
    text = guide_section(view, "국가장학금 신청 방법 알려줘")["outline"]["mainText"]
    assert "온라인 신청" in text and "지난 학기" not in text
    assert guide_section(view, "신청 일정도 알려줘") == view


async def test_settings_enable_audio_planning_and_survive_restart(tmp_path, request):
    path = tmp_path / "preferences.json"
    def store():
        return SettingsStore(path, lambda: Seal(key=b"a" * 32))

    rt = create_test_runtime({"VOICE_BASE_URL": "https://old.example/v1", "LLM_BASE_URL": "https://old.example/v1", "PRACTICE_MODE": "false"})
    rt.settings = store()
    app, sessions = create_app(rt)
    key = "sk-test-onboarding"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
        assert (await c.get("/api/health")).json()["setupRequired"]
        assert (await c.post("/api/session")).status_code == 409
        invalid = await c.post("/api/settings", json={"apiKey": key, "speed": 10})
        assert invalid.status_code == 400 and key not in invalid.text and not path.exists()
        assert (await c.post("/api/settings", json={"apiKey": key, "region": "부산", "language": "en", "speed": 1.6, "deviceUse": "personal", "rememberService": True})).is_success
        assert key.encode() not in path.read_bytes()
        public = await c.get("/api/settings")
        health = await c.get("/api/health")
        assert key not in public.text + health.text and not health.json()["setupRequired"]
        assert public.json()["hasKey"] and public.json()["region"] == "부산광역시"
        assert all("openai" in health.json()["llmRoles"][r] for r in ("understand", "goal", "web"))

        def upstream(req):
            assert req.url.host == "api.openai.com" and req.headers["Authorization"] == "Bearer " + key
            if req.url.path.endswith("/transcriptions"):
                return httpx.Response(200, json={"text": "정부24 열어줘"})
            assert json.loads(req.content)["speed"] == pytest.approx(1.6)
            return httpx.Response(200, content=b"audio")

        sid = (await c.post("/api/session")).json()["sessionId"]
        await c.post(f"/api/session/{sid}/consent", json={"granted": True})
        calls = request.getfixturevalue("http_mock")(upstream)
        assert (await c.post(f"/api/audio/transcribe?sessionId={sid}", content=b"x" * 250, headers={"Content-Type": "audio/wav"})).json()["text"] == "정부24 열어줘"
        assert (await c.post("/api/audio/speak", json={"text": "청음입니다.", "rate": 1.25})).content == b"audio"
        assert len(calls) == 2
        assert (await c.post("/api/settings", json={"apiKey": "", "region": "부산", "language": "en", "speed": 0.85, "deviceUse": "personal", "rememberService": True})).is_success
        assert (await c.get("/api/settings")).json()["hasKey"]
        assert rt.settings.claim_startup_guide() is True
        rt.settings.remember_service("한국장학재단", "국가장학금")
    await close_all(sessions)
    await rt.close()
    next_run = AgentRuntime(rt.config, store())
    assert next_run.settings.claim_startup_guide() is False
    s = await next_run.create_session()
    try:
        assert s.lang == "en" and s._profile["ctpv"] == "부산광역시"
        assert s._public_followup("그럼 서류는?") == "한국장학재단에서 국가장학금 그럼 서류는?"
        assert next_run.tts.speed == 0.85 and next_run.stt.api_key == key
        next_run.settings.save(SettingsInput(rememberService=False))
        assert store().last_service is None
    finally:
        await s.close()
        await next_run.close()


async def test_switches_official_sites_and_keeps_followup_on_scholarships(new_session):
    s = await new_session()
    quote = "국가장학금 신청 안내와 제출 서류를 확인하세요."
    async def page(route):
        await route.fulfill(content_type="text/html; charset=utf-8", body=f"<title>공공서비스 안내</title><main>{quote}</main>")
    for host in ("www.bokjiro.go.kr", "www.gov.kr", "www.kosaf.go.kr", "portal.kosaf.go.kr", "www.epeople.go.kr", "www.work24.go.kr"):
        await s.web.adapter.page.route(f"https://{host}/**", page)
    assert (await s.handle_turn("복지로 열어줘"))["observation"]["url"].startswith("https://www.bokjiro.go.kr/")
    # 규칙만 있어도 해당 기관의 공개 업무 안내 화면까지 연다.
    gov = await s.handle_turn("주민등록등본 발급 방법 알려줘")
    assert gov["intentType"] == "GOAL" and "CappBizCD=13100000015" in gov["observation"]["url"]
    llm = FakeLlm({"browse_step": step("answer", None, quote, [quote])})
    with_llm(s, llm)
    for query in ("장학재단에서 국가장학금 신청 기간 찾아줘", "그럼 신청 서류는 뭐가 필요해?"):
        result = await s.handle_turn(query)
        assert result["intentType"] == "GOAL" and result["state"] == "BROWSING"
        assert result["sources"][0]["url"].startswith("https://www.kosaf.go.kr/")
    last_prompt = json.loads(next(call["user"] for call in reversed(llm.calls) if call["schemaName"] == "browse_step"))
    assert last_prompt["conversation"]["service"] == "국가장학금"
    assert any("신청 기간" in x["request"] for x in last_prompt["conversation"]["recentTurns"])
    assert "주민등록등본" not in str(last_prompt["conversation"])
    assert "ttab1=3" in result["sources"][0]["url"]
    for query, domain in (("민원24 열어줘", "www.gov.kr"), ("국민신문고로 가줘", "www.epeople.go.kr"), ("고용 이십사 열어줘", "www.work24.go.kr")):
        assert (await s.handle_turn(query))["observation"]["url"] == "https://" + domain + "/"


async def test_editing_settings_keeps_the_current_task_and_forgets_shared_device_topic(tmp_path):
    path = tmp_path / "preferences.json"
    store = SettingsStore(path, lambda: Seal(key=b"b" * 32))
    rt = create_test_runtime({"PRACTICE_MODE": "false"})
    rt.settings = store
    app, sessions = create_app(rt)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as c:
            prefs = {"deviceUse": "personal", "rememberService": True}
            assert (await c.post("/api/settings", json={**prefs, "apiKey": "sk-test-first"})).is_success
            sid = (await c.post("/api/session")).json()["sessionId"]
            s = sessions.get(sid)
            await s.web.adapter.page.route("https://www.gov.kr/**", lambda r: r.fulfill(body="<main>Gov24</main>", content_type="text/html"))
            opened = (await c.post("/api/turn", json={"sessionId": sid, "text": "정부24 열어줘"})).json()
            assert opened["intentType"] == "OPEN_SITE" and store.last_service == ("정부24", "")
            assert (await c.post("/api/settings", json={**prefs, "apiKey": "sk-test-rotation", "region": "서울",
                                                       "speed": 1.6, "deviceUse": "shared"})).is_success
            assert store.last_service is None and not store.preferences.rememberService
            assert (await c.post("/api/turn", json={"sessionId": sid, "text": "시작 안내 다시 읽어줘"})).json()["intentType"] == "READ_START_GUIDE"
            assert s.deps.llm is rt.understand_llm and s._profile["ctpv"] == "서울특별시"
            assert s._public_task.agency == "정부24" and rt.tts.speed == 1.6
            assert SettingsStore(path, lambda: Seal(key=b"b" * 32)).last_service is None
    finally:
        await close_all(sessions)
        await rt.close()


async def test_reads_legacy_portal_without_mistaking_a_notice_for_login(new_session):
    s = await new_session()
    body = """<title>고용24</title><main><form><h1>실업급여 신청 안내</h1>
        <a href="#news">간편인증 서비스 점검 안내(11.22)</a>
        <div style="display:none">접속이 차단되었습니다</div><textarea>작성 중인 개인 정보</textarea>
        <p>이 안내에서 필요한 서류를 확인하세요.</p></form></main>
        <script>const filter = Array.prototype.filter;
        Array.prototype.filter = function(fn) {return filter.call(this, (v,i) => fn(v,i));};</script>"""
    await s.web.adapter.page.route("https://www.work24.go.kr/**", lambda route: route.fulfill(content_type="text/html; charset=utf-8", body=body))
    assert (await s.handle_turn("고용24 열어줘"))["state"] == "BROWSING"
    text = s.web.current_view["outline"]["mainText"]
    assert "필요한 서류" in text and "차단" not in text and "작성 중인" not in text
    assert (await s.handle_turn("시작 안내 다시 읽어줘"))["intentType"] == "READ_START_GUIDE"


async def test_speech_repair_waits_for_agreement_and_accepts_a_correction():
    rt = create_test_runtime({"PRACTICE_MODE": "false"})
    transcripts = iter(("주민등록 등봉 발급 방법 알려줘", "아니요", "주민등록본 발급 방법 알려줘", "1번",
                        "장학제단에서 국가장학금 신청 방법 찾아줘", "뉘엿 뭉개", "네", ""))
    async def transcribe(*args, **kwargs):
        return {"text": next(transcripts)}
    app, sessions = create_app(rt, voice=SimpleNamespace(stt=SimpleNamespace(supported=True, transcribe=transcribe), tts=rt.tts))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
            sid = (await client.post("/api/session")).json()["sessionId"]
            s = sessions.get(sid)
            llm = FakeLlm({"speech_repair": {"suggestion": "고용24 열어줘"},
                           "browse_step": step("answer", None, "서류를 확인하세요.", ["서류를 확인하세요."])})
            with_llm(s, llm)
            for host in ("www.gov.kr", "www.kosaf.go.kr", "www.work24.go.kr"):
                await s.web.adapter.page.route(f"https://{host}/**", lambda route: route.fulfill(
                    content_type="text/html; charset=utf-8", body="<title>공식 안내</title><main>서류를 확인하세요.</main>"))
            async def say():
                return (await client.post("/api/audio/turn", params={"sessionId": sid}, content=b"x" * 500,
                                          headers={"Content-Type": "audio/wav"})).json()
            ask = await say()
            assert "주민등록등본" in ask["speech"] and ask["semanticAction"] == "clarify" and not ask["actions"]
            assert ask["publicSuggestions"] == ["주민등록등본"]
            assert not (await say())["actions"]
            choice = await say()
            assert "등본" in choice["speech"] and "초본" in choice["speech"] and not choice["actions"]
            assert set(choice["publicSuggestions"]) == {"주민등록등본", "주민등록초본"}
            assert (await say())["observation"]["url"].startswith("https://www.gov.kr/")
            assert (await say())["observation"]["url"].startswith("https://www.kosaf.go.kr/")
            model_guess = await say()
            assert "고용24" in model_guess["speech"] and not model_guess["actions"]
            assert not model_guess.get("publicSuggestions")
            prompt = next(json.loads(c["user"]) for c in llm.calls if c["schemaName"] == "speech_repair")
            assert prompt["context"]["service"] == "국가장학금"
            assert (await say())["observation"]["url"].startswith("https://www.work24.go.kr/")
            assert "고용24" in (await say())["message"]
    finally:
        await close_all(sessions)
        await rt.close()
