"""The voice model can request delegation; only its authenticated transcript becomes a turn."""
import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, call

import httpx
import pytest
from starlette.testclient import TestClient

from cheongeum.core.llm import LlmConfig, SIMPLE_TEXT_SCHEMA, create_structured_llm
from cheongeum.core.model_stack import STACK
from cheongeum.core.progress import Progress
from cheongeum.server import voice_edge
from cheongeum.server.app import create_app
from cheongeum.server.voice_edge import LiveProvider, Transcript, VoiceEdge
from cheongeum.voice.config import VoiceConfig, create_voice_providers


def delta(text, start, end, kind="input", event_id=None):
    return {"type": f"session.{kind}_transcript.delta", "delta": text,
            "start_ms": start, "end_ms": end, "event_id": event_id or f"{kind}-{start}"}


def delegation(id_, offset, target="client"):
    return {"type": "session.delegation.created", "offset_ms": offset, "delegation": {"id": id_, "target": target}}


def test_edge_selection_is_endpoint_and_key_specific():
    for config, expected in [
        (VoiceConfig(), None), (VoiceConfig(apiKey="dummy"), "gpt-live-1"),
        (VoiceConfig(apiKey="dummy", liveModel="gpt-live-transcribe"), None),
        (VoiceConfig(apiKey="dummy", baseUrl="https://custom.example/v1"), None),
    ]:
        stt, _ = create_voice_providers(config)
        assert getattr(stt, "edge_model", None) == expected
        if config.apiKey:
            assert stt.model == "gpt-transcribe" and stt.live.model == "gpt-live-transcribe"


async def test_live_offer_seeds_recent_redacted_app_dialogue(new_session, monkeypatch):
    session = await new_session()
    stt, _ = create_voice_providers(VoiceConfig(apiKey="dummy"))
    provider = LiveProvider(stt)
    requests = []

    def respond(request):
        requests.append(json.loads(request.content))
        return httpx.Response(201, json={"session": {"id": "live_test"}, "transport": {"sdp": "answer-test"}})

    def client(**kwargs):
        return httpx.AsyncClient(transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("cheongeum.server.voice_edge.httpx", SimpleNamespace(AsyncClient=client))
    await provider.offer("v=0", session, 1.35)
    config = requests[-1]["session"]
    assert "input" not in config
    assert "triggers" not in config
    assert config["delegation"]["type"] == "decisions"
    question, = config["delegation"]["decisions"]["questions"]
    assert question["name"] == "sol_effort"
    assert [item["value"] for item in question["choices"]] == ["low", "medium", "high"]

    await session.handle_turn("도움말 알려줘")
    first_kept = await session.handle_turn("청음")
    for _ in range(14):
        await session.handle_turn("청음")
    session.remember_call_name("테스트이름")
    await session.handle_turn("테스트이름의 이메일은 contact@example.test")

    await provider.offer("v=0", session, 1.35)
    history = requests[-1]["session"]["input"]
    assert len(history) == 32
    assert [entry["role"] for entry in history] == ["user", "assistant"] * 16
    assert history[0]["content"] == [{"type": "input_text", "text": "청음"}]
    assert history[1]["content"] == [{"type": "output_text", "text": first_kept["speech"]}]
    assert "도움말 알려줘" not in str(history)
    assert "테스트이름" not in str(history)
    assert "contact@example.test" not in str(history)
    assert history[-2]["content"][0]["text"] == "[비공개]의 이메일은 [비공개]"

    await session.handle_turn("내 이름은 별구름이라고 저장해줘")
    await session.handle_turn("아니")
    await provider.offer("v=0", session, 1.35)
    assert "별구름" not in str(requests[-1]["session"]["input"])


async def test_live_offer_falls_back_to_client_when_decisions_are_unavailable(monkeypatch):
    stt, _ = create_voice_providers(VoiceConfig(apiKey="dummy"))
    session = SimpleNamespace(lang="ko", state="IDLE", recent_voice_dialogue=lambda: [])
    modes = []

    def respond(request):
        mode = json.loads(request.content)["session"]["delegation"]["type"]
        modes.append(mode)
        if mode == "decisions":
            return httpx.Response(403)
        return httpx.Response(201, json={"session": {"id": "live_test"}, "transport": {"sdp": "answer-test"}})

    def client(**kwargs):
        return httpx.AsyncClient(transport=httpx.MockTransport(respond), **kwargs)

    monkeypatch.setattr("cheongeum.server.voice_edge.httpx", SimpleNamespace(AsyncClient=client))
    assert await LiveProvider(stt).offer("v=0", session, 1.35) == ("live_test", "answer-test")
    assert modes == ["decisions", "client"]


async def test_live_history_keeps_the_newest_turns_within_the_size_limit(new_session):
    session = await new_session()
    for index in range(12):
        await session.handle_turn(f"테스트 기록 {index} " + "글" * 300)

    history = session.recent_voice_dialogue()
    assert sum(len(message["text"].encode("utf-8")) for message in history) <= 6400
    assert history[-2]["role"] == "user"
    assert history[-2]["text"].startswith("테스트 기록 11 ")
    assert all(not message["text"].startswith("테스트 기록 0 ") for message in history)


async def test_transcript_matches_offsets_and_keeps_fragments_and_approval_together():
    t = Transcript()
    t.add(delta("Thanks", 0, 250), "old")
    t.add(delta("OK.", 300, 450, "output"), "")
    t.add(delta(" Open", 510, 600), "")
    t.add(delta(" KOSAF", 610, 740), "changed")
    t.add(delta("sure", 780, 850, "output"), "")
    t.add(delta(" Next page", 1600, 1900), "new")
    assert t.read(720, consume=True) == ("Open KOSAF", "")
    assert t.read(720) == ("", "")
    assert t.read(1900, consume=True) == ("Next page", "new")


async def test_private_readback_reaches_the_device_without_live_commentary(new_session):
    s = await new_session()
    await s.handle_turn("내 이름은 별구름이라고 저장해줘")
    await s.handle_turn("응")
    sb = Sideband()
    socket = SimpleNamespace(send_json=AsyncMock(), receive=asyncio.Event().wait)
    monitor = asyncio.create_task(VoiceEdge()._monitor(sb, socket, s, lambda: None, ""))
    try:
        await sb.incoming.put(delta("내 정보 알려줘", 50, 460))
        await sb.incoming.put(delegation("read", 470))
        await until(lambda: socket.send_json.await_count)
        await sb.incoming.put({"type": "session.closed"})
        await monitor
        received = socket.send_json.await_args.args[0]
        assert "별구름" in received["result"]["speech"]
        assert received["exact"]
        assert "별구름" not in str(sb.sent)
    finally:
        monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)


class Sideband:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def __aiter__(self):
        while True:
            yield json.dumps(await self.incoming.get())


async def test_late_transcript_replay_and_voice_stop_during_delegated_work():
    sb = Sideband()
    started = asyncio.Event()
    completed = asyncio.Event()
    release = asyncio.Event()
    seen = []
    async def turn(text, *, from_voice, approval_id):
        seen.append((text, from_voice, approval_id))
        if text != "멈춰":
            started.set()
            await release.wait()
            completed.set()
        return {"state": "STOPPED" if text == "멈춰" else "BROWSING", "speech": "완료"}

    session = SimpleNamespace(handle_turn=turn, lang="ko", progress=Progress())
    websocket = SimpleNamespace(send_json=AsyncMock(), receive=asyncio.Event().wait)
    edge = VoiceEdge()
    monitor = asyncio.create_task(edge._monitor(sb, websocket, session, lambda: None, "known-at-start"))
    await sb.incoming.put(delegation("d1", 810))
    for event in (delta("정부24", 100, 380), delta(" 열어줘", 400, 800), delta(" 열어줘", 400, 800),
                  delegation("d1", 810)):
        await sb.incoming.put(event)
    await asyncio.wait_for(started.wait(), 2)
    await sb.incoming.put(delta("멈춰", 1320, 1450))
    await asyncio.wait_for(monitor, 2)
    assert seen == [("정부24 열어줘", True, "known-at-start"), ("멈춰", True, "known-at-start")]
    assert websocket.send_json.await_args.args[0]["result"]["state"] == "STOPPED"
    release.set()
    await asyncio.wait_for(completed.wait(), 1)
    assert not any(e["type"] == "session.commentary.append" for e in sb.sent)


async def test_a_thinking_pause_keeps_the_whole_sentence():
    t = Transcript()
    t.add(delta("로그인은 하지 말고", 0, 900), "")
    t.add(delta(" 국민연금 열어줘", 2200, 3200), "")
    assert t.read(3250, consume=True) == ("로그인은 하지 말고 국민연금 열어줘", "")


async def test_an_oversized_native_fragment_cannot_turn_into_a_short_approval():
    transcript = Transcript()
    transcript.add(delta("응" + " " * 499 + "지우지 마세요", 100, 300), "visible-card")
    assert transcript.read(310, consume=True)[0] == ""


async def test_an_evicted_transcript_prefix_cannot_turn_into_a_short_approval():
    transcript = Transcript()
    transcript.add(delta("지우지 마세요", 0, 1), "visible-card")
    for index in range(1, 400):
        transcript.add(delta(" ", index, index + 1), "visible-card")
    transcript.add(delta("응", 400, 401), "visible-card")
    assert transcript.read(410, consume=True)[0] == ""
    transcript.add(delta("응", 9000, 9500), "visible-card")
    assert transcript.read(9510, consume=True)[0] == "응"


async def test_live_vault_consent_uses_the_card_known_at_connection_start(new_session):
    session = await new_session()
    request = await session.handle_turn("내 이름은 박하늘이라고 저장해줘")
    approval_id = request["pendingConfirmation"]["actionId"]

    async def reply(action):
        sideband = Sideband()
        socket = SimpleNamespace(send_json=AsyncMock(), receive=asyncio.Event().wait)
        monitor = asyncio.create_task(VoiceEdge()._monitor(sideband, socket, session, lambda: None, action))
        try:
            await sideband.incoming.put(delta("응", 100, 500))
            await sideband.incoming.put(delegation("vault-reply", 510))
            await until(lambda: socket.send_json.await_count)
            return socket.send_json.await_args.args[0]["result"]
        finally:
            await stop_monitor(monitor)

    stale = await reply("earlier-card")
    assert stale["pendingConfirmation"]["actionId"] == approval_id
    assert session._personal.vault() == {}
    accepted = await reply(approval_id)
    assert not accepted.get("pendingConfirmation")
    assert session._personal.vault() == {"name": "박하늘"}


async def test_live_link_reply_belongs_to_the_offer_heard_before_speaking(new_session):
    session = await new_session()
    sb = Sideband()
    socket = SimpleNamespace(send_json=AsyncMock(), receive=asyncio.Event().wait)
    monitor = asyncio.create_task(VoiceEdge()._monitor(sb, socket, session, lambda: None, ""))
    open_site = session.web.open_site
    started, release = asyncio.Event(), asyncio.Event()

    async def slow_open(url, ctx):
        started.set()
        await release.wait()
        return await open_site(url, ctx)

    session.web.open_site = slow_open
    try:
        await sb.incoming.put(delta("하이코리아 홈페이지 열어줘", 100, 800))
        await sb.incoming.put(delegation("search", 810))
        await asyncio.wait_for(started.wait(), 5)
        await sb.incoming.put(delta("네", 6000, 6100))
        await sb.incoming.put(delegation("early", 6110))
        await until(lambda: appended(sb, "thinking", "early"))
        release.set()
        await until(lambda: socket.send_json.await_count >= 2)
        first, early = [call.args[0]["result"] for call in socket.send_json.await_args_list[:2]]
        assert session.web.adapter.page.url == first["observation"]["url"]
        assert early["actions"] == []
        await sb.incoming.put(delta("첫 번째 결과 열어줘", 12000, 12400))
        await sb.incoming.put(delegation("pick", 12420))
        await until(lambda: socket.send_json.await_count >= 3)
        assert "/external2.html?" in session.web.adapter.page.url
    finally:
        await stop_monitor(monitor)


async def until(predicate, timeout=5):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.02)


def appended(sb, kind, delegate):
    return [e["content"] for e in sb.sent if e["type"] == f"session.{kind}.append" and e["delegation_id"] == delegate]


def start_monitor(turn, progress=None, *, link_offer_id=None):
    sb = Sideband()
    session = SimpleNamespace(handle_turn=turn, lang="ko", progress=progress or Progress(), link_offer_id=link_offer_id)
    websocket = SimpleNamespace(send_json=AsyncMock(), receive=asyncio.Event().wait)
    return sb, asyncio.create_task(VoiceEdge()._monitor(sb, websocket, session, lambda: None, ""))


async def stop_monitor(monitor):
    monitor.cancel()
    await asyncio.gather(monitor, return_exceptions=True)


@pytest.fixture
async def advance_voice_time(monkeypatch):
    loop = asyncio.get_running_loop()
    now = loop.time()
    monkeypatch.setattr(loop, "time", lambda: now)

    async def advance(seconds):
        nonlocal now
        end = now + seconds
        while now < end:
            now = min(now + 0.1, end)
            await asyncio.sleep(0)
            await asyncio.sleep(0)

    return advance


@pytest.mark.parametrize(("suffix", "duplicate", "acknowledgment", "delayed_delegation"), [
    pytest.param(" 그거 열어 주세요", False, (), False, id="open"),
    pytest.param(" 아니요, 열지 마세요", False, (), False, id="cancel"),
    pytest.param(" 그거 열어 주세요", True, (), False, id="duplicate"),
    pytest.param(" 그거 열어 주세요", False, ("네",), False, id="open-with-ack"),
    pytest.param(" 아니요, 열지 마세요", False, ("네",), False, id="cancel-with-ack"),
    pytest.param(" 아니요, 열지 마세요", False, ("네,", " 알겠", "습니다."), False, id="cancel-with-korean-ack"),
    pytest.param(" 아니요, 열지 마세요", False, ("O", "kay."), False, id="cancel-with-split-ack"),
    pytest.param(" 아니요, 열지 마세요", False, ("네",), True, id="cancel-with-preloaded-ack"),
])
async def test_live_link_reply_waits_through_a_spoken_pause(
    advance_voice_time, suffix, duplicate, acknowledgment, delayed_delegation
):
    turn = AsyncMock(return_value={"state": "BROWSING", "speech": "네"})
    sb, monitor = start_monitor(turn, link_offer_id="link-offer")
    prefix = "네, 화면에 있는 첫 번째 링크가 맞아요"
    try:
        sb.incoming.put_nowait(delta(prefix, 24400, 27600))
        if not delayed_delegation:
            sb.incoming.put_nowait(delegation("pick", 27400))
        await advance_voice_time(0.4)
        for index, word in enumerate(acknowledgment):
            start = 27800 + index * 100
            sb.incoming.put_nowait(delta(word, start, start + 100, kind="output"))
        await advance_voice_time(0.7)
        sb.incoming.put_nowait(delta(suffix, 28400, 29600))
        if delayed_delegation:
            sb.incoming.put_nowait(delegation("pick", 27400))
        if duplicate:
            sb.incoming.put_nowait(delegation("pick", 27400))
            sb.incoming.put_nowait(delegation("pick-again", 29600))
        await advance_voice_time(7)
        turn.assert_awaited_once_with(prefix + suffix, approval_id="", from_voice=True, link_offer_id="link-offer")
        if duplicate:
            assert appended(sb, "thinking", "pick") == [""]
            assert appended(sb, "thinking", "pick-again") == ["", voice_edge.ABSORBED]
    finally:
        await stop_monitor(monitor)


@pytest.mark.parametrize("offset", [27900, 28050])
async def test_delayed_link_delegation_keeps_the_refusal_across_an_ack(advance_voice_time, offset):
    turn = AsyncMock(return_value={"state": "BROWSING", "speech": "확인했어요."})
    sb, monitor = start_monitor(turn, link_offer_id="link-offer")
    prefix, refusal = "네, 첫 번째 링크가 맞아요", " 열지 마세요"
    try:
        sb.incoming.put_nowait(delta(prefix, 24400, 27600))
        sb.incoming.put_nowait(delegation("pick", offset))
        await advance_voice_time(0.6)
        sb.incoming.put_nowait(delta("네", 27800, 28000, kind="output"))
        await advance_voice_time(0.5)
        sb.incoming.put_nowait(delta(refusal, 28400, 29600))
        await advance_voice_time(4)
        turn.assert_awaited_once_with(prefix + refusal, approval_id="", from_voice=True, link_offer_id="link-offer")
    finally:
        await stop_monitor(monitor)


async def test_ambiguous_live_output_cannot_authorize_the_prefix_of_a_link_reply(advance_voice_time):
    turn = AsyncMock(return_value={"state": "BROWSING", "speech": "네"})
    sb, monitor = start_monitor(turn, link_offer_id="link-offer")
    try:
        sb.incoming.put_nowait(delta("네, 첫 번째 링크가 맞아요", 24400, 27600))
        sb.incoming.put_nowait(delegation("pick", 27400))
        await advance_voice_time(0.4)
        sb.incoming.put_nowait(delta("물론이죠.", 27800, 28000, kind="output"))
        await advance_voice_time(0.7)
        sb.incoming.put_nowait(delta(" 아니요, 열지 마세요", 28400, 29600))
        await advance_voice_time(4)
        turn.assert_not_awaited()
        assert appended(sb, "commentary", "pick") == [voice_edge.MISSED]
    finally:
        await stop_monitor(monitor)


async def test_link_delegation_does_not_reach_back_across_prior_live_output(advance_voice_time):
    turn = AsyncMock(return_value={"state": "BROWSING", "speech": "네"})
    sb, monitor = start_monitor(turn, link_offer_id="link-offer")
    try:
        sb.incoming.put_nowait(delta("두 번째 링크 열어 주세요", 24400, 27600))
        sb.incoming.put_nowait(delta("네", 27800, 28000, kind="output"))
        sb.incoming.put_nowait(delta("첫 번째 링크 열어 주세요", 28400, 29600))
        sb.incoming.put_nowait(delegation("pick", 29500))
        await advance_voice_time(3.5)
        turn.assert_awaited_once_with("첫 번째 링크 열어 주세요", approval_id="", from_voice=True, link_offer_id="link-offer")
    finally:
        await stop_monitor(monitor)


@pytest.mark.parametrize("delivered_response", [False, True])
async def test_live_link_reply_keeps_the_first_offer_until_a_new_turn(advance_voice_time, delivered_response):
    release = asyncio.Event()
    prior = "현재 화면 읽어줘"

    async def answer(text, **_context):
        if text == prior:
            await release.wait()
            session.link_offer_id = "replacement-offer"
        return {"state": "BROWSING", "speech": "네"}

    turn = AsyncMock(side_effect=answer)
    session = SimpleNamespace(handle_turn=turn, lang="ko", progress=Progress(), link_offer_id="earlier-offer")
    sb = Sideband()
    socket = SimpleNamespace(send_json=AsyncMock(), receive=asyncio.Event().wait)
    monitor = asyncio.create_task(VoiceEdge()._monitor(sb, socket, session, lambda: None, ""))
    try:
        sb.incoming.put_nowait(delta(prior, 100, 800))
        sb.incoming.put_nowait(delegation("read", 810))
        await advance_voice_time(3.5)
        sb.incoming.put_nowait(delta("네, 첫 번째 링크가 맞아요", 5000, 5700))
        sb.incoming.put_nowait(delegation("old-reply", 5710))
        await advance_voice_time(0.3)
        release.set()
        await advance_voice_time(0.8)
        assert appended(sb, "commentary", "read") == ["네"]
        if delivered_response:
            sb.incoming.put_nowait(delta("네", 6000, 6200, kind="output"))
        sb.incoming.put_nowait(delta(" 그거 열어 주세요", 6500, 6800))
        if delivered_response:
            sb.incoming.put_nowait(delegation("next-reply", 6780))
        await advance_voice_time(3.5)
        sb.incoming.put_nowait(delta("두 번째 링크 열어줘", 11000, 11400))
        sb.incoming.put_nowait(delegation("new-reply", 11410))
        await advance_voice_time(3.5)
        expected = [call(prior, approval_id="", from_voice=True, link_offer_id="earlier-offer")]
        if delivered_response:
            expected.extend([
                call("네, 첫 번째 링크가 맞아요", approval_id="", from_voice=True, link_offer_id="earlier-offer"),
                call("그거 열어 주세요", approval_id="", from_voice=True, link_offer_id="replacement-offer"),
            ])
        else:
            expected.append(call("네, 첫 번째 링크가 맞아요 그거 열어 주세요", approval_id="", from_voice=True,
                                 link_offer_id="earlier-offer"))
        expected.append(call("두 번째 링크 열어줘", approval_id="", from_voice=True, link_offer_id="replacement-offer"))
        assert turn.await_args_list == expected
    finally:
        release.set()
        await stop_monitor(monitor)


async def test_live_link_reply_times_out_before_dispatching_unsettled_text(advance_voice_time, monkeypatch):
    monkeypatch.setattr(voice_edge, "WAIT_WHILE_TALKING_S", 2)
    turn = AsyncMock(return_value={"state": "BROWSING", "speech": "네"})
    sb, monitor = start_monitor(turn, link_offer_id="link-offer")
    try:
        sb.incoming.put_nowait(delta("네, 첫 번째 링크가 맞아요", 100, 1800))
        sb.incoming.put_nowait(delegation("pick", 1810))
        await advance_voice_time(2.6)
        turn.assert_not_awaited()
        assert appended(sb, "commentary", "pick") == [voice_edge.MISSED]
    finally:
        await stop_monitor(monitor)


async def test_live_link_timeout_does_not_authorize_a_late_suffix(advance_voice_time, monkeypatch):
    monkeypatch.setattr(voice_edge, "WAIT_WHILE_TALKING_S", 2)
    turn = AsyncMock(return_value={"state": "BROWSING", "speech": "네"})
    sb, monitor = start_monitor(turn, link_offer_id="link-offer")
    try:
        sb.incoming.put_nowait(delta("아니요, 열지 마세요", 100, 1800))
        sb.incoming.put_nowait(delegation("pick", 1810))
        await advance_voice_time(2.6)
        assert appended(sb, "commentary", "pick") == [voice_edge.MISSED]
        monkeypatch.setattr(voice_edge, "WAIT_WHILE_TALKING_S", 10)
        sb.incoming.put_nowait(delta("네", 1900, 2050, kind="output"))
        sb.incoming.put_nowait(delta("그거 열어줘", 2300, 3200))
        sb.incoming.put_nowait(delegation("suffix", 3190))
        await advance_voice_time(3.5)
        sb.incoming.put_nowait(delta(" 그거 열어줘", 5000, 5200))
        sb.incoming.put_nowait(delegation("second-suffix", 5210))
        await advance_voice_time(3.5)
        turn.assert_not_awaited()
        for delegate in ("suffix", "second-suffix"):
            assert appended(sb, "commentary", delegate) == [voice_edge.MISSED]
        sb.incoming.put_nowait(delta("첫 번째 링크 열어줘", 9000, 9500))
        sb.incoming.put_nowait(delegation("new-pick", 9510))
        await advance_voice_time(3.5)
        turn.assert_awaited_once_with("첫 번째 링크 열어줘", approval_id="", from_voice=True, link_offer_id="link-offer")
    finally:
        await stop_monitor(monitor)


@pytest.mark.parametrize("text", ["지금 어디까지 했어", "멈춰"])
async def test_live_urgent_turn_stays_prompt_with_a_link_offer(advance_voice_time, text):
    state = "STOPPED" if text == "멈춰" else "BROWSING"
    turn = AsyncMock(return_value={"state": state, "speech": "네"})
    sb, monitor = start_monitor(turn, link_offer_id="link-offer")
    try:
        sb.incoming.put_nowait(delta(text, 100, 500))
        sb.incoming.put_nowait(delegation("urgent", 510))
        await advance_voice_time(1.1)
        turn.assert_awaited_once_with(text, approval_id="", from_voice=True)
    finally:
        await stop_monitor(monitor)


async def test_live_decisions_set_effort_only_for_the_matching_sol_turn(monkeypatch):
    monkeypatch.setattr(voice_edge, "EFFORT_WAIT_S", 0.1)
    requests = []
    difficulties = []
    sol = create_structured_llm(LlmConfig(provider="openai", model=STACK.agent, apiKey="dummy", reasoningEffort="medium"))
    utility = create_structured_llm(LlmConfig(provider="openai", model=STACK.utility, apiKey="dummy", reasoningEffort="none"))

    async def post(_url, _headers, body, *_args):
        requests.append((body["model"], body["reasoning_effort"]))
        return {"choices": [{"message": {"content": '{"text":"완료"}'}}]}

    monkeypatch.setattr("cheongeum.core.llm.post_json", post)

    async def turn(text, *, from_voice, approval_id, difficulty=None):
        difficulties.append(difficulty)
        for model in (sol, utility):
            await model.generate(system="Reply in text.", user=text, schemaName="text", schema=SIMPLE_TEXT_SCHEMA)
        return {"state": "BROWSING", "speech": "완료"}

    sb, monitor = start_monitor(turn)
    try:
        await sb.incoming.put(delta("이 앱에서 뭘 할 수 있어", 0, 500))
        await asyncio.sleep(0.1)
        assert requests == []

        for index, (rating, difficulty) in enumerate((
            ("high", "hard"), ("low", "easy"), ("medium", "medium"), ("invalid", None), ({"raw": "high"}, None), (None, None)
        ), 1):
            delegate = f"d{index}"
            start = index * 5000
            await sb.incoming.put(delta("정부24 열어줘", start, start + 500))
            await sb.incoming.put(delegation(delegate, start + 550, target="decisions"))
            if rating is not None:
                # A result for another delegation must not supply or replace this turn's rating.
                await sb.incoming.put({"type": "decision.event", "delegation_id": "unrelated", "event": {
                    "type": "decision.completed", "decision": {"answers": [{
                        "type": "choice", "name": "sol_effort", "choice": "high",
                    }]},
                }})
                await sb.incoming.put({"type": "decision.event", "delegation_id": delegate, "event": {
                    "type": "decision.completed", "decision": {"answers": [{
                        "type": "choice", "name": "sol_effort", "choice": rating,
                    }]},
                }})
            await until(lambda: appended(sb, "commentary", delegate))
            expected = rating if rating in ("high", "low", "medium") else "medium"
            assert requests[-2:] == [(STACK.agent, expected), (STACK.utility, "none")]
            assert difficulties[-1] == difficulty
    finally:
        await stop_monitor(monitor)

    await sol.generate(system="Reply in text.", user="정부24 열어줘", schemaName="text", schema=SIMPLE_TEXT_SCHEMA)
    assert requests[-1] == (STACK.agent, "medium")


async def test_progress_question_is_answered_while_a_task_runs():
    release = asyncio.Event()
    seen = []

    async def turn(text, *, from_voice, approval_id):
        seen.append(text)
        if "찾아줘" in text:
            await release.wait()
            return {"state": "BROWSING", "speech": "찾았어요."}
        return {"state": "BROWSING", "speech": "기초연금 페이지를 보고 있어요."}

    sb, monitor = start_monitor(turn)
    for event in (delta("복지로에서 기초연금 신청 방법 찾아줘", 0, 1500), delegation("d1", 1550)):
        await sb.incoming.put(event)
    await until(lambda: seen)
    for event in (delta("지금 어디까지 했어", 4000, 5000), delegation("d2", 5050)):
        await sb.incoming.put(event)
    await until(lambda: appended(sb, "commentary", "d2"))
    assert appended(sb, "commentary", "d2") == ["기초연금 페이지를 보고 있어요."]
    assert not appended(sb, "commentary", "d1")
    release.set()
    await until(lambda: appended(sb, "commentary", "d1"))
    assert appended(sb, "commentary", "d1") == ["찾았어요."]
    await stop_monitor(monitor)


async def test_long_task_speaks_each_new_progress_step_once(monkeypatch):
    monkeypatch.setattr(voice_edge, "PROGRESS_GAP_S", 0.3)
    progress = Progress()
    release = asyncio.Event()

    async def turn(text, *, from_voice, approval_id):
        progress.start()
        progress.add("복지로를 열었어요.")
        await release.wait()
        progress.finish()
        return {"state": "BROWSING", "speech": "찾았어요."}

    sb, monitor = start_monitor(turn, progress)
    for event in (delta("복지로에서 기초연금 찾아줘", 0, 1000), delegation("d1", 1050)):
        await sb.incoming.put(event)
    await until(lambda: appended(sb, "commentary", "d1"))
    progress.add("'신청 방법'을 눌렀어요.")
    await until(lambda: len(appended(sb, "commentary", "d1")) == 2)
    await asyncio.sleep(0.8)
    release.set()
    await until(lambda: len(appended(sb, "commentary", "d1")) == 3)
    assert appended(sb, "commentary", "d1") == ["복지로를 열었어요.", "'신청 방법'을 눌렀어요.", "찾았어요."]
    await stop_monitor(monitor)


async def test_reviewed_turn_holds_automatic_progress_and_speaks_the_reviewed_result(advance_voice_time):
    progress = Progress()
    entered, release = asyncio.Event(), asyncio.Event()

    async def turn(text, **kwargs):
        if text == "지금 어디까지 했어":
            return {"state": "BROWSING", "speech": progress.latest}
        with progress.review():
            progress.start()
            progress.add("신청 방법 페이지를 열었어요.")
            entered.set()
            await release.wait()
            progress.finish()
        return {"state": "BROWSING", "semanticAction": "review-before-output",
                "speech": "방문 신청은 확인했지만 온라인 신청 방법은 확인하지 못했어요."}

    sb = Sideband()
    socket = SimpleNamespace(send_json=AsyncMock(), receive=asyncio.Event().wait)
    session = SimpleNamespace(handle_turn=turn, lang="ko", progress=progress)
    monitor = asyncio.create_task(VoiceEdge()._monitor(sb, socket, session, lambda: None, ""))
    try:
        sb.incoming.put_nowait(delta("신청 방법을 모두 찾아줘", 10, 600))
        sb.incoming.put_nowait(delegation("review", 630))
        await advance_voice_time(2)
        assert entered.is_set()
        await advance_voice_time(17)
        assert not appended(sb, "commentary", "review")
        sb.incoming.put_nowait(delta("지금 어디까지 했어", 20000, 20500))
        sb.incoming.put_nowait(delegation("status", 20550))
        await advance_voice_time(2)
        assert appended(sb, "commentary", "status") == ["신청 방법 페이지를 열었어요."]
        release.set()
        await advance_voice_time(1)
        assert not appended(sb, "commentary", "review")
        packet = socket.send_json.await_args.args[0]
        assert packet["exact"] and packet["result"]["speech"] == "방문 신청은 확인했지만 온라인 신청 방법은 확인하지 못했어요."
        assert "application is reading" in appended(sb, "thinking", "review")[-1]
        assert progress.snapshot()["spoken"]
    finally:
        release.set()
        await stop_monitor(monitor)


async def test_a_user_who_keeps_talking_is_heard_in_full(monkeypatch):
    monkeypatch.setattr(voice_edge, "WAIT_FOR_TEXT_S", 1)
    seen = []

    async def turn(text, *, from_voice, approval_id):
        seen.append(text)
        return {"state": "BROWSING", "speech": "네"}

    sb, monitor = start_monitor(turn)
    for event in (delta("기초연금 신청하려면", 0, 800), delegation("d1", 850)):
        await sb.incoming.put(event)
    for i in range(7):
        await asyncio.sleep(0.5)
        await sb.incoming.put(delta(f" 말{i}", 1000 + i * 500, 1400 + i * 500))
    await sb.incoming.put(delegation("d2", 4500))
    await until(lambda: appended(sb, "thinking", "d2")[1:], timeout=8)
    assert seen == ["기초연금 신청하려면 말0 말1 말2 말3 말4 말5 말6"]
    assert appended(sb, "commentary", "d1") == ["네"]
    assert not appended(sb, "commentary", "d2")
    await stop_monitor(monitor)


async def test_stop_right_after_unanswered_speech_still_stops():
    seen = []

    async def turn(text, *, from_voice, approval_id):
        seen.append(text)
        return {"state": "STOPPED", "speech": "멈췄어요."}

    sb, monitor = start_monitor(turn)
    await sb.incoming.put(delta("다음 페이지", 0, 800))
    await sb.incoming.put(delta("멈춰", 2300, 2600))
    await asyncio.wait_for(monitor, 3)
    assert seen == ["멈춰"]


async def test_missing_words_ask_the_user_to_say_it_again(monkeypatch):
    monkeypatch.setattr(voice_edge, "WAIT_FOR_TEXT_S", 0.3)
    sb, monitor = start_monitor(AsyncMock())
    await sb.incoming.put(delegation("d1", 5000))
    await until(lambda: appended(sb, "commentary", "d1"))
    [reply] = appended(sb, "commentary", "d1")
    assert "again" in reply and "service" not in reply
    await stop_monitor(monitor)


async def test_requests_beyond_the_waiting_limit_are_answered_busy(monkeypatch):
    monkeypatch.setattr(voice_edge, "MAX_WAITING_TURNS", 1)
    release = asyncio.Event()
    seen = []

    async def turn(text, *, from_voice, approval_id):
        seen.append(text)
        await release.wait()
        return {"state": "BROWSING", "speech": text}

    sb, monitor = start_monitor(turn)
    for i, words in enumerate(("정부24 열어줘", "다음 페이지", "뒤로 가")):
        await sb.incoming.put(delta(words, i * 3000, i * 3000 + 800))
        await sb.incoming.put(delegation(f"d{i}", i * 3000 + 850))
        await asyncio.sleep(1)
    await until(lambda: appended(sb, "commentary", "d2"))
    assert not monitor.done()
    assert "still working" in appended(sb, "commentary", "d2")[0]
    release.set()
    await until(lambda: len(seen) == 2)
    assert seen == ["정부24 열어줘", "다음 페이지"]
    await stop_monitor(monitor)


def test_conversation_route_owns_sdp_consent_writer_and_auth_handoff(monkeypatch):
    provider = AsyncMock(return_value=("live_1", "answer-test"))
    monkeypatch.setattr(LiveProvider, "offer", provider)
    sb = Sideband()
    @asynccontextmanager
    async def attach(self, live_id):
        assert live_id == "live_1"
        yield sb
    monkeypatch.setattr(LiveProvider, "attach", attach)
    stt, tts = create_voice_providers(VoiceConfig(apiKey="dummy"))
    app, sessions = create_app(SimpleNamespace(stt=stt, tts=tts))
    session = SimpleNamespace(id="test", state="IDLE", lang="en", consent_status="pending",
                              dialogue=SimpleNamespace(auth_waiting=False, confirmation=None), generation=0)
    sessions.add(session)
    headers = {"host": "localhost", "origin": "http://localhost"}
    with TestClient(app, base_url="http://localhost") as client:
        lease = client.portal.call(sessions.enable, "test")
        def offer(writer):
            with client.websocket_connect("/api/session/test/audio/conversation", headers=headers) as ws:
                ws.send_json({"sdp": "v=0", "writer": writer})
                return ws.receive_json()
        assert offer(lease.writer)["error"] == "REQUEST_CONFLICT"
        session.consent_status = "granted"
        assert offer("wrong-writer")["error"] == "REQUEST_CONFLICT"
        session.dialogue.auth_waiting = True
        assert offer(lease.writer)["error"] == "REQUEST_CONFLICT"
        provider.assert_not_awaited()
        session.dialogue.auth_waiting = False
        assert offer(lease.writer) == {"sdp": "answer-test"}
        assert provider.await_count == 1
    assert sb.sent[-1]["type"] == "session.close"
