"""
세션 단위 AI Orchestrator(공통 백엔드). 의도를 해석해 Agent A(웹 탐색·실행)와
Agent B(복지 정보·대화)에 일을 나누고, 공통 작업 상태(승인 대기, 되묻기, 중단)를 관리한다.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
import unicodedata
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable

from cheongeum.agents.web import ExecContext, FieldProfile, WebExecutionAgent, field_vocabulary
from cheongeum.agents.web.approval import recheck
from cheongeum.agents.web.skills.browse import BrowseSkill
from cheongeum.agents.web.skills.common import browse_state, help_human_draft, is_form_open, outcome_failure
from cheongeum.agents.web.skills.form import FormSkill
from cheongeum.agents.web.skills.guided import GuidedFill
from cheongeum.agents.welfare import PROFILE_QUESTIONS, WelfareInformationAgent, next_profile_slot, parse_profile_answer
from cheongeum.core.dialogue import DialogueState
from cheongeum.core.intents import HelpGroup, help_pages
from cheongeum.core.jsutil import AbortController, compact, now_iso, nz, rx, uuid
from cheongeum.core.llm import SIMPLE_TEXT_SCHEMA
from cheongeum.core.progress import Progress
from cheongeum.core.turn import AGENT_IDS, draft, parse_turn_result
from cheongeum.language.i18n import FIXED, detect_lang_switch, detect_script_lang, foreign_confirmation, translate_in, translate_out
from cheongeum.personal.commands import due_reminder, parse_personal_command
from cheongeum.personal.dialogue import PersonalDialogue
from cheongeum.personal.store import VAULT_LABELS, PersonalStore
from cheongeum.safety import REDACTED, SENSITIVE_LABELS_KO, SensitiveDetection, detect_sensitive, mask_value, redact_text, unsupported_numbers
from cheongeum.safety.gates import GateRefusal, consent_refusal, gate_refusal
from cheongeum.speech.phrasing import josa, speak_label
from cheongeum.speech.screen import Narrator
from cheongeum.understanding.chat import chat_route
from cheongeum.understanding.filters import is_question_like, short_reply_kind, split_questions, strip_address, strip_filler, vague_question
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider, clean_value, is_progress_question, is_stop_utterance
from cheongeum.understanding.sites import resolve_site
from cheongeum.understanding.understand import Understanding, Understood


@dataclass
class OrchestratorDeps:
    intent_provider: Any
    web: WebExecutionAgent
    welfare: WelfareInformationAgent
    events: Any = None
    # True면 시작 동의 전에는 화면을 읽거나 조작하지 않는다(서버 기본값).
    require_consent: bool = False
    # 의도 계획·자유 대화·쉬운 말 다시 설명(없으면 규칙 기반으로만 동작)
    llm: Any = None
    # 목표 수행(browse_step). 없으면 llm.
    goal_llm: Any = None
    # 검색 답·화면 요약. 없으면 llm.
    web_llm: Any = None
    # 웹 검색 주소 틀({q} 자리에 검색어). 기본 네이버. 테스트는 로컬 포털 검색을 쓴다.
    search_url_template: str | None = None
    # False면 실제 사이트 모드: 연습(모의) 사이트를 기본으로 쓰지 않는다("연습"이라고 할 때만). 기본 True.
    practice_mode: bool = True
    # 개인 정보 금고·신청 기록 저장소(없으면 이번 대화 메모리에만)
    personal: PersonalStore | None = None
    # 암호화된 조작 기록(없으면 '오늘 한 일'은 비어 있다고 답함)
    action_log: Any = None
    # 승인을 물은 뒤 지난 시간을 재는 시계(초). 테스트가 세션을 만든 뒤 바꾸므로 부를 때마다 읽는다.
    clock: Callable[[], float] = time.monotonic


# 이 상태가 되면 여러 명령 실행을 멈추고 사용자에게 묻는다.
PLAN_STOP_STATES = {"NEEDS_CLARIFICATION", "VALIDATION_ERROR", "WAITING_FOR_USER_CONFIRMATION", "AUTH_HANDOFF", "STOPPED", "RECOVERING"}
# 승인을 물은 뒤 이만큼 지나 받은 승인은 실행하지 않고 요약을 다시 읽어 묻는다(주인 결정 2026-11-18)
APPROVAL_TTL_S = 120
# 승인을 받았지만 물어본 뒤 화면이 바뀌어 하지 않은 일(승인 대기 종류별)
NOT_DONE = {"click": "누르지 않았어요.", "assist": "넣지 않았어요.", None: "모의접수하지 않았어요."}


@dataclass
class Turn:
    id: str
    text: str
    intentType: str
    started: float
    epoch: int
    trace: list[dict]
    ctx: ExecContext | None = None
    # 외국어로 말했을 때의 (비식별) 원문. text는 한국어 번역.
    original: str | None = None


NO_SECRET = SensitiveDetection(kinds=[], hasSecretValue=False)
# 본인인증 인계 중 "다 했어", "입력했어" 같은 끝맺음은 비밀값이 아니다
_DONE_REPLY = rx(r"^(다\s*)?(했어|했어요|했습니다|했다|했고|끝났어|끝났어요|끝|완료|됐어|됐어요|됐다|입력했어|입력했어요|넣었어|넣었어요)")
HELP_POINTER = "'뭐라고 말하면 돼?'라고 물어보시면 할 수 있는 말을 알려 드려요."


def _text_of(out: Any) -> str:
    return out["text"] if isinstance(out, dict) and isinstance(out.get("text"), str) else ""


class SessionOrchestrator:
    def __init__(self, deps: OrchestratorDeps) -> None:
        self.deps = deps
        self.narrator = Narrator(deps)
        self.id = uuid()
        self.dialogue = DialogueState("AWAITING_CONSENT" if deps.require_consent else "IDLE", clock=lambda: deps.clock())
        self.progress = Progress()
        self.form = FormSkill(deps.web, self.dialogue, self.narrator)
        self.browse = BrowseSkill(
            deps.web, self.dialogue, self.narrator, self.form, deps, self.progress, official_text=lambda url: deps.welfare.readable_service(url)
        )
        self._history: list[dict] = []
        self._lock = asyncio.Lock()
        self._epoch = 0
        self._controller = AbortController()
        self._approvals: set[str] = set()
        # 직전에 Agent B가 근거를 찾아 답한 서비스. 다음 신청 요청 때 Agent A로 인계한다.
        self._grounded: dict | None = None  # {'servNm', 'sources'}
        self._consent = "pending" if deps.require_consent else "granted"
        # 맞춤 복지 찾기: 이번 대화에서만 쓰는 사용자 정보
        self._profile: dict = {}
        self._personal = deps.personal or PersonalStore()
        self.personal_dialogue = PersonalDialogue(
            self._personal, self.dialogue, on_speech=self._apply_speech, action_log=deps.action_log
        )
        self._apply_speech(self._personal.speech())
        # 직전 응답의 종류(되묻기를 연달아 하지 않으려고)
        self._last_semantic: str | None = None
        # 도움말 다음 쪽('다른 말도 알려줘'는 여기부터, 새로 물으면 처음부터)
        self._help_page = 0
        # 대화 언어. 한국어가 아니면 번역 계층을 거친다(i18n.py).
        self._lang = "ko"
        # 직전 말에서 비밀번호·인증번호를 값 없이 언급함 / 비밀값일 수 있어 막은 말의 해시(같은 말을 다시 하면 통과)
        self._secret_hint = False
        self._secret_guarded: str | None = None
        vocabulary = field_vocabulary(deps.web.profile)
        self._rules = RuleBasedIntentProvider(vocabulary)
        self.understanding = Understanding(self._rules, deps, vocabulary)
        self.guided = GuidedFill(
            deps.web,
            self.dialogue,
            self.narrator,
            self._rules,
            saved_value=self.personal_dialogue.saved_for,
            site_allowed=self._personal.site_allowed,
            allow_site=self._personal.allow_site,
        )
        self.browse.guided_resume = self.guided.resume_after_auth

    @property
    def consent_status(self) -> str:
        return self._consent

    @property
    def state(self) -> str:
        return self.dialogue.state

    @property
    def lang(self) -> str:
        return self._lang

    @property
    def web(self) -> WebExecutionAgent:
        return self.deps.web

    # ---------------------------------------------------------------- 공개 API

    async def consent_to(self, granted: bool) -> dict:
        """
        시작 동의(화면 읽기·브라우저 조작·음성 외부 전송 안내에 대한 사용자 승인).
        동의 전에는 받아쓰기도 하지 않도록 클라이언트는 키보드/버튼으로만 동의를 받는다.
        """

        async def work() -> dict:
            turn = self._begin_turn("[동의함]" if granted else "[동의하지 않음]")
            turn.intentType = "CONSENT"
            self._consent = "granted" if granted else "declined"
            if not granted:
                return self._finish(turn, draft("IDLE", "consent", "알겠어요. 화면은 읽거나 조작하지 않고, 복지 제도 질문에만 답할게요."))
            await self.prepare()
            # 신청 기록에 기한이 가까운 것이 있으면 시작할 때 알린다(기능 5)
            due = self.reminders()
            return self._finish(turn, draft("IDLE", "consent", f"동의해 주셔서 감사합니다. 시작할게요.{f' 알려 드릴 게 있어요. {due}' if due else ''}"))

        return await self._enqueue(work)

    async def handle_turn(self, raw_text: str) -> dict:
        """사용자 발화 처리. 원문은 이 함수 밖으로 나가지 않는다(비식별화 후 사용)."""
        # 받아쓰기·입력이 자모 분리형(NFD)으로 올 수 있어 민감정보 판정·규칙 비교 전에 맞춘다
        normalized = rx(r"\s+").sub(" ", unicodedata.normalize("NFC", raw_text).strip())
        sensitive = detect_sensitive(normalized)
        text = redact_text(normalized)
        if is_stop_utterance(text):
            return self._stop(text)
        spoken = strip_address(text)
        if not spoken:

            async def called() -> dict:
                return self._fixed_reply(text, "네, 말씀하세요.", "ko")

            return await self._enqueue(called)
        if is_progress_question(spoken):
            return self._progress_reply(spoken)
        return await self._enqueue(lambda: self._process(spoken, sensitive))

    async def set_language(self, lang: str) -> dict:
        """UI의 언어 선택. 음성 "영어로 말해줘"와 같은 경로."""

        async def work() -> dict:
            return self._switch_language("[언어 선택]", lang)

        return await self._enqueue(work)

    async def confirm(self, approve: bool) -> dict:
        """UI의 승인/거절 버튼. 음성 "모의접수 승인"과 같은 경로를 탄다."""
        return await self._enqueue(
            lambda: self._process("[승인 버튼]" if approve else "[거절 버튼]", NO_SECRET, {"type": "APPROVE" if approve else "REJECT"})
        )

    def cancel(self) -> dict:
        return self._stop("[멈춤 버튼]")

    async def prepare(self) -> None:
        """세션 시작 직후 한 번: 브라우저 창에 모의 사이트 첫 화면을 띄운다. 실패해도 세션은 쓸 수 있다."""
        # 실제 사이트 모드는 미리 아무 창도 띄우지 않는다(사용자가 말한 사이트를 그때 연다)
        if self.deps.practice_mode is False:
            return
        turn = self._begin_turn("[세션 준비]")
        try:
            await self.web.open_home(turn.ctx)
        except Exception:  # noqa: BLE001
            pass

    def snapshot(self) -> dict:
        return compact(
            {
                "sessionId": self.id,
                "state": self.dialogue.state,
                "platform": "pc",
                "observation": self._summarize(self.web.current_view),
                "pendingConfirmation": self.dialogue.confirmation,
                "awaitingField": self.dialogue.awaiting,
                "history": list(self._history),
                "mockOnly": True,
                "speechPrefs": self._personal.speech(),
            }
        )

    def _apply_speech(self, prefs: dict) -> None:
        """말하기 설정 → 진행 알림 on/off. 속도·목소리는 TurnResult.speechPrefs로 UI가 반영한다."""
        self.progress.spoken = bool(prefs.get("progressSpoken", True))

    def export_history(self) -> list[dict]:
        return list(self._history)

    def reminders(self) -> str | None:
        """기한이 3일 이내인 신청 알림(없으면 None). 시작할 때와 주기적으로 쓴다."""
        return due_reminder(self._personal.applications())

    async def close(self) -> None:
        self._controller.abort()
        await self.web.close()

    # ---------------------------------------------------------------- 큐·중단

    async def _enqueue(self, fn: Callable[[], Awaitable[dict]]) -> dict:
        epoch = self._epoch
        async with self._lock:
            if epoch != self._epoch:
                return self._voided()
            return await fn()

    def _voided(self) -> dict:
        turn = self._begin_turn("[중단으로 취소된 요청]")
        return self._finish(turn, draft("STOPPED", "none", "중단 요청 때문에 이 요청은 실행하지 않았습니다."))

    def _stop(self, text: str) -> dict:
        self._epoch += 1
        self._controller.abort()
        self._controller = AbortController()
        dropped = self._dropped_on_stop() if self._lang == "ko" else ""
        self.dialogue.stop()
        self._approvals.clear()
        turn = self._begin_turn(text)
        turn.intentType = "STOP"
        self._trace(turn, "INTENT_DETECTED", AGENT_IDS.orchestrator, "STOP (규칙 즉시 판정)")
        speech = f"{FIXED['stop'][self._lang]} {dropped}".strip()
        return self._finish(turn, draft("STOPPED", "stop", speech, lang=self._lang))

    def _progress_reply(self, text: str) -> dict:
        """'지금 어디까지 했어?': 멈춤처럼 턴 대기열을 거치지 않고 진행 기록에서 바로 답한다(일하는 중에도, 멈춘 뒤에도)."""
        turn = self._begin_turn(text)
        turn.intentType = "PROGRESS"
        self._trace(turn, "INTENT_DETECTED", AGENT_IDS.orchestrator, "PROGRESS (규칙 즉시 판정)")
        return self._finish(turn, self._progress_draft(busy=self._lock.locked()))

    def _progress_draft(self, busy: bool) -> dict:
        """busy: 다른 턴이 대기열을 잡고 일하는 중(목표 수행이 아니면 단계 기록이 없다)"""
        p = self.progress
        if p.running and p.latest:
            speech = f"지금까지 {p.count}단계 했어요. 방금 {p.latest}"
        elif p.running:
            speech = "막 시작해서 화면을 보고 있어요."
        elif busy:
            speech = "말씀하신 일을 하고 있어요. 조금만 기다려 주세요."
        else:
            speech = f"지금 하고 있는 일은 없어요. 마지막으로 {p.latest}" if p.latest else "지금 하고 있는 일은 없어요."
        return draft(self.dialogue.state, "read-state", speech)

    def _dropped_on_stop(self) -> str:
        """멈추면서 접은 일을 소리로 알린다(화면을 볼 수 없으니 무엇이 취소됐는지 말해야 안다)."""
        d = self.dialogue
        notes: list[str] = []
        if d.approval:
            notes.append("승인을 기다리던 일은 하지 않았어요.")
        pending = d.vault_confirm
        if pending and pending["kind"] == "vault-save":
            listed = ", ".join(f"{VAULT_LABELS[k]} {v}" for k, v in pending["values"].items())
            notes.append(f"저장하려던 {josa(listed, '은', '는')} 저장하지 않았어요.")
        elif pending:
            notes.append("내 정보는 지우지 않았어요.")
        if d.guided:
            notes.append("입력 칸 채우기도 멈췄어요.")
        if d.profile_question:
            notes.append("맞춤 복지 질문도 그만할게요.")
        return " ".join(notes)

    # ---------------------------------------------------------------- 턴 처리

    def _begin_turn(self, text: str) -> Turn:
        turn = Turn(id=uuid(), text=text, intentType="NONE", started=time.monotonic(), epoch=self._epoch, trace=[])
        signal = self._controller.signal
        turn.ctx = ExecContext(
            signal=signal,
            approvals=self._approvals,
            is_stopped=lambda: turn.epoch != self._epoch or self.dialogue.state == "STOPPED",
            trace=lambda phase, agent, note=None: self._trace(turn, phase, agent, note),
            counter={"actions": 0},
        )
        return turn

    @staticmethod
    def _elapsed(turn: Turn) -> int:
        return int((time.monotonic() - turn.started) * 1000)

    def _trace(self, turn: Turn, phase: str, agent: str, note: str | None = None) -> None:
        entry = {"phase": phase, "agent": agent, "atMs": self._elapsed(turn)}
        if note is not None:
            entry["note"] = note
        turn.trace.append(entry)

    # ---------------------------------------------------------------- 다국어(번역 계층)

    async def _process(self, text: str, sensitive: SensitiveDetection, forced: dict | None = None) -> dict:
        """
        한 턴: 언어 바꾸기 명령 → (외국어면) 한국어로 옮겨 기존 흐름 → 응답을 사용자 언어로.
        승인 대기 중에는 번역 결과가 '승인'으로 읽혀도 원문이 언어별 승인 단어가 아니면 받지 않는다.
        """
        if forced:
            return await self._localize(await self._process_korean(text, sensitive, forced))
        # 비밀값은 번역(외부 LLM)에 넘기기 전에 막는다: 어느 언어든 바로 경고만 한다
        if sensitive.hasSecretValue:
            return await self._localize(await self._process_korean(text, sensitive))
        switch_to = detect_lang_switch(text)
        if switch_to:
            return self._switch_language(text, switch_to)
        # 글자가 분명히 다른 언어면 그 언어로 바꾼다(텍스트 입력, 또는 그 언어로 받아쓴 경우)
        script = detect_script_lang(text)
        if script and script != self._lang and (script == "ko" or self.deps.llm):
            self._lang = script
        lang = self._lang
        if lang == "ko" or script == "ko" or not self.deps.llm:
            return await self._process_korean(text, sensitive)

        awaiting_approval = self.dialogue.expects_confirmation
        confirmation = foreign_confirmation(text, lang)
        if awaiting_approval and confirmation:
            korean = "승인" if confirmation == "approve" else "거절"
        else:
            translated = await translate_in(self.deps.llm, text, lang, self._controller.signal)
            if not translated:
                return self._fixed_reply(text, FIXED["retry"][lang], lang)
            if awaiting_approval and (await self._rules.parse(translated, IntentContext(state=self.dialogue.state)))["type"] == "APPROVE":
                return self._fixed_reply(text, FIXED["approveHint"][lang], lang)
            korean = translated
        result = await self._process_korean(korean, sensitive, None, text)
        return await self._localize(result)

    # ---------------------------------------------------------------- 한국어 흐름

    def _short_reply(self, text: str) -> dict | None:
        """맞장구("알았어")·부정("아니")만 한 말에 대한 짧은 응답. 해당하지 않으면 None."""
        kind = short_reply_kind(text)
        if kind is None:
            return None
        no = kind == "no"
        # 승인 대기 중: 승인은 분명한 말로만, "아니"는 거절 흐름(기존 규칙)에 맡긴다
        if self.dialogue.approval:
            if no:
                return None
            return draft(self.dialogue.state, "clarify", "아직 확인을 기다리고 있어요. 진행하려면 '승인' 또는 '응', 하지 않으려면 '아니'라고 말씀해 주세요.")
        view = self.web.current_view
        if self.dialogue.awaiting and is_form_open(self.web.current_view) and view:
            f = self.web.field(self.dialogue.awaiting)
            label = speak_label(f.label) if f else "그 항목"
            if no:
                return draft(self.dialogue.state, "clarify", f"알겠어요. {josa(label, '은', '는')} 아직 비워 둘게요. 다른 값을 말씀하시거나 '다음으로', '멈춰'라고 해 주세요.")
            return draft(self.dialogue.state, "clarify", f"네. {josa(label, '을', '를')} 말씀해 주세요.")
        self.dialogue.clear_choice()
        return draft(self.dialogue.state, "none", "알겠어요. 그럼 무엇을 도와드릴까요?" if no else "네.")

    async def _answer_many(self, text: str, turn: Turn) -> dict | None:
        """
        한 번에 여러 질문("기초연금은 몇 살부터고 얼마 받아? 그리고 오늘 날씨는?")이면 LLM으로 나눠 하나씩 처리하고 답을 이어 말한다.
        명령(입력·이동)이 섞이면 기존 여러 명령 흐름에 맡긴다. 해당하지 않으면 None.
        """
        # 멈춘 동안에는 나누지 않는다: 멈춤 문은 턴 전체에 한 번, '다시 시작'으로 시작하는 말만 통과시킨다.
        if self.dialogue.state == "STOPPED":
            return None
        questions = await split_questions(self.deps.llm, text, self._recent_dialogue(4), turn.ctx.signal)
        if len(questions) < 2:
            return None
        self._trace(turn, "PLANNING", AGENT_IDS.orchestrator, f"질문 {len(questions)}개로 나눔")
        drafts: list[dict] = []
        for q in questions:
            if turn.epoch != self._epoch:
                break
            intent = (await self._understand(q, turn)).intents[0]
            refused = self._consent_gate(intent)
            if refused:
                return refused
            drafts.append(await self._route(intent, replace(turn, text=q)))
        if not drafts:
            return None
        last = drafts[-1]
        return {
            **last,
            "speech": " ".join(f"{i + 1}. {nz(d.get('summary'), d['speech'])}" for i, d in enumerate(drafts)),
            "actions": [a for d in drafts for a in d.get("actions") or []],
            "sources": [s for d in drafts for s in d.get("sources") or []],
        }

    def _fixed_reply(self, text: str, speech: str, lang: str) -> dict:
        turn = self._begin_turn(text)
        turn.intentType = "CLARIFY"
        return self._finish(turn, draft(self.dialogue.state, "clarify", speech, lang=lang))

    def _switch_language(self, text: str, to: str) -> dict:
        turn = self._begin_turn(text)
        turn.intentType = "SET_LANGUAGE"
        if to != "ko" and not self.deps.llm:
            return self._finish(turn, draft(self.dialogue.state, "set-language", FIXED["needLlm"][self._lang], lang=self._lang))
        self._lang = to
        self._trace(turn, "INTENT_DETECTED", AGENT_IDS.orchestrator, f"SET_LANGUAGE {to} (규칙)")
        return self._finish(turn, draft(self.dialogue.state, "set-language", FIXED["switched"][to], lang=to))

    async def _localize(self, r: dict) -> dict:
        """한국어 응답을 사용자 언어로. 숫자가 바뀌면 원문 한국어를 들려준다(지어낸 숫자 방지)."""
        lang = self._lang
        if lang == "ko" or r.get("lang") == lang or not self.deps.llm:
            return r
        t0 = time.monotonic()
        try:
            out = await translate_out(self.deps.llm, r["speech"], lang, self._controller.signal)
        except Exception:  # noqa: BLE001
            out = None
        last_at = r["trace"][-1]["atMs"] if r["trace"] else 0
        return {
            **r,
            "speech": out if out else f"{FIXED['translateFail'][lang]} {r['speech']}",
            "lang": lang if out else "ko",
            "trace": [
                *r["trace"],
                {
                    "phase": "SPEAKING",
                    "agent": AGENT_IDS.orchestrator,
                    "atMs": last_at + int((time.monotonic() - t0) * 1000),
                    "note": f"응답 번역 ko→{lang}" if out else "응답 번역 실패(숫자 불일치 등) → 한국어 원문",
                },
            ],
        }

    def _gate(self, intents: list[dict]) -> dict | None:
        """턴 시작의 동의·멈춤 문"""
        return self._refused(gate_refusal([i["type"] for i in intents], self._consent, self.dialogue.state))

    def _consent_gate(self, intent: dict) -> dict | None:
        """질문마다, 실행 직전마다의 동의 문(멈춤은 턴 시작에서 이미 봤다)"""
        return self._refused(consent_refusal([intent["type"]], self._consent))

    def _refused(self, refusal: GateRefusal | None) -> dict | None:
        if refusal is None:
            return None
        return draft(refusal.state or self.dialogue.state, refusal.semanticAction, refusal.speech)

    async def _process_korean(self, text: str, sensitive: SensitiveDetection, forced: dict | None = None, original: str | None = None) -> dict:
        turn = self._begin_turn(text)
        turn.original = original
        self._trace(turn, "TRANSCRIBED", AGENT_IDS.orchestrator, f"번역 {self._lang}→ko" if original else None)
        try:
            # 직전 말에서 비밀번호·인증번호를 값 없이 언급했는지(이번 말이 그 값일 수 있다)
            hint = self._secret_hint
            self._secret_hint = not forced and not sensitive.hasSecretValue and any(k in ("password", "otp") for k in sensitive.kinds)
            if sensitive.hasSecretValue:
                turn.intentType = "SECRET_DISCLOSURE"
                return self._finish(turn, self._handle_secret(sensitive))
            if not forced and original is None and self._maybe_spoken_secret(text, hint):
                turn.intentType = "SECRET_DISCLOSURE"
                turn.text = REDACTED
                return self._finish(turn, self._possible_secret())
            # 맞춤 복지 질문에 대한 답이면 이어서 진행(다른 명령이면 질문을 접고 그 명령을 처리)
            if not forced and self.dialogue.profile_question:
                asked = self.dialogue.profile_question
                answer = parse_profile_answer(text, asked)
                if answer:
                    turn.intentType = "PROFILE_ANSWER"
                    self._profile = {**self._profile, **answer}
                    return self._finish(turn, await self._discover_step(turn, False))
                # 대답을 못 알아들었고 다른 명령도 아니면, 처음부터 다시 묻지 말고 그 질문만 짧게 다시 묻는다
                other = await self._rules.parse(text, IntentContext(state=self.dialogue.state))
                looks_like_answer = len(text) <= 20 and not rx(r"(줘|주세요|알려|열어|도움|뭐야|어떻게|멈춰|그만)").search(text)
                if other["type"] == "UNKNOWN" and looks_like_answer and not parse_personal_command(text) and not detect_lang_switch(text):
                    turn.intentType = "PROFILE_ANSWER"
                    return self._finish(turn, draft(self.dialogue.state, "discover", f"제가 잘 못 알아들었어요. {PROFILE_QUESTIONS[asked]}"))
                self.dialogue.profile_done()
            if not forced:
                # 라벨(intentType)은 await 전에 적는다. 그 안에서 예외가 나면 RECOVERING 결과가 이 라벨을 보고한다.
                # 금고 저장·삭제 확인에 대한 대답. 다른 말이면 확인만 접고 그 말을 아래에서 처리한다.
                if self.dialogue.vault_confirm:
                    turn.intentType = "VAULT_CONFIRM"
                    confirmed = self.personal_dialogue.confirm(text)
                    if confirmed:
                        return self._finish(turn, confirmed)
                # 실제 사이트 칸 채우기(기능 3). 진행 중이면 그 대답으로 받고, 아니면 '하나씩 채워줘'로 시작한다.
                # 승인 대기(칸에 넣을지 물음) 중이면 칸 채우기 대답으로 가로채지 않고 _approve로 보낸다.
                if self.guided.active() and not self.dialogue.approval:
                    turn.intentType = "GUIDED_FILL"
                    answered = await self.guided.answer(text, turn.ctx)
                    if answered:
                        return self._finish(turn, answered)
                if self.guided.wants_start(text):
                    turn.intentType = "GUIDED_FILL"
                    return self._finish(turn, self._gate([{"type": "GUIDED_FILL"}]) or await self.guided.start(turn.ctx))
                # 금고·신청 기록 명령(기능 4·5). 다른 명령처럼 동의 문과 멈춤 문을 지난다.
                cmd = parse_personal_command(text)
                if cmd:
                    turn.intentType = f"PERSONAL_{cmd['kind'].upper().replace('-', '_', 1)}"
                    refused = self._gate([{"type": turn.intentType}])
                    if refused:
                        return self._finish(turn, refused)
                    done = self.personal_dialogue.run(cmd)
                    if done:
                        return self._finish(turn, done)
                # "알았어", "아니" 같은 짧은 대답은 명령이 아니다: 입력값으로 넣거나 다음으로 넘어가지 않는다.
                short = self._short_reply(text)
                if short:
                    turn.intentType = "ACK"
                    return self._finish(turn, short)
                # "알았고 다음으로 가줘", "아니 네이버 말고 다음 열어줘": 앞의 맞장구·군말은 떼고 본다
                text = strip_filler(text)
                # 질문 여러 개를 한 번에 하면 하나씩 답해 이어 말한다
                many = await self._answer_many(text, turn)
                if many:
                    turn.intentType = "MULTI_QUESTION"
                    return self._finish(turn, many)
            # 승인을 기다리는 중의 "눌러", "진행해"는 두루뭉술한 말이 아니라 승인이다.
            vague = None if forced or self.dialogue.approval else vague_question(text)
            if vague:
                turn.intentType = "CLARIFY"
                return self._finish(turn, draft(self.dialogue.state, "clarify", vague))
            understood = Understood([forced], "ui") if forced else await self._understand(text, turn)
            intents = understood.intents
            intent = intents[0]
            turn.intentType = f"PLAN({'>'.join(i['type'] for i in intents)})" if len(intents) > 1 else intent["type"]
            self._trace(turn, "INTENT_DETECTED", AGENT_IDS.orchestrator, f"{turn.intentType} via {understood.by}")
            refused = self._gate(intents)
            if refused:
                return self._finish(turn, refused)
            if len(intents) > 1:
                return self._finish(turn, await self._run_plan(intents, turn))
            return self._finish(turn, await self._route(intent, turn))
        except Exception as e:  # noqa: BLE001
            name = type(e).__name__
            return self._finish(
                turn,
                draft("RECOVERING", "none", f"처리 중 문제가 생겨 실행을 멈췄습니다({name}). 다시 말씀해 주세요."),
            )

    def _finish(self, turn: Turn, draft: dict) -> dict:
        stopped_meanwhile = turn.epoch != self._epoch and draft["semanticAction"] != "stop"
        state = "STOPPED" if stopped_meanwhile else draft["state"]
        speech = f"중단 요청으로 작업을 멈췄습니다. {draft['speech']}" if stopped_meanwhile else draft["speech"]
        speech = self._trim_speech(speech)
        if not stopped_meanwhile:
            self.dialogue.commit(state)
        self._last_semantic = draft["semanticAction"]
        self._trace(turn, "SPEAKING", AGENT_IDS.orchestrator)

        view = draft.get("view") or self.web.current_view
        at = now_iso()
        self._history.append({"turnId": turn.id, "role": "user", "text": turn.text, "at": at, "state": state})
        # 금고 값(저장 대기 포함)은 사용자에게는 읽어 주되, LLM에 가는 기록에는 넣지 않는다.
        self._history.append({"turnId": turn.id, "role": "assistant", "text": self._history_speech(speech), "at": at, "state": state})

        actions = draft.get("actions") or []
        if self.deps.events:
            for a in actions:
                result = a.get("result") or {}
                self.deps.events.record(
                    compact(
                        {
                            "sessionId": self.id,
                            "turnId": turn.id,
                            "actionType": a["action"]["type"],
                            "success": bool(result.get("ok")),
                            "latencyMs": result.get("latencyMs", 0),
                            "errorCode": result.get("errorCode") or (None if a["policy"]["allowed"] else a["policy"]["code"]),
                            "at": at,
                        }
                    )
                )

        return parse_turn_result(
            compact(
                {
                    "sessionId": self.id,
                    "turnId": turn.id,
                    "userUtterance": turn.original or turn.text,
                    "intentType": turn.intentType,
                    "state": state,
                    "semanticAction": draft["semanticAction"],
                    "field": draft.get("field"),
                    "value": draft.get("value"),
                    "page": view.get("pageId") if view else None,
                    "accessMode": self.web.access_mode(view) if view else None,
                    "speech": speech,
                    "lang": draft.get("lang") or "ko",
                    "trace": turn.trace,
                    "actions": actions,
                    "observation": self._summarize(view),
                    "verification": draft.get("verification"),
                    "pendingConfirmation": self.dialogue.confirmation,
                    "handoff": draft.get("handoff"),
                    "sources": draft.get("sources") or [],
                    "missingFields": draft.get("missingFields") or [],
                    "pendingActions": 0,
                    "realSubmission": False,
                    "flags": {"secretDetected": bool(draft.get("secretDetected")), "masked": bool(draft.get("masked"))},
                    "latencyMs": self._elapsed(turn),
                    "speechPrefs": self._personal.speech(),
                }
            )
        )

    def _trim_speech(self, speech: str) -> str:
        """답 길이가 '짧게'이면 긴 답을 첫 두 문장까지 줄인다. 말하기 설정 명령 답은 그대로."""
        prefs = self._personal.speech()
        if prefs.get("length") != "short" or len(speech) < 100:
            return speech
        # 설정 알려 주는 문장은 줄이지 않는다
        if "말하는 속도" in speech or "말하기 설정" in speech:
            return speech
        parts = [p.strip() for p in rx(r"(?<=[.!?。]|요\.|다\.)\s+").split(speech) if p.strip()]
        if len(parts) <= 2:
            return speech
        return " ".join(parts[:2])

    def _summarize(self, view: dict | None) -> dict | None:
        """화면 관찰을 UI/로그용으로 요약하면서 개인정보 마스킹 규칙을 적용한다."""
        if not view:
            return None
        fields = []
        for f in view["fields"]:
            profile = self.web.field(f["fieldId"])
            if f.get("sensitive"):
                value = ""
            elif profile and profile.mask_on_readback and f["value"]:
                value = mask_value(f["value"])
            else:
                value = f["value"]
            fields.append({**f, "value": value})
        return compact(
            {
                "page": view["pageId"],
                "url": view["url"],
                "title": view["title"],
                "step": view.get("step"),
                "errors": view["errors"],
                "status": view.get("status"),
                "fields": fields,
            }
        )

    # ---------------------------------------------------------------- 라우팅

    def _history_speech(self, speech: str) -> str:
        """보조 턴 기록용: 금고에 있거나 저장 확인 대기 중인 값을 [비공개]로 바꾼다(들은 말은 그대로)."""
        secrets = set(self._personal.vault().values())
        pending = self.dialogue.vault_confirm
        if pending and pending.get("kind") == "vault-save":
            secrets.update((pending.get("values") or {}).values())
        out = speech
        for value in sorted((v for v in secrets if isinstance(v, str) and v), key=len, reverse=True):
            if value in out:
                out = out.replace(value, REDACTED)
        return out

    def _recent_dialogue(self, n: int = 6) -> list[str]:
        return [f"{'사용자' if h['role'] == 'user' else '청음'}: {h['text'][:400]}" for h in self._history[-n:]]

    async def _understand(self, text: str, turn: Turn) -> Understood:
        """이번 턴의 대화 상태를 붙여 말 이해(understanding/understand.py)에 맡긴다."""
        awaiting = self.dialogue.awaiting
        current = self.web.current_view
        return await self.understanding.understand(
            text,
            IntentContext(state=self.dialogue.state, awaitingFieldId=awaiting),
            awaited=self.web.field(awaiting) if awaiting else None,
            clarifying=bool(self.dialogue.clarification),
            page=current.get("title") if current else None,
            recent=self._recent_dialogue(4),
            trace=lambda note: self._trace(turn, "PLANNING", AGENT_IDS.orchestrator, note),
        )

    async def _run_plan(self, intents: list[dict], turn: Turn) -> dict:
        """여러 명령을 차례로 실행. 확인·승인이 필요한 단계에서 멈추고 남은 일을 알려 준다."""
        drafts: list[dict] = []
        for i, intent in enumerate(intents):
            if turn.epoch != self._epoch:
                break
            self._trace(turn, "PLANNING", AGENT_IDS.orchestrator, f"단계 {i + 1}/{len(intents)}: {intent['type']}")
            d = await self._route(intent, turn)
            drafts.append(d)
            if d["state"] in PLAN_STOP_STATES or d["semanticAction"] == "consent":
                break
        last = drafts[-1]
        skipped = len(intents) - len(drafts)
        speech = " ".join(
            x
            for x in [
                *(nz(d.get("summary"), d["speech"]) for d in drafts[:-1]),
                last["speech"],
                f"나머지 {skipped}가지 요청은 이것부터 해결한 뒤 다시 말씀해 주세요." if skipped > 0 else "",
            ]
            if x
        )
        out = {
            **last,
            "speech": speech,
            "actions": [a for d in drafts for a in d.get("actions") or []],
            "sources": [s for d in drafts for s in d.get("sources") or []],
        }
        out.pop("summary", None)
        if last.get("missingFields") is not None:
            out["missingFields"] = last["missingFields"]
        return out

    async def _discover_step(self, turn: Turn, first: bool) -> dict:
        """맞춤 복지 찾기: 비어 있는 항목을 하나씩 묻고, 다 모이면 찾는다(답은 이번 대화에서만 사용)."""
        nxt = next_profile_slot(self._profile)
        if nxt:
            self.dialogue.ask_profile(nxt)
            intro = "맞춤 복지를 찾아볼게요. 몇 가지만 여쭤볼게요. 답은 이번 대화에서만 쓰고 저장하지 않아요. " if first else ""
            return draft(self.dialogue.state, "discover", f"{intro}{PROFILE_QUESTIONS[nxt]}")
        self.dialogue.profile_done()
        self._trace(turn, "PLANNING", AGENT_IDS.welfare, "맞춤 복지 찾기")
        return self._welfare_draft(await self.deps.welfare.discover(self._profile), "discover")

    def _welfare_draft(self, answer: Any, semantic: str) -> dict:
        if answer.grounded and answer.service:
            self._grounded = {"servNm": answer.service["servNm"], "sources": answer.sources}
        return draft(self.dialogue.state, semantic, answer.speech, sources=answer.sources)

    async def _rephrase(self, turn: Turn) -> dict:
        """"쉽게 말해줘": 직전 안내를 쉬운 말로(LLM이 없거나 숫자를 바꿔 말하면 그대로 다시)."""
        last_speech = next((h["text"] for h in reversed(self._history) if h["role"] == "assistant"), None)
        if not last_speech:
            return draft(self.dialogue.state, "rephrase", "아직 드린 안내가 없어요. 무엇을 도와드릴까요?")
        if self.deps.llm:
            out = await self.deps.llm.generate(
                system="시각장애인 사용자가 방금 들은 안내를 이해하지 못했다. 같은 내용을 더 쉬운 말로, 짧은 문장 2~4개로 다시 말해라. 새 정보를 지어내지 말고, 숫자·금액·출처는 그대로 유지. 존댓말.",
                user=last_speech,
                schemaName="simple",
                schema=SIMPLE_TEXT_SCHEMA,
            )
            text = _text_of(out)
            changed = unsupported_numbers(text, [last_speech])
            if changed:
                self._trace(turn, "VERIFYING", AGENT_IDS.verifier, f"쉬운 말에 직전 안내에 없는 숫자({', '.join(changed)}) → 직전 안내 그대로")
            elif text:
                return draft(self.dialogue.state, "rephrase", f"쉽게 다시 말씀드릴게요. {text}")
        return draft(self.dialogue.state, "rephrase", f"천천히 다시 말씀드릴게요. {last_speech}")

    async def _free_chat(self, text: str, turn: Turn) -> dict:
        """
        화면 밖 자유 대화(티키타카). LLM이 종류를 고른다:
        welfare = 복지 제도 → 공식 데이터 근거 답변 / web_search = 날씨·뉴스 등 실시간 → 네이버 검색 후 요약
        general = 일반 상식 → 바로 답 / clarify = 뜻이 불분명 → 되묻기
        """
        view = self.web.current_view
        self._trace(turn, "PLANNING", AGENT_IDS.welfare, "자유 대화 분류")
        last_assistant = next((h["text"] for h in reversed(self._history) if h["role"] == "assistant"), None)
        out = await chat_route(
            self.deps.llm,
            text,
            page=view.get("title") if view else None,
            last_assistant=last_assistant,
            recent=self._recent_dialogue(8),
            asked_just_now=self._last_semantic == "clarify",
        )
        resume = self.form.ask_next(view) if is_form_open(self.web.current_view) and view else ""

        def with_resume(d: dict) -> dict:
            return {**d, "speech": f"{d['speech']} 이어서 {resume}"} if resume and d["semanticAction"] != "welfare-retrieval" else d

        route = out.get("route")
        if not route:
            return draft(self.dialogue.state, "none", f"죄송해요, 잘 이해하지 못했어요. 다시 한 번 말씀해 주시겠어요? {HELP_POINTER}")
        if route == "language" and out.get("language") in ("ko", "en", "zh", "ja"):
            self._lang = out["language"]
            return draft(self.dialogue.state, "set-language", FIXED["switched"][out["language"]], lang=out["language"])
        if route == "welfare":
            return await self._policy_question(text, turn)
        if route == "web_task":
            return with_resume(await self.browse.run_goal(text, turn.ctx))
        if route == "web_search" and out.get("searchQuery"):
            return with_resume(await self.browse.web_answer(text, out["searchQuery"], turn.ctx))
        reply = out.get("reply").strip() if isinstance(out.get("reply"), str) else ""
        return with_resume(draft(self.dialogue.state, "clarify" if route == "clarify" else "chat", reply or "다시 한 번 말씀해 주시겠어요?"))

    async def _route(self, intent: dict, turn: Turn) -> dict:
        # 되묻기에 대한 답(예: "실거주지 주소")
        short_reply = len(turn.text) <= 20 and not rx(r"\d").search(turn.text)
        if self.dialogue.clarification and (short_reply or intent["type"] == "UNKNOWN"):
            picked = self.web.pick_candidate(turn.text, self.dialogue.clarification["candidates"])
            if picked:
                value = self.dialogue.clarification["value"]
                self.dialogue.clear_choice()
                return await self.form.fill_one(picked, value, turn.ctx)
        if intent["type"] != "UNKNOWN":
            self.dialogue.clear_choice()

        # 맞춤 찾기 목록 속 제도를 가리키면("1번 신청하고 싶어", "너가 찾은 기장군 교통비 지원") 그 제도로 이어 간다.
        # (링크 목록을 막 읽어 준 뒤의 "2번"은 링크 고르기라 제외)
        list_just_read = self._last_semantic == "list-links"
        welfare = self.deps.welfare
        if welfare.has_matches and not list_just_read and intent["type"] in ("START_APPLICATION", "DISCOVER", "UNKNOWN", "POLICY_QUESTION"):
            hit = welfare.find_in_matches(turn.text)
            if hit:
                welfare.pick(turn.text)
                self._grounded = None
                self._trace(turn, "PLANNING", AGENT_IDS.welfare, f"찾기 결과에서 고름: {hit['servNm']}")
                if rx(r"(신청|도와|하고\s*싶)").search(turn.text):
                    intent = {"type": "START_APPLICATION"}
                elif intent["type"] != "POLICY_QUESTION":
                    return self._welfare_draft(await welfare.service_detail(hit["servNm"]), "discover")

        refused = self._consent_gate(intent)
        if refused:
            return refused
        handle = ROUTES.get(intent["type"])
        if handle:
            return await handle(self, intent, turn)
        return await self._unknown(intent.get("text", turn.text), turn)

    async def _welfare_reply(self, pending: Awaitable[Any], semantic: str) -> dict:
        return self._welfare_draft(await pending, semantic)

    async def _discover(self, turn: Turn) -> dict:
        self._profile = {**self._profile, **parse_profile_answer(turn.text)}
        return await self._discover_step(turn, True)

    async def _open_browser(self, turn: Turn) -> dict:
        # 사이트 이름이 들어 있으면(받아쓰기 변형 포함) 크롬만 켜고 끝내지 않고 그 사이트로 간다
        if resolve_site(turn.text, self.browse.mock_sites()):
            return await self.browse.open_site(turn.text, turn.ctx)
        await self.web.show_browser()
        try:
            view = await self.web.observe(turn.ctx)
        except Exception:  # noqa: BLE001
            view = None
        return draft(self.dialogue.state, "open-browser", "크롬을 열었어요. 어디로 갈까요?", view=view)

    def _help_human(self) -> dict:
        """사람 도움: 전화는 걸지 않고, 제도·사이트 문의 번호와 짧은 말 스크립트·대신 할 일을 말한다."""
        view = self.web.current_view
        url = view.get("url") if view else None
        detail = self.deps.welfare.last_service
        contact = next((c for c in (detail.get("contacts") or []) if rx(r"^\d").search(c["value"])), None) if detail else None
        step = None
        if self.dialogue.state == "AUTH_HANDOFF":
            step = "로그인·본인인증"
        elif self.dialogue.state in ("APPLICATION_OPEN", "WAITING_FOR_USER_CONFIRMATION"):
            step = "신청 작성"
        elif self.dialogue.state == "BROWSING":
            step = "누리집 이용"
        return help_human_draft(
            self.dialogue.state,
            contact_name=(contact or {}).get("name"),
            contact_number=(contact or {}).get("value"),
            url=url,
            service_name=(detail or {}).get("servNm") or (self._grounded or {}).get("servNm"),
            step_hint=step,
        )

    def _what_can_i_say(self, more: bool) -> dict:
        """
        '뭐라고 말하면 돼?': 의도 표의 예문을 지금 화면에 맞는 묶음부터 몇 개씩 들려준다.
        '다른 말도 알려줘'(more)는 지난번에 멈춘 곳부터. 예문은 모두 규칙 파서가 제 의도로 알아듣는 말이다(test_registry).
        """
        view = self.web.current_view
        if is_form_open(view):
            lead: tuple[HelpGroup, ...] = ("신청서",)
        elif view and self.web.access_mode(view) == "read-only":
            lead = ("웹 읽기",)
        else:
            lead = ("시작", "복지 정보")
        pages = help_pages(lead, consented=self._consent == "granted")
        index = self._help_page if more else 0
        if index >= len(pages):
            self._help_page = 0
            return draft(self.dialogue.state, "help-list", "더 알려 드릴 말은 없어요. 처음부터 들으시려면 '도움말'이라고 하세요.")
        last = index == len(pages) - 1
        self._help_page = index + 1
        parts = ["이어서 알려 드릴게요." if index else "이렇게 말해 보세요."]
        for group, texts in pages[index]:
            quoted = ", ".join(f"'{t}'" for t in texts)
            parts.append(f"{group}: {quoted}.")
        if self._consent == "pending":
            parts.append("동의하시면 화면 읽기와 사이트 열기도 할 수 있어요.")
        parts.append("처음부터 다시 들으시려면 '도움말'이라고 하세요." if last else "더 들으시려면 '다른 말도 알려줘'라고 하세요.")
        return draft(self.dialogue.state, "help-list", " ".join(parts))

    async def _start_application(self, turn: Turn) -> dict:
        # 실제 사이트 모드(practice_mode=False)에서는 "연습/모의"라고 할 때만 연습 신청서, 그 밖에는 공식 안내 페이지로 간다.
        practice = self.deps.practice_mode is not False or bool(rx(r"(연습|모의)").search(turn.text))
        named = bool(rx(r"장애인\s*연금").search(turn.text))
        welfare = self.deps.welfare
        if not practice:
            picked = await welfare.select_service(turn.text)
            if picked:
                self._grounded = None
        # 어떤 제도인지 말하지 않았고 앞선 대화에도 없으면 추측하지 않고 묻는다.
        if not named or not practice:
            current = (self._grounded or {}).get("servNm") or welfare.current_service_name
            if not current:
                return draft(self.dialogue.state, "clarify", "어떤 제도를 신청하시려고요? 제도 이름을 말씀해 주세요.")
            if current != "장애인연금" or not practice:
                # Agent B가 찾은 제도의 공식 상세 페이지를 Agent A가 읽기 전용으로 연다(실제 신청은 로그인 후 사용자가 직접).
                url = welfare.current_service_url
                if url and self.web.access_mode({"url": url}) != "none":
                    out = await self.web.open_site(url, turn.ctx)
                    if out.status == "ok" and out.view:
                        self.browse.after_navigation(out.view)
                        try:
                            brief = await welfare.briefing()
                        except Exception:  # noqa: BLE001
                            brief = None
                        hint = self.narrator.once("apply", " 자세히는 '본문 읽어줘', 입력 칸은 '하나씩 채워줘'라고 하세요.")
                        speech = f"{current} 공식 안내를 열었어요. {brief or ''} 온라인 신청은 로그인과 본인인증 후 직접 하셔야 해요.{hint}"
                        return draft(
                            browse_state(out.view), "agent-handoff", rx(r"\s+").sub(" ", speech), actions=out.actions, view=out.view
                        )
                if not practice:
                    # 공식 상세 주소를 모르면 주소를 지어내지 않고 검색해서 연다
                    out = await self.web.open_site(self.browse.search_url(f"{current} 신청 방법 복지로"), turn.ctx)
                    if out.status == "ok" and out.view:
                        self.browse.after_navigation(out.view)
                        return draft(
                            browse_state(out.view),
                            "agent-handoff",
                            f"{current} 공식 페이지 주소를 몰라서 신청 방법을 검색했어요. {await self.narrator.page_intro(out.view, turn.ctx)}",
                            actions=out.actions,
                            view=out.view,
                        )
                return draft(self.dialogue.state, "clarify", f"{current} 연습 신청서는 아직 없어요. 지금은 장애인연금 연습 신청서만 있어요.")
        return await self._open_application(turn)

    def _maybe_spoken_secret(self, text: str, hint: bool) -> bool:
        """
        비밀번호를 키워드 없이 값만 말했을 수 있는 순간(본인인증 인계 중, 로그인 화면, 직전에 비밀번호를 언급)의
        명령이 아닌 짧은 말은 비밀값일 수 있다: LLM·기록에 넘기지 않는다(예: 로그인 화면에서 "사과나무").
        같은 말을 바로 한 번 더 하면 명령으로 보고 통과시킨다. 한국어 흐름에서만.
        """
        view = self.web.current_view
        risky = hint or self.dialogue.state == "AUTH_HANDOFF" or bool(view and view.get("pageId") == "mock-login")
        if not risky:
            self._secret_guarded = None
            return False
        # 값을 기다리는 칸(비밀이 아닌 칸)·칸 채우기·금고 확인·맞춤 찾기 질문의 대답이면 그쪽이 받는다
        d = self.dialogue
        if d.awaiting or d.guided or d.vault_confirm or d.profile_question:
            return False
        t = rx(r"[.!?。~]+$").sub("", text).strip()
        if not t or len(t) > 30 or is_question_like(t) or short_reply_kind(t) or _DONE_REPLY.search(t):
            return False
        if detect_lang_switch(t) or parse_personal_command(t):
            return False
        if self._rules.parse_sync(t, IntentContext(state=d.state))["type"] != "UNKNOWN":
            return False
        # 원문 대신 해시만 기억한다(비밀값일 수 있으므로)
        digest = hashlib.sha256(t.encode("utf-8")).hexdigest()
        if self._secret_guarded == digest:
            self._secret_guarded = None
            return False
        self._secret_guarded = digest
        return True

    def _possible_secret(self) -> dict:
        return draft(
            self.dialogue.state,
            "auth-handoff",
            "혹시 비밀번호나 인증번호라면 저에게 말하지 말고 화면의 입력란에 직접 입력해 주세요. 명령이었다면 한 번 더 말씀해 주세요.",
            secretDetected=True,
        )

    def _handle_secret(self, sensitive: SensitiveDetection) -> dict:
        names = ", ".join(SENSITIVE_LABELS_KO[k] for k in sensitive.kinds) or "민감 정보"
        auth = any(k in ("password", "otp") for k in sensitive.kinds) or self.dialogue.state == "AUTH_HANDOFF"
        current = self.web.current_view
        on_login = bool(current) and current.get("pageId") == "mock-login"
        return draft(
            "AUTH_HANDOFF" if auth else self.dialogue.state,
            "auth-handoff",
            f"보안을 위해 {names}는 저에게 말하지 마세요. 방금 말씀하신 값은 저장하거나 화면에 입력하지 않았습니다. "
            + (
                "인증 화면의 입력란에 키보드로 직접 입력해 주세요."
                if on_login
                else "인증이 필요하면 '로그인하고 싶어'라고 말씀하시고, 열린 화면에 직접 입력해 주세요."
            ),
            secretDetected=True,
        )

    async def _open_application(self, turn: Turn) -> dict:
        self._trace(turn, "PLANNING", AGENT_IDS.orchestrator, "Agent A: 신청서 열기, Agent B: 근거 안내")
        # S5: Agent B가 방금 근거를 찾아 답했다면, 그 근거와 목표 주소를 Agent A로 넘긴다(허용 도메인만).
        grounded = self._grounded
        self._grounded = None
        handoff: dict | None = None
        if grounded:
            target_url = self.web.profile.urls.apply
            official_url = grounded["sources"][0]["url"] if grounded["sources"] else None
            handoff = compact(
                {
                    "from": AGENT_IDS.welfare,
                    "to": AGENT_IDS.web,
                    "taskId": turn.id,
                    "goal": f"{grounded['servNm']} 모의 신청서 열기",
                    "targetUrl": target_url,
                    "sources": grounded["sources"],
                    "requiresApprovedDomain": True,
                    "domainApproved": self.web.is_approved_url(target_url),
                    "officialUrl": official_url,
                }
            )
            self._trace(turn, "PLANNING", AGENT_IDS.welfare, f"handoff → {AGENT_IDS.web} (approved={'true' if handoff['domainApproved'] else 'false'})")
            if not handoff["domainApproved"]:
                return draft(self.dialogue.state, "agent-handoff", "인계받은 신청 주소가 허용된 사이트가 아니라서 열지 않았습니다.", handoff=handoff)
        current = self.web.current_view
        from_external = (
            "이 사이트에서는 실제 신청을 대신하지 않아요. 연습용 신청서를 열게요." if current and current.get("pageId") == "external" else ""
        )
        out = await self.web.open_application(turn.ctx)
        if out.status != "ok" or not out.view:
            return outcome_failure(out, "IDLE")
        context = await self.deps.welfare.application_context()
        self.dialogue.drop_value_wait()
        # 같은 뜻을 두 번 말하지 않는다(외부 사이트 안내가 있으면 그것만).
        official_note = (
            "실제 신청 사이트 대신 연습용 신청서를 열게요."
            if not from_external and handoff and handoff.get("officialUrl") and not self.web.is_approved_url(handoff["officialUrl"])
            else ""
        )
        speech = " ".join(
            x
            for x in [
                from_external,
                official_note,
                "장애인연금 모의 신청서를 열었어요. 연습용이라 실제로 접수되지는 않아요.",
                self.narrator.describe_view(out.view),
                self.form.ask_next(out.view),
            ]
            if x
        )
        return draft(
            "APPLICATION_OPEN",
            "agent-handoff" if handoff else "navigate",
            speech,
            summary="모의 신청서를 열었어요.",
            actions=out.actions,
            view=out.view,
            handoff=handoff,
            sources=handoff["sources"] if handoff else context.sources,
        )

    async def _explain(self, mention: str | None, turn: Turn) -> dict:
        field_: FieldProfile | None = None
        if mention:
            r = self.web.resolve_field(mention)
            field_ = r.field if r.kind in ("ok", "not-visible") else (r.candidates[0] if r.kind == "ambiguous" else None)
        if not field_ and is_form_open(self.web.current_view):
            view = await self.web.observe(turn.ctx)
            visible = [f for f in view["fields"] if f.get("visible") and f["type"] != "checkbox"]
            current = next((f for f in visible if f["fieldId"] == self.form.last_field_id), None) or (visible[0] if visible else None)
            field_ = self.web.field(current["fieldId"]) if current else None
        if not field_:
            return draft(self.dialogue.state, "explain-field", "어떤 항목을 설명할지 알 수 없습니다. 항목 이름을 함께 말씀해 주세요.")
        self._trace(turn, "PLANNING", AGENT_IDS.welfare, f"glossary {field_.field_id}")
        answer = await self.deps.welfare.explain_field(field_.field_id, speak_label(field_.label))
        self.form.field_explained(field_.field_id)
        return draft(
            self.form.form_state() if is_form_open(self.web.current_view) else self.dialogue.state,
            "explain-field",
            answer.speech,
            field=field_.field_id,
            sources=answer.sources,
        )

    async def _approve(self, turn: Turn) -> dict:
        """
        승인 문. 물어볼 때 읽어 준 그대로(지문: 누를 대상·화면 주소·입력 칸 값)일 때만 실행한다. 다르면 승인을 버리고 무엇이 바뀌었는지 말한다.
        그대로라도 물은 지 2분이 지났으면 실행하지 않고 요약을 다시 읽어 새로 묻는다. 그대로이고 2분 안이면 다시 묻지 않는다.
        """
        approval = self.dialogue.approval
        if not approval:
            return draft(self.dialogue.state, "none", "지금 승인할 작업이 없습니다. 승인은 실행 직전에만 요청합니다.")
        kind = approval.get("kind")
        actions = approval.get("actions") or [approval["action"]]
        view = await self.web.observe(turn.ctx)
        now, changed = recheck(approval["fingerprint"], view, actions)
        if changed:
            self.dialogue.clear_approval()
            return draft(browse_state(view), "none", f"{changed} 그래서 {NOT_DONE[kind]} 바뀐 대로 하시려면 한 번 더 말씀해 주세요.", view=view)
        if self.dialogue.approval_age >= APPROVAL_TTL_S:
            self.dialogue.ask_approval({**approval, "fingerprint": now})
            return draft(
                "WAITING_FOR_USER_CONFIRMATION",
                "confirm-click" if kind == "click" else "prepare-submit",
                f"여쭤본 지 {APPROVAL_TTL_S // 60}분이 지나서 다시 여쭤볼게요. {now['speech']}",
                view=view,
                masked=True,
            )
        with turn.ctx.granted([a["id"] for a in actions]):
            if kind == "click":
                return await self.browse.click_approved(approval, turn.ctx)
            if kind == "assist":
                filled = await self.form.assist_approved(actions, turn.ctx)
                if approval.get("guided") and self.guided.active() and filled.get("semanticAction") == "fill":
                    return await self.guided.after_assist(filled, turn.ctx)
                return filled
            return await self.form.submit_approved(approval["action"], turn.ctx)

    async def _policy_question(self, topic: str, turn: Turn) -> dict:
        welfare = self.deps.welfare
        self._trace(turn, "PLANNING", AGENT_IDS.welfare, f"grounded answer ({welfare.answer_mode})")
        answer = await welfare.answer_question(topic)
        if answer.retrieval:
            self._trace(
                turn, "VERIFYING", AGENT_IDS.welfare, f"retrieved {','.join(answer.retrieval['sections'])} used={len(answer.retrieval['used'])}"
            )
        if answer.verification and not answer.verification["ok"]:
            self._trace(
                turn, "VERIFYING", AGENT_IDS.verifier, f"복지 답변 근거 부족 → 그 답은 말하지 않음: {', '.join(answer.verification['reasons'])}"
            )
        if answer.grounded and answer.service:
            self._grounded = {"servNm": answer.service["servNm"], "sources": answer.sources}
        # 신청 중에 물어봤다면 답한 뒤 하던 일로 돌아간다(티키타카).
        current = self.web.current_view
        resume = self.form.ask_next(current) if is_form_open(self.web.current_view) and current else ""
        return draft(self.dialogue.state, "welfare-retrieval", f"{answer.speech} 이어서 {resume}" if resume else answer.speech, sources=answer.sources)

    async def _unknown(self, text: str, turn: Turn) -> dict:
        if self.dialogue.clarification:
            names = ", ".join(speak_label(c.label) for c in self.dialogue.clarification["candidates"])
            return draft("NEEDS_CLARIFICATION", "clarify", f"{names} 중 어느 쪽인지 말씀해 주세요.")
        if rx(r"^(더|다른\s*(거|것|제도)|다음\s*(거|것))\s*(알려|말해|있어|보여)?").search(text) and self.deps.welfare.has_matches:
            return self._welfare_draft(self.deps.welfare.more_matches(), "discover")
        # "2번" / "2번 눌러줘": 방금 읽어 준 링크 목록에서 고르기
        numbered = rx(r"^(\d{1,2})\s*번").search(text)
        link = self.browse.listed_link(int(numbered.group(1)) - 1) if numbered else None
        if link is not None:
            return await self.browse.follow_link(link, turn.ctx)
        if self.dialogue.awaiting and is_form_open(self.web.current_view):
            # 값을 기다리는 중이라도 질문이면 값으로 넣지 않고 답한 뒤 다시 묻는다(티키타카).
            f = self.web.field(self.dialogue.awaiting)
            valid = bool(f) and (f.validate(clean_value(text)).ok if f.validate else True)  # type: ignore[union-attr]
            # 질문이 값보다 우선: "이 신청하면 언제 돈이 나와?"는 이름처럼 보여도 질문이다.
            if rx(r"(이거|이\s*항목|여기|이\s*칸)").search(text) and is_question_like(text):
                return await self._explain(None, turn)
            if is_question_like(text):
                return await (self._free_chat(text, turn) if self.deps.llm else self._explain(None, turn))
            if not valid and self.deps.llm:
                return await self._free_chat(text, turn)
            if f:
                return await self.form.fill_one(f, clean_value(text), turn.ctx)
        # 화면 밖 자유 대화: LLM이 있으면 종류를 골라 답하고, 없으면 질문일 때만 복지 근거 답변
        if self.deps.llm:
            return await self._free_chat(text, turn)
        if is_question_like(text):
            return await self._policy_question(text, turn)
        return draft(self.dialogue.state, "none", f"죄송해요, 잘 이해하지 못했어요. 아무것도 실행하지 않았어요. {HELP_POINTER}")


async def _ready(d: dict) -> dict:
    """동기로 만든 응답을 표의 다른 처리처럼 await할 수 있게"""
    return d


Route = Callable[[SessionOrchestrator, dict, Turn], Awaitable[dict]]

# 의도 종류 → 처리(동의 문을 지난 뒤). UNKNOWN은 표에 없고 _unknown이 받는다. 의도 표의 종류가 모두 있는지는 test_registry가 본다.
ROUTES: dict[str, Route] = {
    "START_APPLICATION": lambda s, i, t: s._start_application(t),
    "LOGIN": lambda s, i, t: s.browse.login(t.text, t.ctx),
    "CLEAR_LOGIN": lambda s, i, t: s.browse.clear_login(t.ctx),
    "READ_DOWNLOAD": lambda s, i, t: s.browse.read_download(i, t.ctx),
    "AUTH_DONE": lambda s, i, t: s.browse.auth_done(t.ctx),
    "FILL": lambda s, i, t: s.form.fill(i["fills"], t.ctx),
    "READ_FIELD": lambda s, i, t: s.form.read_field(i["fieldMention"], t.ctx),
    "EDIT_FIELD": lambda s, i, t: s.form.edit_field(i["fieldMention"], t.ctx),
    "NEXT": lambda s, i, t: s.form.next(t.ctx),
    "PREV": lambda s, i, t: s.form.prev(t.ctx) if is_form_open(s.web.current_view) else s.browse.back(t.ctx),
    "OPEN_SITE": lambda s, i, t: s.browse.open_site(i["target"], t.ctx),
    "FOLLOW_LINK": lambda s, i, t: s.browse.follow_link(i["name"], t.ctx),
    "READ_MAIN": lambda s, i, t: s.browse.read_main(i["more"], t.ctx),
    "LIST_LINKS": lambda s, i, t: s.browse.list_links(i["more"], t.ctx),
    "SEARCH": lambda s, i, t: s.browse.search(i["query"], i.get("site"), t.ctx),
    "REVIEW": lambda s, i, t: s.form.review(t.ctx),
    "EXPLAIN": lambda s, i, t: s._explain(i.get("fieldMention"), t),
    "PREPARE_SUBMIT": lambda s, i, t: s.form.prepare_submit(t.ctx),
    "APPROVE": lambda s, i, t: s._approve(t),
    "REJECT": lambda s, i, t: _ready(s.form.reject()),
    "RESUME": lambda s, i, t: s.browse.resume(t.ctx),
    "CURRENT_STEP": lambda s, i, t: s.browse.current_step(t.ctx),
    "DESCRIBE_SCREEN": lambda s, i, t: s.browse.screen(t.text, t.ctx),
    "ABOUT_SITE": lambda s, i, t: _ready(s.browse.about_site()),
    "REPHRASE": lambda s, i, t: s._rephrase(t),
    "GOAL": lambda s, i, t: s.browse.run_goal(i["goal"], t.ctx),
    "DISCOVER": lambda s, i, t: s._discover(t),
    "SERVICE_DETAIL": lambda s, i, t: s._welfare_reply(s.deps.welfare.service_detail(i.get("service")), "discover"),
    "PRECHECK": lambda s, i, t: s._welfare_reply(s.deps.welfare.precheck(i.get("service"), s._profile), "precheck"),
    "PREPARE_APPLY": lambda s, i, t: s._welfare_reply(s.deps.welfare.prepare(i.get("service")), "prepare-apply"),
    "OPEN_BROWSER": lambda s, i, t: s._open_browser(t),
    "POLICY_QUESTION": lambda s, i, t: s._policy_question(i["topic"], t),
    "HELP_HUMAN": lambda s, i, t: _ready(s._help_human()),
    "WHAT_CAN_I_SAY": lambda s, i, t: _ready(s._what_can_i_say(bool(i.get("more")))),
    "STOP": lambda s, i, t: _ready(draft("STOPPED", "stop", "멈췄습니다.")),
    # 보통은 handle_turn이 대기열 앞에서 답한다. 여기 오는 것은 여러 명령·질문 속의 물음뿐(대기열은 이 턴 자신이 잡고 있다).
    "PROGRESS": lambda s, i, t: _ready(s._progress_draft(busy=False)),
}
