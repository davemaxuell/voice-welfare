"""받은 파일의 원문·질문·승인을 실제 턴 경로로 시험한다. 모델 호출은 메모리 안에서 받는다."""
import asyncio
import base64
import json
import zipfile

import httpx
import pytest
from conftest import FakeLlm, create_test_runtime, flat
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, NameObject


@pytest.fixture
async def file_session(new_session):
    runtime = create_test_runtime({"LLM_FILE_PROVIDER": "openai", "LLM_FILE_MODEL": "test-vision", "LLM_FILE_API_KEY": "test"})
    try:
        yield await new_session(runtime)
    finally:
        await runtime.close()


def use_model(http_mock, answer="신청 기한은 12월 31일이에요.", evidence=()):
    def handler(request):
        assert str(request.url) == "https://api.openai.com/v1/chat/completions"
        result = json.dumps({"answer": answer, "evidence": list(evidence)}, ensure_ascii=False)
        return httpx.Response(200, json={"choices": [{"message": {"content": result}}]})

    return http_mock(handler)


async def test_local_read_stays_private_after_another_plan_step(file_session, tmp_path):
    s = file_session
    marker = "노란 수첩에 적은 개인 메모"
    path = tmp_path / "안내.hwpx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("Contents/section0.xml", f"<r><t>{marker}</t></r>")
    s.web.adapter.downloads.remember(path)
    model = FakeLlm({
        "intent_plan": {"steps": [flat("READ_DOWNLOAD"), flat("UNKNOWN", text="일주일은 며칠인가요?")]},
        "chat_route": {"route": "general", "reply": "7일이에요."},
    })
    s.deps.llm = model
    result = await s.handle_turn("받은 문서를 읽고 일주일이 며칠인지도 말해줘")
    assert marker in result["speech"] and "7일이에요" in result["speech"]
    model.answers["intent_plan"] = {"steps": [flat("UNKNOWN")]}
    await s.handle_turn("그 밖에 또 무엇이 있을까?")
    assert sum(c["schemaName"] == "intent_plan" for c in model.calls) == 2
    assert all(marker not in c["user"] for c in model.calls)


def scanned_pdf(path):
    writer = PdfWriter()
    page = writer.add_blank_page(width=100, height=100)
    # 글자 레이어 없이 회색 픽셀 하나만 그린 실제 PDF 페이지.
    stream = DecodedStreamObject()
    stream.set_data(b"q 100 0 0 100 0 0 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI Q")
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.write(path)


@pytest.mark.parametrize("approve_with_button", [False, True])
async def test_scan_upload_is_bound_to_one_confirmation(file_session, tmp_path, http_mock, approve_with_button):
    s = file_session
    calls = use_model(http_mock)
    path = tmp_path / "playwright-temporary-name"
    scanned_pdf(path)
    s.web.adapter.downloads.remember(path, "안내문.pdf")
    assert "글을 찾지 못했어요" in (await s.handle_turn("받은 파일 그대로 읽어줘"))["speech"]
    ask = await s.handle_turn("받은 PDF에서 신청 기한이 언제야?")
    assert ask["state"] == "WAITING_FOR_USER_CONFIRMATION"
    assert all(word in ask["speech"] for word in ("안내문.pdf", "OpenAI", "개인 정보"))
    assert not calls
    action_id = ask["pendingConfirmation"]["actionId"]
    assert "바뀌었어요" in (await s.confirm(True, "file:other"))["speech"]
    assert not calls
    result = await s.confirm(True, action_id) if approve_with_button else await s.handle_turn("네")
    assert "AI가 이미지를" in result["speech"] and "12월 31일" in result["speech"]
    await s.confirm(True, action_id)
    assert len(calls) == 1
    payload = json.loads(calls[0].content)
    assert payload["model"] == "test-vision"
    parts = payload["messages"][1]["content"]
    assert "신청 기한" in parts[0]["text"]
    assert parts[1]["type"] == "file"
    assert base64.b64decode(parts[1]["file"]["file_data"].split(",")[1]) == path.read_bytes()


async def test_file_replacement_refusal_stop_and_unrelated_speech(file_session, tmp_path, http_mock):
    s = file_session
    calls = use_model(http_mock)
    path = tmp_path / "안내.png"
    path.write_bytes(b"first")
    s.web.adapter.downloads.remember(path)
    await s.handle_turn("받은 파일 요약해줘")
    path.write_bytes(b"other")
    assert "파일이 바뀌어서" in (await s.handle_turn("응"))["speech"]
    for reply in ("아니요", "네이버", "멈춰"):
        assert (await s.handle_turn("받은 파일 요약해줘"))["pendingConfirmation"]
        response = await s.handle_turn(reply)
        if reply == "멈춰":
            assert response["state"] == "STOPPED" and "파일을 보내지 않았어요" in response["speech"]
        assert s.dialogue.approval is None
        await s.handle_turn("네")
    assert not calls


async def test_queued_yes_and_new_download_with_same_name(file_session, tmp_path, http_mock):
    s = file_session
    calls = use_model(http_mock)
    first = tmp_path / "A"
    second = tmp_path / "B"
    first.write_bytes(b"first-file")
    second.write_bytes(b"second-file")
    store = s.web.adapter.downloads
    store.remember(first, "안내.png")
    # 같은 시점에 받은 두 발화. '네'를 말했을 때 전송 안내는 아직 없었다.
    prompt, premature = await asyncio.gather(s.handle_turn("받은 파일 요약해줘"), s.handle_turn("네"))
    assert prompt["pendingConfirmation"] and "현재 안내" in premature["speech"]
    assert not calls
    store.remember(second, "안내.png")
    assert "파일이 바뀌어서" in (await s.handle_turn("네"))["speech"]
    assert not calls
    await s.handle_turn("받은 파일 요약해줘")
    assert "AI가 이미지를" in (await s.handle_turn("네"))["speech"]
    part = json.loads(calls[0].content)["messages"][1]["content"][1]
    assert part == {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(second.read_bytes()).decode()}}


async def test_hwpx_grounding_and_local_fallback(file_session, tmp_path, http_mock):
    s = file_session
    calls = use_model(http_mock, answer="99만 원이에요.", evidence=["교통비 12만 원"])
    path = tmp_path / "안내.hwpx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("Contents/section0.xml", "<r><t>교통비 12만 원</t></r>")
    s.web.adapter.downloads.remember(path)
    ask = await s.handle_turn("받은 파일 요약해줘")
    assert "본문" in ask["speech"]
    assert "근거를 확인하지 못했어요" in (await s.handle_turn("예"))["speech"]
    assert len(calls) == 1
    assert "교통비 12만 원" in json.loads(calls[0].content)["messages"][1]["content"]
    s.deps.file_llm = None
    answer = await s.handle_turn("받은 파일 요약해줘")
    assert "원문" in answer["speech"] and "교통비 12만 원" in answer["speech"]
    assert len(calls) == 1


async def test_size_and_page_limits_avoid_upload(file_session, tmp_path, http_mock):
    from cheongeum.agents.web.file_answer import MAX_BYTES, MAX_PAGES

    calls = use_model(http_mock)
    store = file_session.web.adapter.downloads
    path = tmp_path / "big.pdf"
    with path.open("wb") as f:
        f.truncate(MAX_BYTES + 1)
    store.remember(path)
    large = await file_session.handle_turn("받은 파일 요약해줘")
    assert "20MB" in large["speech"] and large.get("pendingConfirmation") is None
    writer = PdfWriter()
    for _ in range(MAX_PAGES + 1):
        writer.add_blank_page(width=100, height=100)
    writer.write(path)
    await file_session.handle_turn("받은 파일 요약해줘")
    assert "100쪽" in (await file_session.handle_turn("네"))["speech"]
    assert not calls


async def test_stop_during_model_request_ends_progress(file_session, tmp_path):
    started = asyncio.Event()

    class WaitingFileModel(FakeLlm):
        file_recipient = "OpenAI"

        async def generate(self, *, signal, **kwargs):
            started.set()
            await signal.wait()
            return {"answer": "중단한 파일의 내용", "evidence": []}

    s = file_session
    s.deps.file_llm = WaitingFileModel()
    path = tmp_path / "안내.png"
    path.write_bytes(b"image")
    s.web.adapter.downloads.remember(path)
    await s.handle_turn("받은 파일 요약해줘")
    pending = asyncio.create_task(s.handle_turn("네"))
    try:
        await asyncio.wait_for(started.wait(), 3)
        assert s.progress.running and "파일을 읽는 중" in s.progress.latest
        assert (await s.handle_turn("멈춰"))["state"] == "STOPPED"
        result = await asyncio.wait_for(pending, 3)
        assert result["state"] == "STOPPED" and "중단한 파일의 내용" not in result["speech"]
        assert not s.progress.running
    finally:
        pending.cancel()
