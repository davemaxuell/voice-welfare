"""WebRTC media belongs to GPT-Live. Only authenticated sideband events can start local work."""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from collections import deque
from dataclasses import dataclass
from urllib.parse import quote

import httpx
from fastapi import WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from websockets.asyncio.client import connect

from cheongeum.core.llm import REASONING_EFFORT_OVERRIDE
from cheongeum.core.model_stack import STACK
from cheongeum.server.recovery import RequestConflict
from cheongeum.server.request_policy import TURN_TEXT_LIMIT, origin_refusal
from cheongeum.understanding.rules import is_progress_question, is_stop_utterance
from cheongeum.voice.errors import VoiceProviderError

log = logging.getLogger(__name__)

# 링크 답변은 GPT Live의 짧은 맞장구가 있어도 이 간격까지 한 발화로 본다.
PAUSE_SPLIT_MS = 3000
# "다음 페이지 멈춰"는 멈춤이 아니다. 멈춤 확인은 "멈춰"만 떼어 내는 짧은 간격을 쓴다.
STOP_SPLIT_MS = 1200
WAIT_FOR_TEXT_S = 3
WAIT_WHILE_TALKING_S = 10
QUIET_S = 0.7
# 이미 쓴 말 바로 뒤에 온 넘김은 그 말을 한 번 더 넘긴 것이다.
ABSORBED_MS = 1200
# 화면의 progressVoice와 같은 간격: 처음 15초는 말하지 않고, 그 뒤로 15초에 한 단계까지.
PROGRESS_GAP_S = 15
MAX_WAITING_TURNS = 12
EFFORT_WAIT_S = 1.0
EFFORT_QUESTION = "sol_effort"
TASK_DIFFICULTY = {"low": "easy", "medium": "medium", "high": "hard"}
MISSED = "Sorry, I didn't catch that. Could you say it again?"
BUSY = "I'm still working on your earlier requests. Please wait for those answers first."
ABSORBED = "This speech was handled together with the previous request."
LIVE_ACKS = {"네", "예", "알겠습니다", "네알겠습니다", "예알겠습니다", "yes", "ok", "okay", "好的", "はい"}
ACK_PUNCTUATION = str.maketrans("", "", ".,，。!！")


def _effort_choice(event: dict) -> str | None:
    decision = event.get("decision")
    answers = decision.get("answers") if isinstance(decision, dict) else None
    if not isinstance(answers, list):
        return None
    for answer in answers:
        if isinstance(answer, dict) and answer.get("type") == "choice" and answer.get("name") == EFFORT_QUESTION:
            effort = answer.get("choice")
            return effort if isinstance(effort, str) and effort in TASK_DIFFICULTY else None
    return None


class LiveProvider:
    def __init__(self, stt):
        self.url = stt.base_url.rstrip("/") + "/live/sessions"
        self.headers = {"Authorization": f"Bearer {stt.api_key}"}
        self.model = stt.edge_model

    async def offer(self, sdp, session, speed):
        config = {
            "model": self.model,
            "delegation": {
                "type": "decisions",
                "decisions": {
                    "model": STACK.utility,
                    "questions": [{
                        "type": "choice",
                        "name": EFFORT_QUESTION,
                        "instructions": (
                            "Rate the work needed to fulfill the latest delegated request. "
                            "Use earlier dialogue to resolve references and apply the user's current constraints. "
                            "Choose low for a simple action or a straightforward lookup. "
                            "Choose medium for bounded work with dependent steps, options to compare, or conditions to apply. "
                            "Choose high for many dependent navigation or data entry steps, open-ended investigation, substantial synthesis across sources, "
                            "or constraints that are hard to reconcile. Spoken length and the need for approval "
                            "do not determine effort. The application handles actions and permission."
                        ),
                        "choices": [{"value": effort} for effort in TASK_DIFFICULTY],
                    }],
                },
            },
            "store": False,
            "instructions": (
                "Role and app capabilities\n"
                f"You are Cheongeum (청음), the AI voice assistant in the Cheongeum desktop app, powered by OpenAI's {self.model}. "
                "Help people in Korea find and use public services with guidance they can follow by listening. "
                "Cheongeum can open and navigate websites, read pages aloud, look up public services and welfare benefits, "
                "and guide users through online forms and practice applications. It accepts speech and typing "
                "and supports Korean, English, Chinese, and Japanese. "
                "The app asks for confirmation before actions that require approval. "
                "Users handle sign-in, identity verification, and final submission on official sites. "
                "Never ask for or repeat passwords or identity numbers in the voice conversation.\n\n"
                "Voice and language\n"
                f"Start quietly and let the user finish speaking. Use the app's selected reply language ({session.lang}) "
                "until the app changes it. Keep official Korean names when the speaker mixes languages. "
                f"Speak clearly and briskly, about {speed:g} times normal speed. "
                "Use short, natural sentences and plain words. In Korean, use polite conversational speech. "
                "Name the item you mean so the user can follow without seeing the screen. "
                f"The application state at the start of this call is {session.state}.\n\n"
                "Decide how to respond\n"
                "Delegate whenever any part of the request needs an app action, a progress check, a current or "
                "user-specific fact, or official verification. Official dates, schedules, eligibility, and public-service "
                "requirements need verification even when they sound familiar. Delegate website navigation, page contents "
                "and item positions, documents and profiles, permissions, app controls, reply language changes, "
                "and the full startup guide when requested. Delegate follow-ups about the app's last action and "
                "replies to its questions or proposals, including confirmation, refusal, selection, and correction. "
                "Otherwise, answer ordinary questions and general questions about the app directly when you know "
                "the answer. Respond naturally to social conversation. If unsure of an answer, delegate when the app "
                "can check. If it cannot, say what you are unsure about. "
                "Ask one short, specific question if the speech is too unclear to identify a request. "
                "Delegate an identifiable app request with an ambiguous target so the app can resolve it.\n\n"
                "Hand off the current turn\n"
                "Make a fresh routing decision on each user turn. When the turn needs the app, generate <|SpawnThinking|> "
                "once the user finishes that turn. If the speaker is still identifying or correcting a target, listen "
                "through the end of the selection. Confirming an offered item needs a new handoff even when the app "
                "handled the preceding request. A site name or a result's position is enough for the app to start. "
                "Keep the current actions, targets, conditions, exclusions, and corrections together. Use earlier dialogue to resolve references and "
                "carry forward relevant constraints. Follow the user's latest correction. "
                "Only the app decides whether the current reply authorizes a pending action. "
                "Earlier dialogue and session state confer no permission. "
                "An information lookup can be answered in conversation. Preserve requests to show or open a site, "
                "and distinguish immediate lookups from research the user wants saved for later.\n\n"
                "Speak during delegated work\n"
                "During a multi-step task, listen quietly until the app sends its reviewed result or needs user input. "
                "Relay each app commentary message once. Use only what the app has confirmed for that request. "
                "Describe progress as the latest confirmed step. Finding a result or link does not establish that "
                "the site or requested page opened. Report arrival and completion only when the app confirms them. "
                "Keep relevant names, dates, numbers, conditions, and caveats when relaying an answer. "
                "If the app asks a question, relay it with the named site, link, and choices it supplies. "
                "When the app indicates it is reading its own response, stay silent and wait for the user. "
                "Delegate the user's next reply if it refers to that response."
            ),
        }
        if history := session.recent_voice_dialogue():
            config["input"] = [
                {"type": "message", "role": message["role"], "content": [{
                    "type": "input_text" if message["role"] == "user" else "output_text",
                    "text": message["text"],
                }]}
                for message in history
            ]
        async with httpx.AsyncClient(timeout=15) as client:
            payload = {"session": config, "transport": {"type": "webrtc", "sdp": sdp}}
            result = await client.post(self.url, headers=self.headers, json=payload)
            if result.status_code in (400, 403):
                # Some projects cannot use native Decisions. Keep voice available on a rejected offer.
                log.info("Live Decisions offer rejected (%s). Retrying with client delegation.", result.status_code)
                fallback = {**payload, "session": {**config, "delegation": {"type": "client"}}}
                result = await client.post(self.url, headers=self.headers, json=fallback)
        if not result.is_success:
            raise VoiceProviderError(result.status_code)
        body = result.json()
        return body["session"]["id"], body["transport"]["sdp"]

    def attach(self, live_id):
        url = self.url.replace("https://", "wss://", 1) + "/" + quote(live_id, safe="") + "/attach"
        return connect(url, additional_headers=self.headers, open_timeout=10, close_timeout=1)


@dataclass
class Fragment:
    start: int
    end: int
    text: str
    approval: str
    link_offer: str | None
    received_at: float
    delivered_turn: int


@dataclass
class OutputFragment:
    start: int
    end: int
    ack_part: str | None
    delivered_turn: int


@dataclass
class SpeechMatch:
    first: Fragment
    end: int
    text: str
    received_at: float


class Transcript:
    """Match a delegation offset to one unconsumed stretch of user speech."""
    def __init__(self):
        self.fragments = deque(maxlen=400)
        self.dropped_through = -1
        self.through = -1
        self.output = deque(maxlen=80)
        self.delivered_turns = 0
        self.incomplete_link_end = -1
        self.updated = 0.0

    def add(self, event, approval, link_offer=None):
        start, end, delta = event.get("start_ms"), event.get("end_ms"), event.get("delta")
        if not isinstance(start, int) or not isinstance(end, int) or end < start or not isinstance(delta, str):
            return
        if end <= self.through or not delta:
            return
        if event["type"] == "session.output_transcript.delta":
            key = "".join(delta.casefold().split()).translate(ACK_PUNCTUATION)
            part = key if any(key in ack for ack in LIVE_ACKS) else None
            self.output.append(OutputFragment(start, end, part, self.delivered_turns))
            return
        if len(self.fragments) == self.fragments.maxlen:
            self.dropped_through = max(self.dropped_through, self.fragments[0].end)
        # Keep one character past the limit so the complete group is rejected if a suffix was omitted.
        self.updated = asyncio.get_running_loop().time()
        self.fragments.append(Fragment(start, end, delta[:TURN_TEXT_LIMIT + 1], approval, link_offer, self.updated,
                                       self.delivered_turns))

    def read(self, offset, *, consume=False, pause_ms=PAUSE_SPLIT_MS):
        match = self.match(offset, pause_ms=pause_ms)
        if match is None:
            return "", ""
        if consume:
            self.consume(match)
        return match.text, match.first.approval

    def consume(self, match: SpeechMatch, *, incomplete_link=False):
        self.through = match.end
        self.fragments = deque((f for f in self.fragments if f.end > self.through), maxlen=400)
        self.incomplete_link_end = match.end if incomplete_link else -1

    def match(self, offset, *, pause_ms=PAUSE_SPLIT_MS, bound_first: Fragment | None = None, delegated=False):
        # Deltas may lag delegation and arrive in uneven chunks. Do not attach a
        # later utterance to a delegation whose own transcript is missing.
        groups = []
        bound_group = None
        interrupted = False
        fragments = sorted(self.fragments, key=lambda f: (f.start, f.end))
        if delegated and self.incomplete_link_end >= 0:
            lost_end = max(self.incomplete_link_end, self.dropped_through)
            for index, fragment in enumerate(fragments):
                if fragment.start - lost_end > pause_ms:
                    fragments = fragments[index:]
                    break
                lost_end = max(lost_end, fragment.end)
            else:
                fragments = []
        for fragment in fragments:
            previous = groups[-1][-1] if groups else None
            split = previous is None or fragment.start - previous.end > pause_ms
            if not split:
                output = [o for o in self.output if previous.end <= o.end < fragment.start]
                if output and bound_first is not None and groups[-1] is bound_group and all(
                    o.delivered_turn == bound_first.delivered_turn for o in output
                ):
                    parts = [o.ack_part for o in sorted(output, key=lambda o: (o.start, o.end))]
                    acknowledgment = None not in parts and "".join(p for p in parts if p is not None) in LIVE_ACKS
                    interrupted |= (not acknowledgment or any(o.start < previous.end for o in output)
                                    or any(o.start < fragment.start <= o.end for o in self.output))
                else:
                    split = bool(output)
            if split:
                groups.append([])
            groups[-1].append(fragment)
            if fragment is bound_first:
                bound_group = groups[-1]
        match = bound_group if bound_first is not None else next((
            group for group in reversed(groups) if group[0].start <= offset + 200 and group[-1].end >= offset - 3500
            and not any(offset <= o.end < group[0].start for o in self.output)
        ), None)
        if not match:
            return None
        if offset - match[-1].end > 800 and any(match[-1].end < o.end < offset for o in self.output):
            return None
        start = match[0].start
        missing_prefix = (self.dropped_through >= 0 and start <= self.dropped_through + pause_ms
                          and not any(self.dropped_through <= o.end < start for o in self.output))
        text = "".join(f.text for f in match)
        # Partial/truncated text is never used to authorize an action.
        if interrupted or missing_prefix or len(text) > TURN_TEXT_LIMIT:
            text = ""
        first = bound_first if bound_first is not None else match[0]
        return SpeechMatch(first, max(f.end for f in match), text.strip(), max(f.received_at for f in match))


class VoiceEdge:
    def __init__(self, provider=LiveProvider):
        self.provider = provider
        self.active = set()
        self.work = set()

    async def _turn(self, session, text, action, current, *, effort: str | None = None, link_offer: str | None = None):
        # Once handed off, a task belongs to the orchestrator even if audio disconnects.
        async def dispatch():
            current()
            token = REASONING_EFFORT_OVERRIDE.set((STACK.agent, effort) if effort else None)
            try:
                context = {"link_offer_id": link_offer} if link_offer is not None else {}
                if effort in TASK_DIFFICULTY:
                    context["difficulty"] = TASK_DIFFICULTY[effort]
                return await session.handle_turn(text, approval_id=action, from_voice=True, **context)
            finally:
                REASONING_EFFORT_OVERRIDE.reset(token)
        task = asyncio.create_task(dispatch())
        self.work.add(task)
        def finished(done):
            self.work.discard(done)
            if not done.cancelled():
                done.exception()
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    def register(self, app, audio, sessions, access_writer, voice_error, port):
        @app.websocket("/api/session/{sid}/audio/conversation")
        async def conversation(socket: WebSocket, sid: str):
            scheme = "https" if socket.url.scheme == "wss" else "http"
            if origin_refusal(socket.headers, scheme, port, required=True):
                return await socket.close(code=1008)
            await socket.accept()
            owned = False
            try:
                async with asyncio.timeout(15):
                    raw = await socket.receive_text()
                if len(raw) > 65536:
                    raise RequestConflict
                hello = json.loads(raw)
                writer, sdp = hello["writer"], hello["sdp"]
                if not isinstance(writer, str) or len(writer) > 128 or not isinstance(sdp, str) or not sdp.startswith("v=0"):
                    raise RequestConflict
                session = access_writer(sid, writer)
                stt = audio.stt
                if isinstance(session, Response) or not getattr(stt, "edge_model", None) or sid in self.active:
                    raise RequestConflict
                ledger, generation = sessions.ledgers[sid], session.generation
                def current():
                    lease = sessions.leases.get(sid)
                    if (sessions.ledgers.get(sid) is not ledger or session.generation != generation
                            or session.consent_status != "granted" or session.dialogue.auth_waiting
                            or stt is not audio.stt or (lease and (lease.waiting or lease.writer != writer))):
                        raise RequestConflict
                current()
                self.active.add(sid)
                owned = True
                # Bind speech to the decision presented before this microphone
                # opened. Delayed transcript packets must never approve a new card.
                action = (session.dialogue.confirmation or {}).get("actionId", "")
                if hello.get("approvalId", "") != action:
                    action = ""
                provider = self.provider(stt)
                live_id, answer = await provider.offer(sdp, session, getattr(audio.tts, "speed", 1.35))
                async with provider.attach(live_id) as upstream:
                    try:
                        current()
                        await socket.send_json({"sdp": answer})
                        await self._monitor(upstream, socket, session, current, action)
                    finally:
                        try:
                            await upstream.send(json.dumps({"type": "session.close", "event_id": secrets.token_hex(12)}))
                        except Exception:
                            pass
            except (WebSocketDisconnect, asyncio.CancelledError):
                pass
            except Exception as exc:
                try:
                    await socket.send_json(json.loads(voice_error(exc).body))
                except (WebSocketDisconnect, RuntimeError):
                    pass
            finally:
                if owned:
                    self.active.discard(sid)
                try:
                    await socket.close()
                except (WebSocketDisconnect, RuntimeError):
                    pass

    async def _monitor(self, upstream, socket, session, current, action):
        transcript = Transcript()
        clock = asyncio.get_running_loop()
        jobs = asyncio.Queue()
        turns = asyncio.Queue(maxsize=MAX_WAITING_TURNS)
        delegations = set()
        pending_efforts: dict[str, asyncio.Future[str | None]] = {}
        event_ids = deque(maxlen=512)
        reply_language = session.lang
        delivered_links = getattr(session, "link_offer_id", None)
        async def append(kind, delegate, content):
            await upstream.send(json.dumps({"type": f"session.{kind}.append", "event_id": secrets.token_hex(12),
                                            "delegation_id": delegate, "content": content}))

        async def deliver(delegate, result):
            nonlocal reply_language, delivered_links
            # Stop and sign-in handoff intentionally invalidate this Live session.
            if result["state"] in {"STOPPED", "AUTH_HANDOFF"}:
                await socket.send_json({"result": result, "exact": True})
                return True
            current()
            transcript.delivered_turns += 1
            language = result.get("lang", reply_language)
            if language in {"ko", "en", "zh", "ja"} and language != reply_language:
                await append("instructions", None, f"The application selected {language}. Use it for subsequent speech.")
                reply_language = language
            exact = (result.get("localSpeechOnly") or result.get("intentType") == "READ_START_GUIDE"
                     or result.get("semanticAction") == "review-before-output" or bool(result.get("pendingConfirmation"))
                     or len(result["speech"].encode("utf-8")) > 1100)
            await socket.send_json({"result": result, "exact": exact})
            if exact:
                await append("thinking", delegate, "The application is reading its response. Wait for the user.")
            else:
                await append("commentary", delegate, result["speech"])
            delivered_links = getattr(session, "link_offer_id", None)
            return False

        async def events():
            async for raw in upstream:
                current()
                event = json.loads(raw)
                kind, event_id = event.get("type"), event.get("event_id")
                if event_id and event_id in event_ids:
                    continue
                if event_id:
                    event_ids.append(event_id)
                if kind in {"session.input_transcript.delta", "session.output_transcript.delta"}:
                    transcript.add(event, action, delivered_links)
                elif kind == "session.delegation.created":
                    row = event["delegation"]
                    delegate = row["id"]
                    if row["target"] in ("client", "decisions") and delegate not in delegations:
                        if len(delegations) >= 512:
                            return
                        delegations.add(delegate)
                        rating = clock.create_future() if row["target"] == "decisions" else None
                        if rating is not None:
                            pending_efforts[delegate] = rating
                        jobs.put_nowait((delegate, event["offset_ms"], rating))  # 위의 넘김 512개가 한도
                        await append("thinking", delegate, "")
                elif kind == "decision.event":
                    delegate, decision = event.get("delegation_id"), event.get("event")
                    if isinstance(delegate, str) and isinstance(decision, dict) and decision.get("type") == "decision.completed":
                        rating = pending_efforts.pop(delegate, None)
                        if rating is not None and not rating.done():
                            rating.set_result(_effort_choice(decision))
                elif kind == "session.closed":
                    return
                elif kind == "error":
                    raise VoiceProviderError(502)

        async def resolver():
            # 넘김은 도착하는 대로 차례로 말에 맞춘다. 긴 턴이 도는 동안에도 멈춤과 진행 물음이 그 뒤에서 기다리지 않게.
            while True:
                delegate, offset, rating = await jobs.get()
                started = clock.time()
                bound_first = None
                while True:
                    match = transcript.match(offset, bound_first=bound_first, delegated=True)
                    if bound_first is None and match is not None and match.first.link_offer and match.text:
                        # Keep a delayed offset provisional in case its own transcript arrives.
                        # Check even a provisional match for a continuation after an acknowledgment.
                        first = match.first
                        if offset <= match.end + 200:
                            bound_first = first
                        match = transcript.match(offset, bound_first=first, delegated=True)
                    text = match.text if match is not None else ""
                    now = clock.time()
                    urgent = is_stop_utterance(text) or is_progress_question(text)
                    if match is not None and match.first.link_offer and not urgent:
                        quiet = now - match.received_at >= PAUSE_SPLIT_MS / 1000
                    else:
                        quiet = now - transcript.updated >= QUIET_S
                    if text and quiet and now >= started + 0.35:
                        break
                    if now >= started + (WAIT_WHILE_TALKING_S if text else WAIT_FOR_TEXT_S):
                        break
                    await asyncio.sleep(0.08)
                current()
                consumed = transcript.through
                if match is not None:
                    action, link_offer = match.first.approval, match.first.link_offer
                    transcript.consume(match, incomplete_link=bool(link_offer and (not text or not quiet)))
                if not text and consumed >= max(0, offset - ABSORBED_MS):
                    await append("thinking", delegate, ABSORBED)
                elif not text or not quiet:
                    await append("commentary", delegate, MISSED)
                elif urgent:
                    if await deliver(delegate, await self._turn(session, text, action, current)):
                        return
                elif turns.full():
                    await append("commentary", delegate, BUSY)
                else:
                    turns.put_nowait((delegate, text, action, link_offer, rating))
                    continue
                pending_efforts.pop(delegate, None)

        async def narrate(delegate, turn):
            seen, last = session.progress.snapshot()["seq"], clock.time()
            while not (await asyncio.wait({turn}, timeout=0.25))[0]:
                step, now = session.progress.snapshot(), clock.time()
                if (step["running"] and step["spoken"] and step["latest"] and step["seq"] > seen
                        and now - last >= PROGRESS_GAP_S and now - transcript.updated >= 1.5):
                    seen, last = step["seq"], now
                    await append("commentary", delegate, step["latest"])

        async def worker():
            while True:
                delegate, text, action, link_offer, rating = await turns.get()
                effort = None
                if rating is not None:
                    try:
                        effort = await asyncio.wait_for(rating, timeout=EFFORT_WAIT_S)
                    except TimeoutError:
                        pass
                    finally:
                        pending_efforts.pop(delegate, None)
                turn = asyncio.ensure_future(self._turn(session, text, action, current, effort=effort, link_offer=link_offer))
                try:
                    await narrate(delegate, turn)
                finally:
                    turn.cancel()
                if await deliver(delegate, turn.result()):
                    return

        async def guard():
            last_checked = 0.0
            while True:
                await asyncio.sleep(0.2)
                current()
                if (not transcript.fragments or transcript.updated == last_checked
                        or asyncio.get_running_loop().time() - transcript.updated < 0.4):
                    continue
                last_checked = transcript.updated
                offset = max(f.end for f in transcript.fragments)
                text, action = transcript.read(offset, pause_ms=STOP_SPLIT_MS)
                if text and is_stop_utterance(text):
                    transcript.read(offset, consume=True, pause_ms=STOP_SPLIT_MS)
                    result = await self._turn(session, text, action, current)
                    await socket.send_json({"result": result, "exact": True})
                    return

        # The browser can close the call. It has no channel for submitting
        # transcripts, delegation IDs or synthesized instructions to the worker.
        tasks = [asyncio.create_task(fn()) for fn in (events, resolver, worker, guard, socket.receive)]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
