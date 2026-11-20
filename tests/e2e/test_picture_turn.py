import asyncio
import base64
import json
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from cheongeum.agents.web.browser import AdapterError
from cheongeum.core.llm import LlmConfig, create_vision_llm
from cheongeum.core.picture import png_size
from cheongeum.personal.action_log import ActionLog
from cheongeum.speech.picture import HISTORY_DESCRIBED, UNCHECKED_NUMBERS
from conftest import FakeLlm, MOCK_URL, create_test_runtime


QUESTION = "스크린샷으로 접수 마감과 누를 수 있는 것을 알려줘"
DESCRIPTION = "접수가 23일에 끝나요."


def text_reader(decision, answer="", evidence=()):
    return FakeLlm({"screen_text_decision": {"decision": decision, "answer": answer, "evidence": list(evidence)}})


async def picture_session(new_session):
    session = await new_session()
    await session.web.adapter.page.goto(MOCK_URL + "/picture.html")
    session.deps.vision_llm = create_vision_llm(LlmConfig(provider="openai", model="test", apiKey="test"))
    return session


def model_reply(request):
    reply = {"screen": "normal", "description": DESCRIPTION, "pressable": [999, 1]}
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(reply)}}]})


def check_request(request):
    assert str(request.url) == "https://api.openai.com/v1/chat/completions"
    body = json.loads(request.content)
    assert body["response_format"]["json_schema"]["name"] == "screen_picture"
    prompt, image = body["messages"][-1]["content"]
    assert QUESTION in prompt["text"] and "1. 닫기" in prompt["text"]
    assert "900101-1234567" not in prompt["text"]
    assert png_size(base64.b64decode(image["image_url"]["url"].split(",")[1])) == (1100, 860)


@pytest.mark.parametrize("replace_button", [False, True])
async def test_numbered_followup_uses_the_control_that_was_described(new_session, http_mock, replace_button):
    s = await picture_session(new_session)
    s.deps.web_llm = text_reader("answer", "이미지를 생략합니다.", ["닫기"])
    page = s.web.adapter.page
    calls = http_mock(model_reply)
    s.web.action_log = ActionLog()
    await page.evaluate("() => { document.querySelector('#close').onclick = () => document.querySelector('#close').remove(); }")
    response = await s.handle_turn(QUESTION)
    assert response["semanticAction"] == "describe-picture"
    assert s.deps.web_llm.calls == []
    check_request(calls[0])
    capture, = response["actions"]
    assert capture["action"]["type"] == "capture" and capture["policy"]["allowed"]
    assert [r["phase"] for r in s.web.action_log.recent()] == ["before", "after"]
    assert "base64" not in json.dumps(response)
    assert all(part in response["speech"] for part in (DESCRIPTION, UNCHECKED_NUMBERS, "1번 '닫기'")), response["speech"]
    assert s.export_history()[-1]["text"] == HISTORY_DESCRIBED
    if replace_button:
        await page.evaluate("""() => {
            const old = document.querySelector('#close');
            const next = old.cloneNode(true);
            next.onclick = old.onclick;
            old.replaceWith(next);
        }""")
    follow = await s.handle_turn("1번 눌러줘")
    assert await page.locator("#close").count() == int(replace_button)
    if replace_button:
        assert "바뀌었어요" in follow["speech"]
    assert len(calls) == 1


async def test_compound_turn_does_not_put_picture_text_into_planner_history(new_session, http_mock):
    s = await picture_session(new_session)
    calls = http_mock(model_reply)
    response = await s.handle_turn(f"{QUESTION} 그리고 화면 설명해줘")
    assert DESCRIPTION in response["speech"]
    assert calls and all(DESCRIPTION not in json.loads(call.content)["messages"][-1]["content"][0]["text"] for call in calls)
    assert DESCRIPTION not in s.export_history()[-1]["text"]


async def test_selected_passage_is_explained_without_a_screenshot(new_session, http_mock, monkeypatch):
    s = await picture_session(new_session)
    selected = "대기 접수는 빈자리가 생기면 연락을 드립니다."
    answer = "지금은 대기 명단에 올라가고, 자리가 나면 연락이 온다는 뜻이에요."
    page = s.web.adapter.page
    await page.set_content(f"<main><h1>신청 종류</h1><p>즉시 접수는 오늘 처리합니다.</p><p id='wait'>{selected}</p></main>")
    await page.locator("#wait").evaluate("""el => {
        const range = document.createRange(); range.selectNodeContents(el);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }""")
    s.deps.web_llm = text_reader("answer", answer, [selected])
    capture = AsyncMock(wraps=s.web.adapter.capture)
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    calls = http_mock(model_reply)
    result = await s.handle_turn("이 부분이 무슨 뜻이야?")
    assert answer in result["speech"]
    decision, = s.deps.web_llm.calls
    assert selected in decision["user"]
    capture.assert_not_awaited()
    assert calls == []


async def test_unspecified_part_prompts_for_a_target(new_session, http_mock, monkeypatch):
    s = await picture_session(new_session)
    await s.web.adapter.page.set_content("<main><p>일반 접수</p><p>대기 접수</p></main>")
    s.deps.web_llm = text_reader("clarify", "어느 부분인지 알려 주시겠어요?")
    capture = AsyncMock(wraps=s.web.adapter.capture)
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    calls = http_mock(model_reply)
    result = await s.handle_turn("이 부분이 무슨 뜻이야?")
    assert any(word in result["speech"] for word in ("어느", "어떤", "선택", "가리"))
    capture.assert_not_awaited()
    assert calls == []


async def test_focused_input_uses_its_label_without_sending_the_value(new_session, http_mock):
    s = await picture_session(new_session)
    page = s.web.adapter.page
    await page.set_content('<main><label for="desk">방문 창구</label><input id="desk" value="private-fixture"></main>')
    await page.locator("input").focus()
    s.deps.web_llm = text_reader("answer", "방문할 창구를 적는 곳이에요.", ["방문 창구"])
    calls = http_mock(model_reply)
    result = await s.handle_turn("이 부분이 무슨 뜻이야?")
    decision, = s.deps.web_llm.calls
    assert json.loads(decision["user"])["screenTarget"]["label"] == "방문 창구"
    assert "private-fixture" not in decision["user"]
    assert "방문할 창구" in result["speech"] and calls == []


async def test_chart_with_a_text_equivalent_can_answer_without_vision(new_session, http_mock, monkeypatch):
    s = await picture_session(new_session)
    equivalent = "파란 창구는 운영 중이고 초록 창구는 점심시간입니다."
    await s.web.adapter.page.set_content(f'<main><h1>창구 현황</h1><canvas aria-label="{equivalent}"></canvas></main>')
    s.deps.web_llm = text_reader("answer", "파란 창구가 운영 중이에요.", [equivalent])
    capture = AsyncMock()
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    calls = http_mock(model_reply)
    result = await s.handle_turn("화면 설명해줘")
    decision, = s.deps.web_llm.calls
    assert equivalent in decision["user"]
    assert "파란 창구가 운영 중이에요" in result["speech"]
    capture.assert_not_awaited()
    assert calls == []


async def test_visual_screen_description_sends_one_masked_page_with_recent_user_context(new_session, http_mock, monkeypatch):
    s = await picture_session(new_session)
    page = s.web.adapter.page
    await page.set_content("""<style>body{margin:0}input{width:300px;height:40px}</style>
        <title>신청 접수 안내</title><main><h1>민원 공고문</h1><p>접수 기한은 안내표에 나와 있습니다.</p>
        <canvas aria-label="접수 일정표"></canvas><p>주민등록번호 900101-1234567</p><div style="height:1200px"></div>
        <input aria-label="메모" value="synthetic-field-content"></main>""")
    await page.locator("canvas").evaluate("el => el.getContext('2d').fillText('접수 마감 23일', 10, 40)")
    s.deps.web_llm = text_reader("visual")
    capture = AsyncMock(wraps=s.web.adapter.capture)
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    recent = "신청 마감일을 찾고 있어요."
    private_name = "시험용김별님"
    s._personal.save_vault({"name": private_name})
    s._history.extend([
        {"role": "user", "text": "오래된 입력은 보내지 않아요.", "state": "BROWSING"},
        *({"role": "user", "text": f"기존 요청 {i}", "state": "BROWSING"} for i in range(36)),
        {"role": "user", "text": f"내 이름은 {private_name}", "state": "BROWSING"},
        {"role": "user", "text": recent, "state": "BROWSING"},
        {"role": "assistant", "text": "이전 답변에서 지어낸 문구", "state": "BROWSING"},
    ])
    calls = http_mock(model_reply)
    result = await s.handle_turn("화면 설명해줘")
    assert result["semanticAction"] == "describe-screen" and DESCRIPTION in result["speech"]
    capture.assert_awaited_once()
    decision, = s.deps.web_llm.calls
    assert decision["schemaName"] == "screen_text_decision"
    assert recent in decision["user"] and "접수 기한은 안내표" in decision["user"]
    assert all(value not in decision["user"] for value in (
        private_name, "900101-1234567", "synthetic-field-content", "이전 답변에서 지어낸 문구", "base64"))
    request, = calls
    prompt, image = json.loads(request.content)["messages"][-1]["content"]
    assert all(text in prompt["text"] for text in ("민원 공고문", "접수 기한은 안내표", recent, "화면 설명해줘"))
    assert all(text not in prompt["text"] for text in (
        "오래된 입력은 보내지 않아요", private_name, "900101-1234567", "synthetic-field-content", "이전 답변에서 지어낸 문구"))
    data_url = image["image_url"]["url"]
    _, height = png_size(base64.b64decode(data_url.split(",")[1]))
    assert height == await page.evaluate("document.documentElement.scrollHeight") > 1200
    masked_pixel = await page.locator("input").evaluate("""async (input, url) => {
        const im = new Image(); im.src = url; await im.decode();
        const ctx = document.createElement('canvas').getContext('2d');
        const box = input.getBoundingClientRect();
        ctx.drawImage(im, box.left + 10, box.top + scrollY + 10, 1, 1, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    }""", data_url)
    assert masked_pixel == [0, 0, 0, 255]
    assert "base64" not in json.dumps(result) and DESCRIPTION not in s.export_history()[-1]["text"]


async def test_text_only_commands_skip_image_capture(new_session, http_mock, monkeypatch):
    s = await picture_session(new_session)
    s.deps.web_llm = text_reader("visual")
    await s.web.adapter.page.set_content('<main><h1>월별 통계</h1><canvas aria-label="통계 차트"></canvas></main>')
    calls = http_mock(model_reply)
    capture = AsyncMock(wraps=s.web.adapter.capture)
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    for utterance in ("본문 읽어줘", "도움말", "스크린샷 말고 화면을 설명해줘", "스크린샷 없이 차트를 알려줘"):
        await s.handle_turn(utterance)
    s.deps.vision_llm = None
    assert "모델이 설정되지" in (await s.handle_turn(QUESTION))["speech"]
    capture.assert_not_awaited()
    assert calls == []


async def test_semantic_read_skill_honors_capture_exclusion(new_session, http_mock, monkeypatch):
    s = await picture_session(new_session)
    s.deps.web_llm = text_reader("visual")
    s.deps.llm = FakeLlm({"public_service_decision": {
        "kind": "read_skill", "skill": "DESCRIBE_SCREEN", "source": None, "agency": None,
        "subject": None, "goal": None, "requestedFacts": [], "exclusions": ["screen_capture"],
        "searchMode": None, "continuation": False, "question": None, "choices": [], "reply": None}})
    capture = AsyncMock()
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    calls = http_mock(model_reply)
    result = await s.handle_turn("이 페이지 구성을 글 위주로 한번 짚어 주실래요?")
    assert s.deps.llm.calls[0]["schemaName"] == "public_service_decision"
    assert result["semanticAction"] == "describe-screen" and result["speech"]
    capture.assert_not_awaited()
    assert calls == []


@pytest.mark.parametrize("failure", ["password", "provider"])
async def test_screen_description_uses_text_when_the_image_is_unavailable(new_session, http_mock, failure):
    s = await picture_session(new_session)
    s.deps.web_llm = text_reader("visual")
    password = '<input type="password">' if failure == "password" else ""
    await s.web.adapter.page.set_content(f"""<title>공고 안내문</title><main><h1>공고 안내문</h1>
        <p>접수 안내입니다.</p><canvas aria-label="일정표"></canvas>{password}</main>""")
    calls = http_mock(lambda request: httpx.Response(503, json={"error": "fixture"}))
    result = await s.handle_turn("화면 설명해줘")
    if failure == "password":
        assert result["semanticAction"] in ("describe-screen", "auth-handoff") and result["speech"]
        assert calls == [] and all(a["action"]["type"] != "capture" for a in result["actions"])
    else:
        assert result["semanticAction"] == "describe-screen" and "공고 안내문" in result["speech"]
        assert calls and all("base64" not in msg["text"] for msg in s.export_history())


@pytest.mark.parametrize("utterance", [QUESTION, "화면 설명해줘"])
async def test_declined_consent_refuses_before_observing_or_capturing(new_session, monkeypatch, utterance):
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    try:
        s = await new_session(rt)
        await s.consent_to(False)
        observe = AsyncMock()
        monkeypatch.setattr(s.web.adapter, "observe", observe)
        assert (await s.handle_turn(utterance))["semanticAction"] == "consent"
        observe.assert_not_awaited()
    finally:
        await rt.close()


async def test_capture_failure_does_not_contact_provider(new_session, monkeypatch, http_mock):
    s = await picture_session(new_session)
    calls = http_mock(model_reply)
    monkeypatch.setattr(s.web.adapter, "capture", AsyncMock(side_effect=AdapterError("TIMEOUT")))
    result = await s.handle_turn(QUESTION)
    assert "찍지 못했어요" in result["speech"] and calls == []


@pytest.mark.parametrize("failure", ["quota", "audit"])
async def test_capture_requires_action_budget_and_working_audit_log(new_session, monkeypatch, http_mock, failure):
    s = await picture_session(new_session)
    if failure == "quota":
        monkeypatch.setattr(s.web.guard.config, "maxActionsPerTurn", 0)
    else:
        s.web.action_log = Mock()
        s.web.action_log.append.side_effect = OSError()
    calls = http_mock(model_reply)
    capture = AsyncMock()
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    result = await s.handle_turn(QUESTION)
    assert ("횟수" if failure == "quota" else "기록") in result["speech"]
    capture.assert_not_awaited()
    assert calls == []


async def test_lazy_footer_is_in_one_full_page_request_and_its_button_can_be_pressed(new_session, http_mock):
    s = await picture_session(new_session)
    page = s.web.adapter.page
    await page.set_content("""<body style="margin:0"><header>안내문</header><div style="height:2400px"></div>
        <footer id="end" style="height:150px"></footer><script>
        const footer = document.querySelector('#end');
        new IntersectionObserver(([entry], io) => {
            if (!entry.isIntersecting) return;
            footer.innerHTML = '<button onclick="this.remove()">일정 자세히</button>';
            io.disconnect();
        }).observe(footer);
        </script></body>""")
    await page.evaluate("scrollTo(0, 400)")
    previous = await page.evaluate("scrollY")
    assert await page.locator("button").count() == 0
    calls = http_mock(model_reply)
    response = await s.handle_turn(QUESTION)
    assert "1번 '일정 자세히'" in response["speech"]
    request, = calls
    prompt, image = json.loads(request.content)["messages"][-1]["content"]
    assert "일정 자세히" in prompt["text"]
    _, height = png_size(base64.b64decode(image["image_url"]["url"].split(",")[1]))
    assert height == await page.evaluate("document.documentElement.scrollHeight") > 2400
    assert await page.evaluate("scrollY") == previous
    await s.handle_turn("1번 눌러줘")
    assert await page.locator("button").count() == 0


async def test_scrollable_main_panel_restores_its_position_and_masks_its_footer(new_session, http_mock):
    s = await picture_session(new_session)
    page = s.web.adapter.page
    await page.set_content("""<style>*{box-sizing:border-box}body{margin:0;overflow:hidden}
        main{height:100vh;overflow:auto}p{margin:0;height:85px;background:#ffcc00}</style>
        <main><div style="height:1800px">위쪽 안내</div><p>계좌번호 110-123-456789</p></main>""")
    await page.locator("main").evaluate("(el) => { el.scrollTop = 460; }")
    calls = http_mock(model_reply)
    await s.handle_turn(QUESTION)
    req, = calls
    image = json.loads(req.content)["messages"][-1]["content"][1]["image_url"]["url"]
    assert png_size(base64.b64decode(image.split(",")[1])) == (1100, 1885)
    pixel = await page.evaluate("""async (url) => {
        const im = new Image(); im.src = url; await im.decode();
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.drawImage(im, 500, 1840, 1, 1, 0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    }""", image)
    assert pixel == [0, 0, 0, 255]
    assert await page.locator("main").evaluate("(el) => [el.scrollTop, el.clientHeight]") == [460, 860]


async def test_oversize_page_is_refused_before_any_screenshot_or_upload(new_session, http_mock, monkeypatch):
    s = await picture_session(new_session)
    page = s.web.adapter.page
    await page.set_content('<main style="height:80000px">아주 긴 목록</main>')
    screenshot = AsyncMock()
    monkeypatch.setattr(page, "screenshot", screenshot)
    calls = http_mock(model_reply)
    result = await s.handle_turn(QUESTION)
    assert "너무 크거나" in result["speech"]
    screenshot.assert_not_awaited()
    assert calls == []


@pytest.mark.parametrize("interrupt", ["stop", "navigate"])
async def test_interrupted_text_decision_does_not_capture_the_new_screen(new_session, http_mock, monkeypatch, interrupt):
    s = await picture_session(new_session)
    page = s.web.adapter.page
    await page.set_content('<main><h1>일정표</h1><canvas aria-label="접수 일정표"></canvas></main>')
    ready, release = asyncio.Event(), asyncio.Event()

    async def pause_decision(**kwargs):
        ready.set()
        await release.wait()
        return {"decision": "visual", "answer": "", "evidence": []}

    s.deps.web_llm = text_reader("visual")
    monkeypatch.setattr(s.deps.web_llm, "generate", pause_decision)
    capture = AsyncMock(wraps=s.web.adapter.capture)
    monkeypatch.setattr(s.web.adapter, "capture", capture)
    calls = http_mock(model_reply)
    pending = asyncio.create_task(s.handle_turn("화면 설명해줘"))
    try:
        await asyncio.wait_for(ready.wait(), 10)
        if interrupt == "stop":
            await asyncio.wait_for(s.handle_turn("멈춰"), 5)
        else:
            await page.goto(MOCK_URL)
    finally:
        release.set()
        result = await pending
    if interrupt == "stop":
        assert result["state"] == "STOPPED"
    capture.assert_not_awaited()
    assert calls == []


async def test_interrupt_while_capturing_discards_the_picture(new_session, monkeypatch, http_mock):
    s = await picture_session(new_session)
    calls = http_mock(model_reply)
    capture = s.web.adapter.capture
    ready, release = asyncio.Event(), asyncio.Event()

    async def pause(*args):
        picture = await capture(*args)
        ready.set()
        await release.wait()
        return picture

    monkeypatch.setattr(s.web.adapter, "capture", pause)
    pending = asyncio.create_task(s.handle_turn(QUESTION))
    try:
        await asyncio.wait_for(ready.wait(), 10)
        await asyncio.wait_for(s.handle_turn("멈춰"), 5)
    finally:
        release.set()
    result = await pending
    assert result["state"] == "STOPPED" and calls == []
