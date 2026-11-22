"""
세션 단위 AI Orchestrator(공통 백엔드). 의도를 해석해 Agent A(웹 탐색·실행)와
Agent B(복지 정보·대화)에 일을 나누고, 공통 작업 상태(승인 대기, 되묻기, 중단)를 관리한다.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
import unicodedata
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable

from cheongeum.agents.web import ExecContext, FieldProfile, WebExecutionAgent, field_vocabulary
from cheongeum.agents.web.approval import recheck
from cheongeum.agents.web.link_choices import link_reference
from cheongeum.agents.web.skills.browse import BrowseSkill
from cheongeum.agents.web.skills.common import browse_state, help_human_draft, is_form_open, outcome_failure
from cheongeum.agents.web.skills.form import FormSkill
from cheongeum.agents.web.skills.guided import GuidedFill
from cheongeum.agents.welfare import WelfareInformationAgent, next_profile_slot, parse_profile_answer, profile_question
from cheongeum.agents.welfare.open_data import OpenData, PlaceFinder, PlaceReply
from cheongeum.core.choices import CHOICE_TURNS, choice_label
from cheongeum.core.dialogue import DialogueState
from cheongeum.agents.web.auth_page import still_needs_auth
from cheongeum.agents.welfare.agent import speak_answer_card
from cheongeum.core.intents import HelpGroup, help_pages
from cheongeum.core.jsutil import AbortController, AbortError, AbortSignal, compact, now_iso, nz, race_abort, rx, try_url, uuid
from cheongeum.core.lexicon import ack_kind, agree, approval, auth_input_done, cancel_reply, done_reply, foreign_approval, whole_rejection
from cheongeum.core.llm import SIMPLE_TEXT_SCHEMA
from cheongeum.core.progress import Progress
from cheongeum.core.turn import AGENT_IDS, draft, parse_turn_result
from cheongeum.understanding.sites import KNOWN_SITES, mentions_known_site, near_site_guess, public_service_site, service_topic, site_label
from cheongeum.language.i18n import FIXED, detect_lang_switch, detect_script_lang, translate_in, translate_out
from cheongeum.personal.commands import due_reminder, foreign_vault_save, parse_personal_command
from cheongeum.personal.dialogue import PersonalDialogue, vault_reply
from cheongeum.personal.guardian import GuardianDialogue, GuardianSender, PreviewSender, guardian_command
from cheongeum.personal.store import VAULT_LABELS, PersonalStore
from cheongeum.safety import REDACTED, SENSITIVE_LABELS_KO, SensitiveDetection, detect_sensitive, mask_value, redact_text, unsupported_numbers
from cheongeum.safety.privacy import redact_picture_text
from cheongeum.safety.gates import GateRefusal, consent_refusal, gate_refusal
from cheongeum.safety.guard import SECRET_LABEL
from cheongeum.speech.phrasing import has_phone_number, josa, speak_call_name, speak_label, spell_phone_numbers
from cheongeum.speech.screen import Narrator
from cheongeum.understanding.chat import chat_route
from cheongeum.understanding.fastpath import is_exact_command, picture_command_parts
from cheongeum.understanding.filters import is_question_like, strip_address, strip_filler, vague_question
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider, after_progress_question, clean_value, is_picture_request, is_progress_question, is_stop_utterance, wants_text_only_screen
from cheongeum.understanding.sites import resolve_site
from cheongeum.orchestrator.speech_repair import VOCAB, interpret_speech
from cheongeum.orchestrator import public_task
from cheongeum.orchestrator import task_review
from cheongeum.orchestrator.first_run import FirstRunGuide
from cheongeum.orchestrator.speech_repair import word_suggestions
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
    file_llm: Any = None
    vision_llm: Any = None
    recovery_llm: Any = None
    # 웹 검색 주소 틀({q} 자리에 검색어). 기본 네이버. 테스트는 로컬 포털 검색을 쓴다.
    search_url_template: str | None = None
    # False면 실제 사이트 모드: 연습(모의) 사이트를 기본으로 쓰지 않는다("연습"이라고 할 때만). 기본 True.
    practice_mode: bool = True
    initial_region: str = ""
    initial_language: str = "ko"
    initial_service: tuple[str, str] | None = None
    remember_service: Callable[[str, str], None] | None = None
    # 첫 실행 설정을 이어 갈 단계(SettingsStore.first_run, 끝났으면 None)와 진행을 적는 함수
    first_run_step: str | None = None
    first_run_progress: Callable[[str], None] | None = None
    recall_notes: Callable[[str], Awaitable[list[str]]] | None = None
    delegate_research: Callable[[str, str], Awaitable[bool]] | None = None
    # 개인 정보 금고·신청 기록 저장소(없으면 이번 대화 메모리에만)
    personal: PersonalStore | None = None
    # 암호화된 조작 기록(없으면 '오늘 한 일'은 비어 있다고 답함)
    action_log: Any = None
    guardian_sender: GuardianSender | None = field(default_factory=PreviewSender)
    # 승인을 물은 뒤 지난 시간을 재는 시계(초). 테스트가 세션을 만든 뒤 바꾸므로 부를 때마다 읽는다.
    clock: Callable[[], float] = time.monotonic
    places: PlaceFinder = field(default_factory=lambda: OpenData.empty().places)
    public_planning: bool = True
    quiet_search: Callable[[public_task.PublicTask, str, AbortSignal], Awaitable[dict]] | None = None


# 이 상태가 되면 여러 명령 실행을 멈추고 사용자에게 묻는다.
QUESTION_TYPES = {"POLICY_QUESTION", "PRECHECK", "PREPARE_APPLY", "SERVICE_DETAIL",
                  "ABOUT_SITE", "CURRENT_STEP", "DESCRIBE_SCREEN", "UNKNOWN"}
PLAN_STOP_STATES = {"NEEDS_CLARIFICATION", "VALIDATION_ERROR", "WAITING_FOR_USER_CONFIRMATION", "AUTH_HANDOFF", "STOPPED", "RECOVERING"}
# 승인을 물은 뒤 이만큼 지나 받은 승인은 실행하지 않고 요약을 다시 읽어 묻는다(주인 결정 2026-11-18)
APPROVAL_TTL_S = 120
# 검토 횟수, 전체 탐색 판단 횟수, 실제 브라우저 조작 횟수. 재시도와 승인 후 재개가 함께 사용한다.
REVIEW_LIMITS = {"easy": (2, 8, 8), "medium": (3, 16, 16), "hard": (5, 32, 32)}
_LIVE_DIFFICULTY = ContextVar("live_task_difficulty", default=None)


@dataclass
class ReviewedTask:
    request: str
    task: public_task.PublicTask
    requirements: tuple[str, ...]
    route: str
    difficulty: str
    rounds: int = 0
    browser_steps: int = 0
    counter: dict = field(default_factory=lambda: {"actions": 0})
    evidence: list = field(default_factory=list)
    sources: dict = field(default_factory=dict)
    attempted: set = field(default_factory=set)
    original_operations: set = field(default_factory=set)
    remaining: list = field(default_factory=list)
    private_values: list = field(default_factory=list)
    retries: set = field(default_factory=set)
    background: bool = False
# 승인을 받았지만 물어본 뒤 화면이 바뀌어 하지 않은 일(승인 대기 종류별)
NOT_DONE = {"click": "누르지 않았어요.", "assist": "넣지 않았어요.", "submit": "모의접수하지 않았어요."}


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
    from_voice: bool = False
    link_question: bool = False
    stale_link_offer: bool = False
    progress_reply: str = ""
    research_state: str = "incomplete"
    research_evidence: str = ""


NO_SECRET = SensitiveDetection(kinds=[], hasSecretValue=False)
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
            deps.web, self.dialogue, self.narrator, self.form, deps, self.progress,
            official_text=lambda url: deps.welfare.readable_service(url),
            application_guide_url=lambda name: deps.welfare.application_guide_url(
                name, ctpv=self._profile.get("ctpv"), sgg=self._profile.get("sgg")
            ),
            resolve_guide_target=lambda question, *, subject=None, site_url=None: deps.welfare.resolve_guide_target(
                question,
                subject=subject,
                site_url=site_url,
                ctpv=self._profile.get("ctpv"),
                sgg=self._profile.get("sgg"),
            ),
            resolve_site_link=lambda target: deps.welfare.resolve_site_link(
                target,
                ctpv=self._profile.get("ctpv"),
                sgg=self._profile.get("sgg"),
            ),
            planning_context=self._planning_context,
        )
        self._active_service = deps.initial_service
        self._public_task = public_task.PublicTask()
        self._review_question: tuple[public_task.PublicTask, ReviewedTask] | None = None
        self._auth_review: tuple[str, ReviewedTask] | None = None
        self._place_review = None
        self._next_models: dict = {}
        self._next_preferences: dict[str, str] = {}
        self._public_turns: deque[dict] = deque(maxlen=4)
        self._history: list[dict] = []
        self._lock = asyncio.Lock()
        self._epoch = 0
        self._controller = AbortController()
        self._approvals: set[str] = set()
        # 마지막 응답이 제안한 선택지: {'turnId', 'keys', 'handoffId', 'url'}. 다음 응답·멈춤·종료 때 바뀐다.
        self._offer: dict | None = None
        # 직전에 Agent B가 근거를 찾아 답한 서비스. 다음 신청 요청 때 Agent A로 인계한다.
        self._grounded: dict | None = None  # {'servNm', 'sources'}
        self._consent = "pending" if deps.require_consent else "granted"
        # 맞춤 복지 찾기: 이번 대화에서만 쓰는 사용자 정보
        self._profile: dict = {"ctpv": deps.initial_region} if deps.initial_region else {}
        self._personal = deps.personal or PersonalStore()
        self.guardian = GuardianDialogue(self._personal, self.dialogue, deps.guardian_sender)
        self.personal_dialogue = PersonalDialogue(
            self._personal, self.dialogue, on_speech=self._apply_speech, action_log=deps.action_log
        )
        self._apply_speech(self._personal.speech())
        self.first_run = FirstRunGuide(
            self.dialogue,
            step=deps.first_run_step,
            progress=deps.first_run_progress,
            lang=lambda: self._lang,
            call_name=lambda: self.call_name,
            remember=self.remember_call_name,
            is_command=lambda text: self._rules.parse_sync(text, IntentContext(state=self.dialogue.state))["type"] != "UNKNOWN",
        )
        # 직전 응답의 종류(되묻기를 연달아 하지 않으려고)
        self._last_semantic: str | None = None
        # 도움말 다음 쪽('다른 말도 알려줘'는 여기부터, 새로 물으면 처음부터)
        self._help_page = 0
        # 대화 언어. 한국어가 아니면 번역 계층을 거친다(i18n.py).
        self._lang = deps.initial_language
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
    def generation(self) -> int:
        return self._epoch

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
            if self.dialogue.auth_waiting and granted:
                return self._finish(turn, self.browse.auth_wait())
            self._consent = "granted" if granted else "declined"
            if (self.dialogue.approval or {}).get("kind") == "file":
                self.dialogue.clear_approval()
            if not granted:
                self._public_task = public_task.PublicTask()
                self._review_question = self._auth_review = self._place_review = None
                self.dialogue.finish_auth("cancelled")
                self.dialogue.take_vault_confirm()
                self.dialogue.clear_approval()
                return self._finish(turn, draft("IDLE", "consent", "알겠어요. 화면은 읽거나 조작하지 않고, 복지 제도 질문에만 답할게요."))
            if not self.web.current_view:
                await self.prepare()
            # 신청 기록에 기한이 가까운 것이 있으면 시작할 때 알린다(기능 5)
            due = self.reminders()
            hello = f"{speak_call_name(self.call_name)}, 반가워요." if self.call_name else "동의해 주셔서 감사합니다."
            # 첫 실행이면 시작 인사 뒤에 음성 단계(마이크 확인부터, 또는 끊긴 단계)를 묻는다
            setup = self.first_run.begin()
            tail = f" {setup}" if setup else (f" 알려 드릴 게 있어요. {due}" if due else "")
            return self._finish(turn, draft("IDLE", "consent", f"{hello} 시작할게요.{tail}"))

        return await self._enqueue(work)

    @property
    def speech_rate(self) -> float:
        return self._personal.speech()["rate"]

    @property
    def call_name(self) -> str | None:
        """청음이 부르는 이름: 개인 PC면 금고, 아니면 이번 대화(세션 메모리 금고)에만 있다."""
        return self._personal.call_name()

    def remember_call_name(self, name: str) -> bool:
        """부르는 이름을 기억한다. 이 PC에 저장했으면 True, 공용 PC라 이번 대화에서만 기억하면 False."""
        self._personal.set_call_name(name)
        self._redact_earlier_mentions((name,))
        return self.deps.personal is not None

    @property
    def link_offer_id(self) -> str:
        choices = self.browse.link_choices
        return choices.offer_id if choices else ""

    def _changed_link_reply(self) -> dict:
        choices = self.browse.link_choices
        if choices:
            choices.proposed = None
        return draft(self.state, "follow-link", "링크 선택지가 바뀌었어요. 현재 화면에서 원하는 번호나 이름을 다시 말씀해 주세요.",
                     offersLinks=bool(choices and choices.offer_id and choices.options))

    async def handle_turn(self, raw_text: str, *, approval_id: str | None = None, from_voice: bool = False,
                          link_offer_id: str | None = None, difficulty: str | None = None) -> dict:
        """발화를 정규화하고 비밀값과 대기 중인 결정을 로컬에서 확인한 뒤 처리한다."""
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
        asked_vault = self.dialogue.vault_confirm
        asked_action = self.dialogue.approval
        asked_handoff = self.dialogue.auth_handoff
        asked_task = self._public_task
        if link_offer_id is None:
            link_offer_id = self.link_offer_id
        if approval_id is None:
            approval_id = "" if from_voice else (self.dialogue.confirmation or {}).get("actionId", "")

        async def work() -> dict:
            links = self.browse.link_choices
            stale_link_offer = link_offer_id != self.link_offer_id
            if (stale_link_offer and not self.dialogue.has_pending_interaction and not self._public_task.question
                    and (link_reference(spoken, links) or agree(spoken))):
                return await self._localize(self._finish(self._begin_turn("[링크 확인]"), self._changed_link_reply()))
            if self._public_task is not asked_task and self._public_task.question and agree(spoken):
                return self._fixed_reply("[확인]", self._public_task.question, self._lang)
            if self.dialogue.auth_handoff is not asked_handoff and self.dialogue.auth_waiting:
                return self._fixed_reply("[확인]", "직접 확인할 작업이 바뀌었어요. 새 안내를 확인해 주세요.", "ko")
            current_id = (self.dialogue.confirmation or {}).get("actionId", "")
            current = self.dialogue.vault_confirm
            if current and current.get("confirmation"):
                decision = vault_reply(spoken, current["kind"], self._lang)
                if decision is not None:
                    if current is not asked_vault or approval_id != current_id:
                        return self._fixed_reply("[확인]", FIXED["changedApproval"][self._lang], self._lang)
                    return await self._process(spoken, sensitive, {"type": "APPROVE" if decision else "REJECT"}, from_voice=from_voice)
            elif self.dialogue.approval is not asked_action or approval_id != current_id:
                parsed = self._rules.parse_sync(spoken, IntentContext(state="WAITING_FOR_USER_CONFIRMATION"))
                if parsed["type"] in ("APPROVE", "REJECT") or foreign_approval(spoken, self._lang):
                    return self._fixed_reply("[확인]", FIXED["changedApproval"][self._lang], self._lang)
            if current is not asked_vault and current and current["kind"].startswith("guardian-"):
                if approval(spoken) == "approve" or foreign_approval(spoken, self._lang) == "approve":
                    return self._fixed_reply("[확인]", "방금 읽어 드린 보호자 요청을 확인한 뒤 다시 말씀해 주세요.", "ko")
            hint = self._secret_hint
            self._secret_hint = not sensitive.hasSecretValue and any(k in ("password", "otp") for k in sensitive.kinds)
            if not sensitive.hasSecretValue and not self.dialogue.auth_waiting and self._maybe_spoken_secret(spoken, hint):
                turn = self._begin_turn(REDACTED)
                turn.intentType = "SECRET_DISCLOSURE"
                return self._finish(turn, self._possible_secret())
            if self.dialogue.first_run:
                guided = await self._first_run_turn(spoken, sensitive, from_voice)
                if guided is not None:
                    return guided
            return await self._process(spoken, sensitive, from_voice=from_voice, stale_link_offer=stale_link_offer)

        # 요청마다 격리한다. 기다리는 다음 발화나 동시에 온 중단 요청에 난이도가 섞이지 않는다.
        token = _LIVE_DIFFICULTY.set(difficulty if from_voice and difficulty in REVIEW_LIMITS else None)
        try:
            return await self._enqueue(work)
        finally:
            _LIVE_DIFFICULTY.reset(token)

    async def _first_run_turn(self, spoken: str, sensitive: SensitiveDetection, from_voice: bool) -> dict | None:
        """첫 실행 3단계의 대답. 다른 명령이면 None(평소처럼 처리)."""
        asked = self.dialogue.first_run
        reply = self.first_run.answer(spoken)
        if reply is None:
            return None
        if reply == "practice":
            # 연습 사이트는 장애인연금 모의 신청서다(연습이라고 말한 것과 같은 길)
            return await self._process("장애인연금 연습 신청서 열어줘", sensitive, {"type": "START_APPLICATION"}, from_voice=from_voice)
        # 이름을 말한 차례는 기록에 남기지 않는다(LLM에 가는 최근 대화에 들어가므로)
        turn = self._begin_turn(REDACTED if asked in ("name", "name-confirm") else spoken)
        turn.intentType = "FIRST_RUN"
        return self._finish(turn, {**reply, "lang": self._lang})

    async def set_language(self, lang: str) -> dict:
        """UI의 언어 선택. 음성 "영어로 말해줘"와 같은 경로."""

        async def work() -> dict:
            return self._switch_language("[언어 선택]", lang)

        return await self._enqueue(work)

    async def confirm(self, approve: bool, action_id: str | None = None) -> dict:
        """버튼과 음성은 같은 승인 문을 사용한다."""
        asked = self.dialogue.confirmation

        async def work() -> dict:
            pending = self.dialogue.confirmation or {}
            if self.dialogue.confirmation is not asked or (action_id is not None and pending.get("actionId", "") != action_id):
                return self._fixed_reply("[확인 버튼]", FIXED["changedApproval"][self._lang], self._lang)
            return await self._process("[승인 버튼]" if approve else "[거절 버튼]", NO_SECRET, {"type": "APPROVE" if approve else "REJECT"})

        return await self._enqueue(work)

    async def choose(self, turn_id: str, key: str, handoff_id: str | None) -> dict | None:
        """
        제안한 선택지 고르기(아바타·대화 창 버튼). 그 제안을 낸 응답·인계 번호·화면이 지금도 같을 때만
        말로 한 것과 같은 길로 실행한다. 확인과 실행은 같은 대기열 차례 안에서. 지난 제안이면 None(아무것도 하지 않음).
        """

        async def work() -> dict | None:
            offer = self._offer
            if not offer or offer["turnId"] != turn_id or key not in offer["keys"] or offer.get("handoffId") != handoff_id:
                return None
            handoff = self.dialogue.auth_handoff
            if handoff_id and not (self.dialogue.auth_waiting and handoff and handoff.id == handoff_id):
                return None
            if offer.get("url"):
                check = self._begin_turn("[선택지 화면 확인]")
                try:
                    view = await self.web.observe(check.ctx)
                except Exception:  # noqa: BLE001
                    return None
                if view.get("url") != offer["url"]:
                    return None
            self._offer = None
            text, intent = CHOICE_TURNS[key]
            return await self._process(text or choice_label(key, "ko", offer.get("authKind")), NO_SECRET, dict(intent))

        return await self._enqueue(work)

    def _offer_for(self, turn: Turn, state: str, draft: dict, view: dict | None) -> dict | None:
        """이 응답 뒤에 버튼으로 고를 수 있는 것. 승인을 기다리면 승인 카드가 맡으므로 내지 않는다."""
        if self.dialogue.approval or state == "STOPPED":
            return None
        handoff = self.dialogue.auth_handoff
        if self.dialogue.auth_waiting and handoff:
            return {"turnId": turn.id, "keys": ["auth-done", "auth-cancel"], "handoffId": handoff.id, "authKind": handoff.kind}
        if state == "BROWSING" and draft["semanticAction"] in ("open-site", "follow-link", "back") and view and view.get("url"):
            return {"turnId": turn.id, "keys": ["read-main"], "url": view["url"]}
        return None

    def cancel(self) -> dict:
        return self._stop("[멈춤 버튼]")

    async def wake(self, stop_generation: int) -> str | None:
        """Accept a new input after this particular Stop. Never replay the cancelled task."""
        async with self._lock:
            if self._epoch != stop_generation:
                return None
            if self.state == "STOPPED":
                self.dialogue.commit("IDLE")
            return self.state

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
                "stopGeneration": self._epoch if self.state == "STOPPED" else None,
                "platform": "pc",
                "observation": self._summarize(self.web.current_view),
                "pendingConfirmation": self.dialogue.confirmation,
                "awaitingField": self.dialogue.awaiting,
                "history": list(self._history),
                "mockOnly": not self.web.guard.config.readOnlyWeb and
                    all(origin == self.web.profile.origin for origin in self.web.guard.config.allowedOrigins),
                "speechPrefs": self._personal.speech(),
            }
        )

    def _apply_speech(self, prefs: dict) -> None:
        """말하기 설정 → 진행 알림 on/off. 속도·목소리는 TurnResult.speechPrefs로 UI가 반영한다."""
        self.progress.spoken = bool(prefs.get("progressSpoken", True))

    def export_history(self) -> list[dict]:
        return list(self._history)

    def recent_voice_dialogue(self) -> list[dict[str, str]]:
        """Bound the startup context and filter it again before sending it to Live."""
        history = []
        # Leave room in Live's startup context for message framing.
        remaining_bytes = 6400
        for message in reversed(self._history[-32:]):
            text = redact_picture_text(self._history_speech(message["text"])).strip()
            if not text:
                continue
            excerpt = text.encode("utf-8", errors="replace")[:800]
            if len(excerpt) > remaining_bytes:
                break
            history.append({"role": message["role"], "text": excerpt.decode("utf-8", errors="ignore")})
            remaining_bytes -= len(excerpt)
        return list(reversed(history))

    def reminders(self) -> str | None:
        """기한이 3일 이내인 신청 알림(없으면 None). 시작할 때와 주기적으로 쓴다."""
        return due_reminder(self._personal.applications())

    def detach_for_recovery(self) -> dict:
        """현재 작업은 멈추고, 재접속에는 값 없는 단계만 남긴다."""
        pending_kind = (self.dialogue.confirmation or {}).get("kind")
        state = self.dialogue.state
        view = self.web.current_view
        self._epoch += 1
        self._controller.abort()
        self._controller = AbortController()
        self._approvals.clear()
        self._offer = None
        self.dialogue.stop(preserve_auth=True)
        self.browse.link_choices = None
        self.guardian.take_pending()
        self._history.clear()
        self._public_turns.clear()
        self._active_service = None
        self._public_task = public_task.PublicTask()
        self._profile = {}
        self._grounded = None
        self._secret_hint = False
        self._secret_guarded = None
        if state == "WAITING_FOR_USER_CONFIRMATION":
            self.dialogue.commit(browse_state(view) if view else "IDLE")
        return compact({
            "state": self.state, "lang": self.lang, "consent": self.consent_status,
            "stopGeneration": self._epoch if self.state == "STOPPED" else None,
            "approvalKind": pending_kind, "progressSeq": self.progress.snapshot()["seq"],
            "step": ((view or {}).get("step") or {}).get("index"),
        })

    async def resume_for_recovery(self, checkpoint: dict) -> dict:
        async def work() -> dict:
            turn = self._begin_turn("[작업 재연결]")
            if self.consent_status == "granted" and self.web.current_view:
                try:
                    view = await self.web.observe(turn.ctx)
                except Exception:  # noqa: BLE001
                    return {"interrupted": True}
                if self.state != "STOPPED":
                    self.dialogue.commit("AUTH_HANDOFF" if self.dialogue.auth_waiting else browse_state(view))
            return {**checkpoint, "state": self.state,
                    **({"stopGeneration": self._epoch} if self.state == "STOPPED" else {}),
                    "authHandoff": self.dialogue.auth_handoff.public() if self.dialogue.auth_waiting else None}

        return await self._enqueue(work)

    async def close(self) -> None:
        self._public_task = public_task.PublicTask()
        self._epoch += 1
        self._controller.abort()
        self._offer = None
        self.dialogue.stop()
        await self.web.close()

    # ---------------------------------------------------------------- 큐·중단

    def stage_settings(self, models: dict, *, language: str | None, region: str | None) -> None:
        self._next_models = models
        if language is not None:
            self._next_preferences["language"] = language
        if region is not None:
            self._next_preferences["region"] = region

    async def _enqueue(self, fn: Callable[[], Awaitable[dict]]) -> dict:
        epoch = self._epoch
        async with self._lock:
            if epoch != self._epoch:
                return self._voided()
            if self._next_models:
                for role, model in self._next_models.items():
                    setattr(self.deps, role, model)
                self.deps.welfare.llm = self.deps.web_llm
                self._next_models.clear()
                self._lang = self._next_preferences.pop("language", self._lang)
                if "region" in self._next_preferences:
                    self._profile["ctpv"] = self._next_preferences.pop("region")
            return await fn()

    def _voided(self) -> dict:
        turn = self._begin_turn("[중단으로 취소된 요청]")
        return self._finish(turn, draft("STOPPED", "none", "중단 요청 때문에 이 요청은 실행하지 않았습니다."))

    def _stop(self, text: str) -> dict:
        self._review_question = self._auth_review = self._place_review = None
        self.browse.link_choices = None
        self._public_task = public_task.PublicTask()
        busy = self._lock.locked()
        # 멈추기 전에 이미 바뀐 화면은 되돌리지 않고(멈춘 뒤의 조작이 되므로) 바뀌었다는 사실을 바로 말한다(주인 결정 2026-11-19)
        moved = busy and self.web.moved_since_last_view()
        self._epoch += 1
        self._controller.abort()
        self._controller = AbortController()
        dropped = self._dropped_on_stop() if self._lang == "ko" else ""
        private_readback = self._history_speech(dropped) != dropped
        praise = self.first_run.after_stop()
        self.dialogue.stop()
        self._approvals.clear()
        turn = self._begin_turn(text)
        turn.intentType = "STOP"
        self._trace(turn, "INTENT_DETECTED", AGENT_IDS.orchestrator, "STOP (규칙 즉시 판정)")
        if praise:
            # 첫 실행의 '멈춰' 연습: 칭찬하고 소개를 들을지 묻는다(dialogue.stop()이 지운 뒤 다시 세운다)
            self.first_run.praised()
            return self._finish(turn, draft("STOPPED", "stop", praise, lang=self._lang))
        stopped = FIXED["stopBusy" if busy else "stop"][self._lang]
        if moved:
            # "하던 일을 멈췄습니다. [화면이 바뀌었어요.] 이어서 하려면 …"
            first, *rest = rx(r"(?<=[.。])\s*").split(stopped, maxsplit=1)
            stopped = " ".join([first, FIXED["stopMoved"][self._lang], *rest])
        speech = f"{stopped} {dropped}".strip()
        return self._finish(turn, draft("STOPPED", "stop", speech, lang=self._lang, privateHistory=private_readback))

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
        if (d.approval or {}).get("kind") == "file":
            notes.append("승인 대기 중인 파일을 보내지 않았어요.")
        elif d.approval:
            notes.append("승인을 기다리던 일은 하지 않았어요.")
        pending = d.vault_confirm
        if pending and pending["kind"] == "vault-save":
            listed = ", ".join(f"{VAULT_LABELS[k]} {v}" for k, v in pending["values"].items())
            notes.append(f"저장하려던 {josa(listed, '은', '는')} 저장하지 않았어요.")
        elif pending and pending["kind"].startswith("guardian-"):
            notes.append("보호자 요청을 취소했어요.")
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
            session_id=self.id,
            task_id=turn.id,
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

    async def _process(self, text: str, sensitive: SensitiveDetection, forced: dict | None = None, *,
                       from_voice: bool = False, stale_link_offer: bool = False) -> dict:
        """
        한 턴: 언어 바꾸기 명령 → (외국어면) 한국어로 옮겨 기존 흐름 → 응답을 사용자 언어로.
        승인 대기 중에는 번역 결과가 '승인'으로 읽혀도 원문이 언어별 승인 단어가 아니면 받지 않는다.
        """
        if (not forced and (self.dialogue.expects_confirmation or self.dialogue.vault_confirm)
                and approval(text, self._lang) != "approve"
                and any(approval(text, lang) == "approve" for lang in ("ko", "en", "ja", "zh") if lang != self._lang)):
            return self._fixed_reply("[확인]", FIXED["approveHint"][self._lang], self._lang)
        if self.dialogue.auth_waiting:
            # '영어로 말해줘' 같은 언어 바꾸기는 규칙으로만 알아듣는 짧은 명령이라 비밀값일 수 없다: 인증 대기 중에도 받는다
            switch_to = None if forced else detect_lang_switch(text)
            if switch_to:
                return self._switch_language(text, switch_to)
            return await self._process_korean(text, sensitive, forced)
        if forced:
            return await self._localize(await self._process_korean(text, sensitive, forced))
        # 비밀값은 번역(외부 LLM)에 넘기기 전에 막는다: 어느 언어든 바로 경고만 한다
        if sensitive.hasSecretValue:
            self.guardian.take_pending()
            return await self._localize(await self._process_korean(text, sensitive))
        if guardian_command(text):
            return await self._process_korean(text, sensitive)
        if local_save := foreign_vault_save(text):
            source_lang, values = local_save
            if self.deps.llm:
                self._lang = source_lang
            # Existing dialog and consent gates see a local command; only the vault receives the literal fields.
            result = await self._process_korean("내 정보 저장해줘", sensitive, original=text, from_voice=from_voice,
                                                vault_values={} if sensitive.kinds else values)
            return await self._localize(result)
        switch_to = detect_lang_switch(text)
        if switch_to:
            return self._switch_language(text, switch_to)
        # 글자가 분명히 다른 언어면 그 언어로 바꾼다(텍스트 입력, 또는 그 언어로 받아쓴 경우)
        script = detect_script_lang(text)
        if self._public_task.question and text.strip(" .!?。") in self._public_task.choices:
            script = None
        if script and script != self._lang and (script == "ko" or self.deps.llm):
            self._lang = script
        lang = self._lang
        if (lang == "ko" or script == "ko" or not self.deps.llm
                or (rx(r"[가-힣]").search(text) and (parse_personal_command(text) or {}).get("kind") == "vault-save")):
            return await self._process_korean(text, sensitive, from_voice=from_voice, stale_link_offer=stale_link_offer)

        if self.link_offer_id and not self.dialogue.has_pending_interaction and not self._public_task.question and agree(text):
            return await self._localize(await self._process_korean(text, sensitive, from_voice=from_voice, stale_link_offer=stale_link_offer))

        # 외국어 공공업무는 원문에서 바로 판단한다. 별도 입력 번역으로 기관·부정·요구사항을 잃지 않는다.
        if self._can_plan_public(text, sensitive) and not self._secret_hint:
            turn = self._begin_turn(text)
            turn.from_voice = from_voice
            planned = await self._plan_public(text, turn)
            if planned is not None:
                return await self._localize(planned)

        awaiting_approval = self.dialogue.expects_confirmation
        confirmation = foreign_approval(text, lang)
        # Vault replies were already checked in full against the original utterance at intake.
        if awaiting_approval and confirmation and not (self.dialogue.vault_confirm or {}).get("confirmation"):
            korean = "승인" if confirmation == "approve" else "거절"
        else:
            translated = await translate_in(self.deps.web_llm or self.deps.llm, text, lang, self._controller.signal)
            if not translated:
                return self._fixed_reply(text, FIXED["retry"][lang], lang)
            if awaiting_approval and (await self._rules.parse(translated, IntentContext(state=self.dialogue.state)))["type"] == "APPROVE":
                return self._fixed_reply(text, FIXED["approveHint"][lang], lang)
            korean = translated
        result = await self._process_korean(korean, sensitive, None, text, from_voice=from_voice, stale_link_offer=stale_link_offer)
        return await self._localize(result)

    # ---------------------------------------------------------------- 한국어 흐름

    def _short_reply(self, text: str) -> dict | None:
        """맞장구("알았어")·부정("아니")만 한 말에 대한 짧은 응답. 해당하지 않으면 None."""
        kind = ack_kind(text)
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

    def _fixed_reply(self, text: str, speech: str, lang: str) -> dict:
        turn = self._begin_turn(text)
        turn.intentType = "CLARIFY"
        return self._finish(turn, draft(self.dialogue.state, "clarify", speech, lang=lang))

    def _switch_language(self, text: str, to: str) -> dict:
        self.guardian.take_pending()
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
        if lang == "ko" or r.get("lang") == lang or not self.deps.llm or r.get("localSpeechOnly"):
            return r
        t0 = time.monotonic()
        epoch = self._epoch
        card = r.get("answerCard")
        localized = None
        translator = self.deps.web_llm or self.deps.llm
        subject = self._public_task.subject if r.get("sources") and r["intentType"] in ("GOAL", "POLICY_QUESTION") else ""
        try:
            if card:
                translated = {}
                for field in ("answer", "nextAction"):
                    sentence = await translate_out(translator, card[field], lang, self._controller.signal, verified=True,
                                                   subject=card.get("serviceName") or subject, reviewer=self.deps.llm)
                    if not sentence:
                        break
                    translated[field] = sentence
                if len(translated) == 2:
                    localized = {**card, **translated}
                out = speak_answer_card(localized, lang) if localized else None
            else:
                out = await translate_out(translator, r["speech"], lang, self._controller.signal, verified=bool(r.get("sources")),
                                          subject=subject, reviewer=self.deps.llm)
        except Exception:  # noqa: BLE001
            out = None
        if epoch != self._epoch:
            return {**r, "speech": FIXED["stopBusy"][lang], "state": "STOPPED", "stopGeneration": self._epoch,
                    "lang": lang, "offeredChoices": []}
        last_at = r["trace"][-1]["atMs"] if r["trace"] else 0
        return {
            **r,
            **({"answerCard": localized} if localized and out else {}),
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

    async def _guardian_turn(self, text: str, turn: Turn, forced: dict | None) -> dict | None:
        pending = self.guardian.take_pending()
        if pending:
            word = text.strip().rstrip(".!。")
            approved = approval(text) == "approve" and (
                turn.original is None or foreign_approval(turn.original, self._lang) == "approve"
            )
            if approved or forced or word in ("아니", "아니요", "아뇨", "거절", "취소"):
                turn.intentType = "GUARDIAN_CONFIRM"
                refused = self._gate([{"type": turn.intentType}])
                if refused:
                    return self._finish(turn, refused)
                if not approved:
                    return self._finish(turn, draft(pending["resume"], "none", "보호자 요청을 취소했어요."))
                view = await self.web.observe(turn.ctx) if pending["kind"] == "guardian-send" else None
                if turn.ctx.signal.aborted:
                    return self._voided()
                result = await self.guardian.approved(pending, view, self.deps.clock(), APPROVAL_TTL_S)
                return self._finish(turn, result)
        cmd = guardian_command(text) if not forced else None
        if cmd:
            turn.intentType = "GUARDIAN_CONTACT"
            turn.text, turn.original = REDACTED, None
            refused = self._gate([{"type": turn.intentType}])
            if refused:
                return self._finish(turn, refused)
            resume = self.dialogue.state
            if resume == "WAITING_FOR_USER_CONFIRMATION":
                resume = browse_state(self.web.current_view) if self.web.current_view else "IDLE"
            self.dialogue.take_vault_confirm()
            self.dialogue.clear_approval()
            view = await self.web.observe(turn.ctx) if cmd["kind"] == "guardian-send" and self._personal.guardian() else None
            if turn.ctx.signal.aborted:
                return self._voided()
            return self._finish(turn, self.guardian.ask(cmd, view, self.deps.clock(), resume))
        return None

    async def _process_korean(self, text: str, sensitive: SensitiveDetection, forced: dict | None = None, original: str | None = None,
                              *, from_voice: bool = False, vault_values: dict | None = None, stale_link_offer: bool = False) -> dict:
        turn = self._begin_turn(text)
        turn.original = original
        turn.from_voice = from_voice
        turn.stale_link_offer = stale_link_offer
        self._trace(turn, "TRANSCRIBED", AGENT_IDS.orchestrator,
                    "기기 내 금고 요청" if vault_values is not None else (f"번역 {self._lang}→ko" if original else None))
        try:
            if sensitive.hasSecretValue:
                turn.intentType = "SECRET_DISCLOSURE"
                return self._finish(turn, self._handle_secret(sensitive))
            if self.dialogue.auth_waiting:
                return self._finish(turn, await self._auth_turn(turn, forced))
            if not forced and not sensitive.kinds:
                request = after_progress_question(text)
                if request:
                    turn.progress_reply = self._progress_draft(busy=False)["speech"]
                    # A reply to an outstanding question must be checked against the entire utterance.
                    if not self.dialogue.has_pending_interaction and not self._public_task.question:
                        text = request
            ask = self.dialogue.take_place_ask()
            place_review, self._place_review = self._place_review, None
            if ask and not forced:
                parsed = self._rules.parse_sync(text, IntentContext(state=self.dialogue.state))
                if parsed["type"] == "UNKNOWN":
                    reply = self.deps.places.follow_up(ask, text, lang=self._lang)
                    if reply is not None:
                        turn.intentType = "FIND_PLACE"
                        result = self._gate([{"type": "FIND_PLACE"}]) or self._place_reply(reply)
                        if place_review and place_review[0] is ask:
                            result = await self._review_task(place_review[1], turn, resumed=result)
                        return self._finish(turn, result)
            guess = self.dialogue.take_site_guess()
            if guess and not forced:
                answer = rx(r"[.!~\s]+$").sub("", text)
                if options := guess.get("options"):
                    choice = rx(r"(?:제)?([12])\s*번(?:이요|요)?|(?:첫|두)\s*번째(?:요)?").fullmatch(answer)
                    if choice:
                        idx = int(choice[1]) - 1 if choice[1] else int(answer.startswith("두"))
                        text = turn.text = options[idx]["text"]
                    elif agree(answer) == "yes":
                        self.dialogue.ask_site(guess)
                        turn.intentType = "CLARIFY"
                        return self._finish(turn, draft(self.dialogue.state, "clarify", guess["prompt"],
                                                        publicSuggestions=[o["label"] for o in options]))
                    elif agree(answer) == "no":
                        turn.intentType = "CLARIFY"
                        return self._finish(turn, draft(self.dialogue.state, "clarify", "찾으시는 업무나 기관 이름을 말씀해 주세요."))
                    else:
                        name = rx(r"(?:이요|요|입니다)$").sub("", answer)
                        matches = [o for o in options if name and name in o["label"]]
                        if len(matches) == 1:
                            text = turn.text = matches[0]["text"]
                elif agree(answer) == "yes":
                    text = turn.text = guess["text"]
                elif agree(answer) == "no":
                    turn.intentType = "CLARIFY"
                    if guess.get("heard"):
                        return self._finish(turn, draft(self.dialogue.state, "clarify", "알겠어요. 찾으시는 업무나 기관 이름을 말씀해 주세요."))
                    return self._finish(turn, draft(
                        self.dialogue.state,
                        "clarify",
                        f"알겠어요. {josa(guess['label'], '으로', '로')} 가지 않을게요. 어느 사이트인지, 또는 무엇을 도와드릴지 다시 말씀해 주세요.",
                    ))
            if not forced and (self.dialogue.approval or {}).get("kind") in ("file", "visual", "research"):
                if approval(text) == "approve" and (original is None or foreign_approval(original, self._lang) == "approve"):
                    forced = {"type": "APPROVE"}
                elif rx(r"(아니|아니요|아뇨|거절|취소|보내지\s*마)[.!。]*").fullmatch(text):
                    forced = {"type": "REJECT"}
                else:
                    self.dialogue.clear_approval()
                    self.dialogue.commit(browse_state(self.web.current_view) if self.web.current_view else "IDLE")
            guardian = await self._guardian_turn(text, turn, forced)
            if guardian is not None:
                return guardian
            if self.dialogue.vault_confirm:
                if forced and forced["type"] in ("APPROVE", "REJECT"):
                    turn.intentType = "VAULT_CONFIRM"
                    refused = self._gate([{"type": turn.intentType}])
                    return self._finish(turn, refused or self.personal_dialogue.confirm(forced["type"] == "APPROVE"))
                self.dialogue.take_vault_confirm()
                if self.state == "WAITING_FOR_USER_CONFIRMATION":
                    self.dialogue.commit(browse_state(self.web.current_view) if self.web.current_view else "IDLE")
            # 맞춤 복지 질문에 대한 답이면 이어서 진행(다른 명령이면 질문을 접고 그 명령을 처리)
            if not forced and self.dialogue.profile_question:
                asked = self.dialogue.profile_question
                other = self._rules.parse_sync(text, IntentContext(state=self.dialogue.state))
                answer = parse_profile_answer(text, asked, self._profile) if other["type"] not in ("FIND_PLACE", "OPEN_SITE", "GOAL") else None
                if answer:
                    turn.intentType = "PROFILE_ANSWER"
                    self._profile = {**self._profile, **answer}
                    return self._finish(turn, await self._discover_step(turn, False))
                # 대답을 못 알아들었고 다른 명령도 아니면, 처음부터 다시 묻지 말고 그 질문만 짧게 다시 묻는다
                looks_like_answer = len(text) <= 20 and not rx(r"(줘|주세요|알려|열어|도움|뭐야|어떻게|멈춰|그만)").search(text)
                if other["type"] == "UNKNOWN" and looks_like_answer and not parse_personal_command(text) and not detect_lang_switch(text):
                    turn.intentType = "PROFILE_ANSWER"
                    return self._finish(turn, draft(self.dialogue.state, "discover", f"제가 잘 못 알아들었어요. {profile_question(asked, self._profile)}"))
                self.dialogue.profile_done()
            if not forced:
                # 라벨(intentType)은 await 전에 적는다. 그 안에서 예외가 나면 RECOVERING 결과가 이 라벨을 보고한다.
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
                cmd = {"kind": "vault-save", "values": vault_values} if vault_values is not None else parse_personal_command(text)
                if cmd:
                    turn.intentType = f"PERSONAL_{cmd['kind'].upper().replace('-', '_', 1)}"
                    if cmd["kind"] == "vault-save":
                        self._redact_earlier_mentions(tuple(cmd["values"].values()))
                    refused = self._gate([{"type": turn.intentType}])
                    if refused:
                        return self._finish(turn, refused)
                    done = self.personal_dialogue.run(cmd, lang=self._lang)
                    if done:
                        return self._finish(turn, done)
                if not guess and not sensitive.kinds and not self.dialogue.has_pending_interaction and not self._public_task.question:
                    reference = link_reference(text, self.browse.link_choices)
                    if reference:
                        if turn.stale_link_offer:
                            return self._finish(turn, self._changed_link_reply())
                        turn.intentType = "FOLLOW_LINK" if reference.action == "open" else "LIST_LINKS"
                        refused = self._gate([{"type": turn.intentType}])
                        if refused:
                            return self._finish(turn, refused)
                        if reference.action == "question":
                            turn.link_question = True
                            understood = await race_abort(self._understand(text, turn), turn.ctx.signal)
                            intents = understood.intents
                            if any(i["type"] not in {"UNKNOWN", "ABOUT_SITE", "CURRENT_STEP", "DESCRIBE_SCREEN", "READ_MAIN"} for i in intents):
                                intents = [{"type": "UNKNOWN", "text": text}]
                            return self._finish(turn, await self._run_plan(intents, turn))
                        before = self.web.current_view
                        result = await race_abort(self.browse.choose_link(reference, text, turn.ctx, redact=self._history_speech), turn.ctx.signal)
                        return self._finish(turn, await self.browse.recognize_auth_page(result, before, turn.ctx))
                if not guess and original is None and self._can_plan_public(text, sensitive):
                    planned = await self._plan_public(text, turn)
                    if planned is not None:
                        return planned
                # "알았어", "아니" 같은 짧은 대답은 명령이 아니다: 입력값으로 넣거나 다음으로 넘어가지 않는다.
                short = self._short_reply(text)
                if short:
                    turn.intentType = "ACK"
                    return self._finish(turn, short)
                # "알았고 다음으로 가줘", "아니 네이버 말고 다음 열어줘": 앞의 맞장구·군말은 떼고 본다
                if not self.deps.llm and not self.dialogue.approval:
                    text = strip_filler(text)
                if (from_voice and not guess and not sensitive.kinds and self._consent == "granted"
                        and self.dialogue.state in ("IDLE", "BROWSING", "NEEDS_CLARIFICATION")
                        and not self.dialogue.awaiting and not self.dialogue.approval and not self.dialogue.clarification):
                    context = IntentContext(state=self.dialogue.state)
                    def parse(phrase: str) -> str:
                        return self._rules.parse_sync(phrase, context)["type"]
                    if not self._public_followup(text):
                        options, clear = await interpret_speech(text, parse(text), self._planning_context(text, None),
                                                               self.deps.llm, turn.ctx.signal, parse)
                        if turn.ctx.signal.aborted:
                            return self._finish(turn, draft("STOPPED", "stop", "멈췄어요."))
                        if clear:
                            text = turn.text = options[0].text
                        elif options:
                            option = options[0]
                            if len(options) == 1:
                                prompt = f"'{option.text}'라는 뜻인가요?"
                                self.dialogue.ask_site({"heard": True, "label": option.label, "text": option.text})
                            else:
                                prompt = f"1번 {option.label}, 2번 {options[1].label} 중 어떤 업무를 찾으세요?"
                                self.dialogue.ask_site({"options": [vars(o) for o in options], "prompt": prompt})
                            turn.intentType = "CLARIFY"
                            return self._finish(turn, draft(self.dialogue.state, "clarify", prompt,
                                                            publicSuggestions=[o.label for o in options]))
            # 승인을 기다리는 중의 "눌러", "진행해"는 두루뭉술한 말이 아니라 승인이다.
            vague = None if forced or self.dialogue.approval else vague_question(text)
            if vague:
                turn.intentType = "CLARIFY"
                return self._finish(turn, draft(self.dialogue.state, "clarify", vague))
            understood = Understood([forced], "ui") if forced else await race_abort(self._understand(text, turn), turn.ctx.signal)
            if turn.ctx.signal.aborted:
                return self._voided()
            intents = understood.intents
            if (not forced and any(i["type"] == "APPROVE" for i in intents)
                    and approval(original or turn.text, self._lang) != "approve"):
                return self._finish(turn, draft(self.dialogue.state, "clarify", FIXED["approveHint"][self._lang]))
            intent = intents[0]
            turn.intentType = f"PLAN({'>'.join(i['type'] for i in intents)})" if len(intents) > 1 else intent["type"]
            self._trace(turn, "INTENT_DETECTED", AGENT_IDS.orchestrator, f"{turn.intentType} via {understood.by}")
            refused = self._gate(intents)
            if refused:
                return self._finish(turn, refused)
            navigation = {"OPEN_SITE", "OPEN_OFFICIAL", "FOLLOW_LINK", "NEXT", "PREV", "GOAL", "SEARCH"}
            if (not forced and self.deps.public_planning and self.deps.llm and self._consent == "granted"
                    and len(intents) >= 3 and any(i["type"] in navigation for i in intents)
                    and not sensitive.kinds and all(self._review_intent_allowed(i["type"], ()) for i in intents)):
                # 실제 주소를 직접 말했거나 신청서 안에서 시작해 일반 계획기로 온 복합 요청도 같은 최종 검토를 거친다.
                request = original or text
                clauses = tuple(p for p in self._rules.split_commands(request) if p in request)
                run = ReviewedTask(request, public_task.PublicTask(goal=request), clauses or (request,), "existing",
                                   _LIVE_DIFFICULTY.get() or "medium", counter=turn.ctx.counter,
                                   remaining=[(i, text) for i in intents], original_operations={repr(i) for i in intents})
                turn.intentType = "REVIEW_BEFORE_OUTPUT"
                return self._finish(turn, await self._review_task(run, turn))
            # 전체 발화를 되풀이한 단계가 빠져 질문 하나만 남아도 모델이 쓴 질문으로 처리한다.
            split_question = (intent["type"] == "UNKNOWN" and self.deps.llm
                              and understood.by == self.deps.llm.name and intent["text"] != text)
            if len(intents) > 1 or split_question:
                return self._finish(turn, await self._run_plan(intents, turn))
            return self._finish(turn, await self._route(intent, turn))
        except AbortError:
            return self._voided()
        except Exception as e:  # noqa: BLE001
            name = type(e).__name__
            return self._finish(
                turn,
                draft("RECOVERING", "none", f"처리 중 문제가 생겨 실행을 멈췄습니다({name}). 다시 말씀해 주세요."),
            )

    async def _auth_turn(self, turn: Turn, forced: dict | None) -> dict:
        text = turn.text
        parsed = forced or self._rules.parse_sync(text, IntentContext(
            state="WAITING_FOR_USER_CONFIRMATION" if self.dialogue.approval else "AUTH_HANDOFF",
        ))
        intent = parsed["type"]
        ended = self.browse.auth_end_if_unavailable(turn.ctx)
        if ended:
            self._auth_review = None
            turn.text = REDACTED
            return ended
        lang = self._lang
        if cancel_reply(text):
            self._auth_review = None
            turn.intentType = "REJECT"
            return {**self.browse.finish_auth("cancelled", FIXED["authCancelled"][lang]), "lang": lang}
        if not forced and (self.dialogue.approval or {}).get("then") == "login-submit":
            reply = approval(text, lang)
            if reply == "approve":
                intent = "APPROVE"
            elif whole_rejection(text, lang):
                intent = "REJECT"
            elif reply == "reject" or intent in ("APPROVE", "REJECT"):
                turn.text = REDACTED
                turn.intentType = "CLARIFY"
                return draft(self.dialogue.state, "clarify", FIXED["approveHint"][lang], lang=lang)
        # 인증 대기 중에는 말을 번역 모델에 보내지 않으므로 다른 언어의 '다 했어'는 규칙으로 알아듣는다
        if not forced and intent == "UNKNOWN" and done_reply(text):
            intent = "AUTH_DONE"
        turn.intentType = intent
        if intent == "AUTH_DONE":
            self.dialogue.clear_approval()
            handoff = self.dialogue.auth_handoff
            result = await self.browse.auth_done(turn.ctx)
            if self._auth_review and handoff.id == self._auth_review[0] and handoff.status == "completed":
                _, run = self._auth_review
                self._auth_review = None
                return await self._review_task(run, turn, resumed=result)
            return result
        if intent == "LOGIN" and self.dialogue.auth_handoff.kind == "login" and auth_input_done(text):
            return await self.browse.login(text, turn.ctx)
        if intent in ("APPROVE", "REJECT") and (self.dialogue.approval or {}).get("then") == "login-submit":
            if intent == "APPROVE":
                return await self._approve(turn)
            self.dialogue.clear_approval()
            return self.browse.auth_wait("로그인 버튼을 누르지 않았어요. 사이트에서 직접 진행해 주세요.")
        if intent == "HELP_HUMAN":
            return self._help_human()
        turn.text = REDACTED
        if intent == "UNKNOWN":
            turn.intentType = "SECRET_DISCLOSURE"
            return {**self._possible_secret(), "state": "AUTH_HANDOFF", "speech": FIXED["possibleSecretAuth"][lang], "lang": lang}
        return {**self.browse.auth_wait(FIXED["authWait"][lang]), "lang": lang}

    def _finish(self, turn: Turn, draft: dict) -> dict:
        stopped_meanwhile = turn.epoch != self._epoch and draft["semanticAction"] != "stop"
        state = "STOPPED" if stopped_meanwhile else draft["state"]
        speech = FIXED["stopBusy"][self._lang] if stopped_meanwhile else draft["speech"]
        private_history = turn.intentType.startswith("GUARDIAN_") or draft.get("privateHistory")
        history_speech = REDACTED if private_history else self._history_speech(speech)
        local_speech_only = bool(private_history or history_speech != speech)
        if (not local_speech_only and not self.dialogue.confirmation and turn.intentType != "READ_START_GUIDE"
                and not draft.get("pictureHistory") and not draft.get("answerCard") and not draft.get("review")):
            speech = history_speech = self._trim_speech(speech)
        if turn.progress_reply and not stopped_meanwhile:
            speech = f"{turn.progress_reply} {speech}"
            prefix = self._history_speech(turn.progress_reply)
            local_speech_only |= prefix != turn.progress_reply
            if not private_history:
                history_speech = f"{prefix} {history_speech}"
        if not stopped_meanwhile:
            self.dialogue.commit(state)
            self._last_semantic = draft["semanticAction"]
            if choices := self.browse.link_choices:
                choices.offer_id = turn.id if draft.get("offersLinks") else ""
                if not choices.offer_id:
                    choices.proposed = None
        self._trace(turn, "SPEAKING", AGENT_IDS.orchestrator)

        view = draft.get("view") or self.web.current_view
        offer = None if stopped_meanwhile else self._offer_for(turn, state, draft, view)
        if not stopped_meanwhile:
            self._offer = offer
        at = now_iso()
        if not stopped_meanwhile:
            user_text = REDACTED if private_history or turn.intentType == "PERSONAL_VAULT_SAVE" else self._history_speech(turn.text)
            self._history.append({"turnId": turn.id, "role": "user", "text": user_text, "at": at, "state": state,
                                  "intentType": turn.intentType})
        # 금고 값(저장 대기 포함)은 사용자에게는 읽어 주되, LLM에 가는 기록에는 넣지 않는다.
        if draft.get("pictureHistory"):
            history_speech = draft["pictureHistory"]
        if not stopped_meanwhile:
            self._history.append({"turnId": turn.id, "role": "assistant", "text": history_speech, "at": at, "state": state})
            label = None
            quiet_answer = turn.ctx.public_lookup and draft["semanticAction"] == "web-answer"
            if quiet_answer:
                label = self._public_task.agency
                if not label:
                    self._public_turns.append({"agency": None, "request": redact_text(user_text)[:180],
                                               "reply": redact_text(history_speech)[:200]})
            elif state == "BROWSING" and view and turn.intentType in ("GOAL", "OPEN_SITE", "SEARCH_WEB", "FOLLOW_LINK"):
                label = site_label(view.get("url") or "")
            elif turn.ctx.public_lookup and turn.intentType == "POLICY_QUESTION" and draft.get("sources"):
                label = self._public_task.agency or "복지로"
            agency = public_task.PUBLIC_AGENCIES.get(label)
            if agency:
                text = self._history_speech(turn.text)
                active = self._public_task
                previous = self._active_service[1] if self._active_service and self._active_service[0] == agency.label else ""
                subject = active.subject if turn.ctx.public_lookup and active.agency in (None, agency.label) else ""
                topic = service_topic(agency, subject) or service_topic(agency, text) or previous
                self._active_service = (agency.label, topic)
                if not turn.ctx.public_lookup and (active.agency != agency.label or (active.question and turn.intentType == "OPEN_SITE")):
                    self._public_task = public_task.PublicTask(agency.label, topic, revision=active.revision + 1)
                self._public_turns.append({"agency": agency.label, "request": redact_text(text)[:180], "reply": redact_text(history_speech)[:200]})
                if self.deps.remember_service:
                    try:
                        self.deps.remember_service(agency.label, topic)
                    except OSError:
                        pass  # 이 대화는 저장 공간을 쓸 수 없을 때에도 계속한다.

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
                    "localSpeechOnly": True if local_speech_only else None,
                    "intentType": turn.intentType,
                    "state": state,
                    "stopGeneration": self._epoch if state == "STOPPED" else None,
                    "semanticAction": draft["semanticAction"],
                    "publicSuggestions": [label for label in draft.get("publicSuggestions", ()) if label in VOCAB] or None,
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
                    "review": draft.get("review"),
                    "pendingConfirmation": self.dialogue.confirmation,
                    "authHandoff": self.dialogue.auth_handoff.public() if self.dialogue.auth_handoff else None,
                    "handoff": draft.get("handoff"),
                    "answerCard": draft.get("answerCard") if not stopped_meanwhile else None,
                    "introScript": draft.get("introScript") if not stopped_meanwhile else None,
                    "sources": draft.get("sources") or [],
                    "missingFields": draft.get("missingFields") or [],
                    "pendingActions": 0,
                    "realSubmission": False,
                    "flags": {"secretDetected": bool(draft.get("secretDetected")), "masked": bool(draft.get("masked"))},
                    "latencyMs": self._elapsed(turn),
                    "speechPrefs": self._personal.speech(),
                    "offeredChoices": [
                        # 응답 말은 뒤에서 대화 언어로 옮겨지므로 버튼 이름도 대화 언어로
                        {"key": k, "label": choice_label(k, self._lang, offer.get("authKind"))} for k in offer["keys"]
                    ] if offer else None,
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
        private = self.dialogue.auth_waiting or still_needs_auth(view)
        url = try_url(view["url"]) if private else None
        for f in view["fields"]:
            profile = self.web.field(f["fieldId"])
            # 비밀번호·인증번호·주민등록번호 같은 칸은 화면 종류와 상관없이 값을 남기지 않는다
            if private or f.get("sensitive") or SECRET_LABEL.search(f.get("label") or ""):
                value = ""
            elif profile and profile.mask_on_readback and f["value"]:
                value = mask_value(f["value"])
            else:
                value = f["value"]
            fields.append({**f, "value": value})
        return compact(
            {
                "page": view["pageId"],
                "url": f"{url.origin}{url.pathname}" if url else view["url"],
                "title": "직접 인증" if private else view["title"],
                "step": view.get("step"),
                "errors": [] if private else view["errors"],
                "status": None if private else view.get("status"),
                "fields": fields,
            }
        )

    # ---------------------------------------------------------------- 라우팅

    def _history_speech(self, speech: str) -> str:
        """보조 턴 기록용: 금고에 있거나 저장 확인 대기 중인 값을 [비공개]로 바꾼다(들은 말은 그대로)."""
        secrets = set(self._personal.vault().values())
        # 부르는 이름도 금고 값처럼 LLM에 가는 기록에는 넣지 않는다
        secrets.update(n for n in (self._personal.call_name(), self.first_run.pending_name) if n)
        pending = self.dialogue.vault_confirm
        if pending and pending.get("kind") == "vault-save":
            secrets.update((pending.get("values") or {}).values())
        return self._replace_values(speech, sorted((v for v in secrets if isinstance(v, str) and v), key=len, reverse=True))

    @staticmethod
    def _replace_values(text: str, values: tuple[str, ...] | list[str]) -> str:
        for value in values:
            text = text.replace(value, REDACTED)
        return text

    def _redact_earlier_mentions(self, values: tuple[str, ...]) -> None:
        """A value may have appeared in the conversation before the user identified it as personal."""
        values = tuple(sorted({value for value in values if value}, key=len, reverse=True))
        if not values:
            return
        for entry in self._history:
            entry["text"] = self._replace_values(entry["text"], values)
        for entry in self._public_turns:
            for key in ("request", "reply"):
                entry[key] = self._replace_values(entry[key], values)
        task = self._public_task
        if any(value in field for value in values for field in (task.goal, task.subject, task.question, *task.facts,
                                                                  *task.exclusions, *task.choices)):
            self._public_task = public_task.PublicTask(revision=task.revision + 1)
        if self._active_service and any(value in self._active_service[1] for value in values):
            self._active_service = None

    def _recent_dialogue(self, n: int = 6) -> list[str]:
        return [f"{'사용자' if h['role'] == 'user' else '청음'}: {h['text'][:400]}" for h in self._history[-n:]]

    async def _describe_screen(self, turn: Turn, exclusions: tuple[str, ...] | list[str] = ()) -> dict:
        question = turn.original or turn.text
        text_only = ("screen_capture" in exclusions or "screen_capture" in self._public_task.exclusions
                     or wants_text_only_screen(question) or wants_text_only_screen(turn.text))
        # 양식 입력·인증·금고 대화·모델 답변은 화면 설명에 보내지 않는다.
        previous = []
        context_intents = {"CHAT", "UNKNOWN", "GOAL", "OPEN_SITE", "SEARCH_WEB", "FOLLOW_LINK", "FIND_PLACE",
                           "POLICY_QUESTION", "DESCRIBE_SCREEN", "READ_MAIN", "LIST_LINKS", "CURRENT_STEP", "ABOUT_SITE"}
        for msg in self._history[-12:]:
            if (msg["role"] != "user" or msg.get("state") not in ("BROWSING", "IDLE", "NEEDS_CLARIFICATION")
                    or msg.get("intentType", "UNKNOWN") not in context_intents):
                continue
            safe = redact_picture_text(self._history_speech(msg["text"])).strip()
            if safe and REDACTED not in safe and not safe.startswith("[") and not detect_sensitive(safe).kinds:
                previous.append(safe[:300])
        return await self.browse.screen(redact_picture_text(self._history_speech(question)), turn.ctx,
                                        previous_inputs=previous[-3:], allow_picture=not text_only)

    def _can_plan_public(self, text: str, sensitive: SensitiveDetection) -> bool:
        return bool(self.deps.public_planning and self.deps.llm and self._consent == "granted"
                    and self.state in ("IDLE", "BROWSING", "NEEDS_CLARIFICATION") and not self.dialogue.has_pending_interaction
                    and not sensitive.kinds and REDACTED not in text and self._history_speech(text) == text
                    and not is_exact_command(text) and not is_picture_request(text.rstrip(".!。"))
                    and not picture_command_parts(text, self._rules)
                    and (self._public_task.question or not ack_kind(text)))

    async def research_public(self, text: str, language: str) -> tuple[str, dict]:
        """Only called on a fresh, restricted worker session for an explicitly queued lookup."""
        if self.consent_status != "granted" or not self.deps.llm or detect_sensitive(text).hasSecretValue:
            return "incomplete", {}
        self._lang = language
        turn = self._begin_turn(text)
        result = await self._plan_public(text, turn, research=True)
        if not result:
            return "incomplete", {}
        limited = False
        if turn.research_state == "completed" and not result.get("review"):
            turn.research_state = await public_task.review_completion(self.deps.web_llm, text, turn.research_evidence, turn.ctx.signal)
            if turn.ctx.signal.aborted or turn.research_state == "incomplete":
                return "incomplete", {}
            limited = turn.research_state == "partial"
        result = await self._localize(result)
        speech = result["speech"]
        if limited:
            lead = {"ko": "찾은 자료로는 질문 전체를 확인하기 어려워요.", "en": "The sources cover only part of your question.",
                    "zh": "现有资料只涵盖了问题的一部分。", "ja": "見つかった資料では、ご質問の一部しか確認できませんでした。"}
            speech = lead.get(result.get("lang") or language, lead["ko"]) + " " + speech
        return turn.research_state, {"text": speech, "sources": result.get("sources") or []}

    async def _plan_public(self, text: str, turn: Turn, *, research: bool = False) -> dict | None:
        task = self._public_task
        if not task.goal and not task.question and self._active_service:
            task = replace(task, agency=self._active_service[0], subject=self._active_service[1])
        reply = agree(text)
        if task.question and reply == "no":
            self._public_task = public_task.PublicTask()
            turn.intentType = "CLARIFY"
            return self._finish(turn, draft(self.state, "clarify", public_task.REJECTED[self._lang], lang=self._lang))
        if task.question and reply == "yes" and len(task.choices) > 1:
            turn.intentType = "CLARIFY"
            return self._finish(turn, draft(self.state, "clarify", task.question + " " + " / ".join(task.choices), lang=self._lang))
        candidates, clear = (word_suggestions(text) if turn.from_voice and self._lang == "ko" and not task.question else ([], False))
        self._trace(turn, "PLANNING", AGENT_IDS.orchestrator, "공공업무 결정")
        recent = [r for r in self._public_turns if r["agency"] == task.agency]
        notes = await self.deps.recall_notes(text) if self.deps.recall_notes and not research else []
        decision = await public_task.decide(self.deps.llm, text, self._lang, task, voice=turn.from_voice,
                                            recent=recent, signal=turn.ctx.signal,
                                            **({"research": True} if research else {}),
                                            **({"saved_notes": notes} if notes else {}),
                                            speech_candidates=tuple(c.label for c in candidates[:2]), corroborated=clear)
        if turn.epoch != self._epoch or turn.ctx.signal.aborted:
            return self._finish(turn, draft("STOPPED", "none", FIXED["stopBusy"][self._lang], lang=self._lang))
        if decision is None:
            if task.question:
                turn.intentType = "CLARIFY"
                return self._finish(turn, draft(self.state, "clarify", task.question, lang=self._lang))
            return None
        previous_review = self._review_question
        self._review_question = None
        if (previous_review and previous_review[0] is task and decision.continuation
                and decision.kind in ("find_information", "review_before_output") and decision.source):
            run = previous_review[1]
            run.task = task.advance(decision)
            run.route = decision.source
            self._public_task = run.task
            turn.intentType = "REVIEW_BEFORE_OUTPUT"
            return self._finish(turn, await self._review_task(run, turn))
        if len(candidates) > 1 and not clear and decision.kind in ("open_agency", "find_information", "review_before_output"):
            # 독립된 단서 없이 발음만 비슷한 기관·증명서 중 하나를 실행하지 않는다.
            return None
        if research and not (decision.kind in ("clarify", "find_information")
                             or decision.kind == "review_before_output" and decision.source):
            return None
        if decision.kind == "review_before_output" or (
                not research and decision.kind == "find_information" and _LIVE_DIFFICULTY.get() == "hard"):
            reviewed = ReviewedTask(
                text, task.advance(decision), tuple(decision.requirements or (text,)), decision.source or "existing",
                _LIVE_DIFFICULTY.get() or decision.difficulty or "medium", counter=turn.ctx.counter, background=research,
            )
            turn.intentType = "REVIEW_BEFORE_OUTPUT"
            self._public_task = reviewed.task
            result = await self._review_task(reviewed, turn)
            if research:
                turn.research_state = result.get("review", {}).get("status", "incomplete")
            return self._finish(turn, result)
        if decision.kind == "delegate_research":
            turn.intentType = "CLARIFY"
            if not self.deps.delegate_research:
                return self._finish(turn, draft(self.state, "clarify", "자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요."))
            question = decision.goal
            prompt = {
                "ko": f"‘{question}’ 질문과 결과를 저장하고 공개 자료를 조사할까요? 앱을 다시 열면 이어서 조사해요.",
                "en": f"Save the question “{question}” and its results, and research public sources? Research resumes when you reopen the app.",
                "zh": f"是否保存问题“{question}”及结果，并调查公开资料？下次打开应用会继续调查。",
                "ja": f"「{question}」という質問と結果を保存し、公開資料を調査しますか？アプリを再度開くと調査を再開します。",
            }[self._lang]
            self.dialogue.ask_approval({"kind": "research", "goal": question,
                "confirmation": {"actionId": uuid(), "kind": "public-research", "purpose": "공개 자료 조사",
                                 "description": prompt, "site": "청음", "values": [], "realSubmission": False}})
            return self._finish(turn, draft("WAITING_FOR_USER_CONFIRMATION", "clarify", prompt, lang=self._lang))
        if decision.kind == "conversation":
            turn.intentType = "CHAT"
            return self._finish(turn, draft(self.state, "chat", decision.reply, lang=self._lang))
        if decision.kind == "read_skill":
            turn.intentType = decision.skill
            intent = {"type": decision.skill, "more": False, "exclusions": decision.exclusions}
            result = self._gate([intent]) or await ROUTES[decision.skill](self, intent, turn)
            return self._finish(turn, result)
        if decision.kind == "existing":
            if task.question:
                self._public_task = replace(task, question="", choices=())
            return None
        task = task.advance(decision)
        if decision.kind == "clarify":
            turn.research_state = "needs_input"
            self._public_task = task
            turn.intentType = "CLARIFY"
            return self._finish(turn, draft(self.state, "clarify", task.question, lang=self._lang))
        turn.ctx = replace(turn.ctx, public_lookup=True)
        # 저장한 조사 작업은 이미 격리된 브라우저에서 실행 중이다.
        mode = None if research else task.search_mode
        turn.intentType = ("OPEN_SITE" if decision.kind == "open_agency" else
                           "GOAL" if mode == "visible" else
                           {"browser": "GOAL", "welfare": "POLICY_QUESTION", "places": "FIND_PLACE"}[decision.source])
        refused = self._gate([{"type": turn.intentType}])
        if refused:
            return self._finish(turn, refused)
        result = await self._execute_public(task, turn, mode, research)
        if turn.epoch == self._epoch:
            self._public_task = replace(task, question=result.get("taskQuestion") or "")
            if result.get("sources"):
                turn.research_state = result.get("researchState", "completed")
                if research:
                    turn.research_evidence = result.get("researchEvidence") or (result.get("answerCard") or {}).get("answer") or result["speech"]
            elif result.get("taskQuestion"):
                turn.research_state = "needs_input"
        return self._finish(turn, result)

    async def _execute_public(self, task: public_task.PublicTask, turn: Turn, mode: str | None,
                              research: bool = False, *, max_steps: int | None = None, continue_page: bool = False,
                              requested_steps: tuple[str, ...] = ()) -> dict:
        bounds = {"max_steps": max_steps, "continue_page": continue_page, "requested_steps": requested_steps} if max_steps is not None else {}
        if not research and (turn.intentType == "OPEN_SITE" or mode == "visible"):
            await self.web.show_browser()
        if turn.intentType == "OPEN_SITE":
            result = await self.browse.open_site(task.agency, turn.ctx)
        elif turn.intentType == "FIND_PLACE":
            result = self._find_place(replace(turn, text=task.goal))
            if mode == "quiet" and result["semanticAction"] == "find-place" and not result.get("sources"):
                result = await self._quiet_lookup(task, turn)
        elif turn.intentType == "POLICY_QUESTION":
            answer = await self.deps.welfare.public_facts(task.subject, task.goal, task.facts, turn.ctx.signal)
            if answer:
                result = self._welfare_draft(answer, "welfare-retrieval")
            elif not task.subject:
                prompt = public_task.ASK_SERVICE[self._lang]
                result = draft(self.state, "clarify", prompt, lang=self._lang)
                result["taskQuestion"] = prompt
            elif turn.ctx.signal.aborted:
                result = draft("STOPPED", "none", FIXED["stopBusy"][self._lang], lang=self._lang)
            elif mode == "quiet":
                result = await self._quiet_lookup(task, turn)
            else:
                task = replace(task, agency=task.agency or "복지로")
                result = await self.browse.run_goal(task.goal, turn.ctx, public_task=task, **bounds)
        elif mode == "quiet":
            result = await self._quiet_lookup(task, turn)
        else:
            result = await self.browse.run_goal(task.goal, turn.ctx, public_task=task, **bounds)
        return result

    async def _review_task(self, run: ReviewedTask, turn: Turn, *, resumed: dict | None = None) -> dict:
        try:
            return await self._run_review(run, turn, resumed)
        except AbortError:
            return draft("STOPPED", "stop", FIXED["stopBusy"][self._lang], lang=self._lang)

    async def _run_review(self, run: ReviewedTask, turn: Turn, resumed: dict | None) -> dict:
        rounds, _, actions = REVIEW_LIMITS[run.difficulty]
        turn.ctx = replace(turn.ctx, counter=run.counter, action_limit=actions)
        logs = []
        last = resumed or {}
        missing = run.requirements

        def record(result: dict) -> None:
            logs.extend(result.get("actions") or ())
            run.browser_steps += result.get("browserIterations", 0)
            for source in result.get("sources") or ():
                run.sources[source["url"]] = source
            run.evidence.extend(task_review.evidence_from_draft(result))

        def summary(status: str) -> dict:
            return {"status": status, "difficulty": run.difficulty, "rounds": run.rounds,
                    "maxRounds": rounds, "browserIterations": run.browser_steps}

        def needs_input(result: dict) -> bool:
            return bool(result["state"] in PLAN_STOP_STATES or result.get("taskQuestion") or self.dialogue.place_ask
                        or result["semanticAction"] in ("clarify", "consent"))

        def pause(result: dict) -> dict:
            pending = self.dialogue.approval
            if pending and result["state"] == "WAITING_FOR_USER_CONFIRMATION":
                pending["reviewedTask"] = run
            elif self.dialogue.clarification and result["state"] == "NEEDS_CLARIFICATION":
                self.dialogue.clarification.update(reviewedTask=run, reviewedUrl=(self.web.current_view or {}).get("url"))
            elif result.get("taskQuestion") and not run.background:
                self._public_task = replace(run.task, question=result["taskQuestion"])
                self._review_question = (self._public_task, run)
            elif result["state"] == "AUTH_HANDOFF" and self.dialogue.auth_waiting:
                self._auth_review = (self.dialogue.auth_handoff.id, run)
            elif self.dialogue.place_ask:
                self._place_review = (self.dialogue.place_ask, run)
            elif result["state"] not in ("AUTH_HANDOFF", "STOPPED") and not run.background:
                return {**result, "actions": logs, "review": summary("incomplete"),
                        "speech": result["speech"] + " 전체 요청은 아직 완료하지 못했어요."}
            return {**result, "actions": logs, "review": summary("needs_input")}

        with self.progress.review():
            if resumed is not None:
                record(resumed)
                if needs_input(resumed) or resumed["semanticAction"] == "none":
                    return pause(resumed)
            while run.rounds < rounds:
                if turn.ctx.signal.aborted or turn.epoch != self._epoch:
                    return draft("STOPPED", "stop", FIXED["stopBusy"][self._lang], lang=self._lang)
                if run.route == "existing":
                    async for work in self._review_actions(run, turn, missing[0], resuming=resumed is not None):
                        last = work
                        record(last)
                        if needs_input(last):
                            return pause(last)
                elif resumed is None:
                    work = await self._review_lookup(run, turn, missing)
                    if work is None:
                        break
                    last = work
                    record(last)
                    if needs_input(last):
                        return pause(last)
                resumed = None
                if turn.ctx.signal.aborted:
                    return draft("STOPPED", "stop", FIXED["stopBusy"][self._lang], lang=self._lang)
                repair = ""
                while True:
                    run.rounds += 1
                    self._trace(turn, "VERIFYING", AGENT_IDS.orchestrator, f"요청 완료 검토 {run.rounds}/{rounds}")
                    verdict = await race_abort(task_review.review_before_output(
                        self.deps.llm, self._history_speech(run.request), run.evidence, turn.ctx.signal,
                        language=self._lang, requirements=run.requirements, private_values=run.private_values,
                        **({"repair_reason": repair} if repair else {}),
                    ), turn.ctx.signal)
                    if repair or run.rounds >= rounds or not verdict.repair_reason:
                        break
                    repair = verdict.repair_reason
                if verdict.status == "complete" and not run.remaining:
                    if verdict.confirmed_page:
                        try:
                            current = await self.web.observe(turn.ctx)
                        except Exception:
                            current = None
                        if not task_review.page_matches(verdict, current, run.private_values):
                            break
                    return draft(last.get("state", self.state), "review-before-output", verdict.answer, lang=self._lang,
                                 review=summary("completed"), actions=logs, sources=list(run.sources.values()))
                missing = verdict.missing or run.requirements
                if verdict.status != "retry" or not verdict.next_route:
                    break
                route = verdict.next_route
                if run.task.search_mode == "quiet" and route == "browser":
                    route = "quiet"
                if run.task.search_mode == "visible" and route == "quiet":
                    route = "browser"
                if route == "existing":
                    if run.background or run.task.search_mode == "quiet":
                        break
                    if run.task.search_mode == "visible":
                        route = "browser"
                    elif missing[0] not in run.requirements:
                        break
                retry = (route, tuple(missing), len(set(run.evidence)))
                if retry in run.retries:
                    break
                run.retries.add(retry)
                run.route = route

        detail = self._history_speech(" / ".join(missing))
        for value in run.private_values:
            if value:
                detail = detail.replace(value, REDACTED)
        detail = redact_picture_text(detail).strip()[:320]
        speech = "요청을 모두 확인하지 못했어요." + (f" 아직 확인이 필요한 내용은 ‘{detail}’예요." if detail else "")
        return draft(last.get("state", self.state), "review-before-output", speech, review=summary("incomplete"),
                     actions=logs, sources=list(run.sources.values()))

    async def _review_actions(self, run: ReviewedTask, turn: Turn, missing: str, *, resuming: bool):
        _, steps, actions = REVIEW_LIMITS[run.difficulty]
        if not run.remaining and not resuming:
            requested = run.request if not run.rounds else missing
            if self._lang != "ko":
                requested = await translate_in(self.deps.web_llm or self.deps.llm, requested,
                                               self._lang, turn.ctx.signal)
            if not requested:
                return
            step = replace(turn, text=requested, original=None)
            understood = await race_abort(self._understand(requested, step, max_steps=actions), turn.ctx.signal)
            if not run.rounds:
                run.original_operations.update(repr(i) for i in understood.intents)
            run.remaining.extend((i, requested) for i in understood.intents)
        while run.remaining and not turn.ctx.signal.aborted:
            intent, user_text = run.remaining.pop(0)
            kind = intent["type"]
            # 기존 권한 문을 통과한 사용자의 요청만 실행한다. 검토 결과로 승인이나 입력을 만들지 않는다.
            if not self._review_intent_allowed(kind, run.task.exclusions):
                run.remaining.clear()
                break
            if kind == "FILL":
                values = [v["value"] for v in intent.get("fills", [])]
                if any(v not in user_text for v in values):
                    run.remaining.clear()
                    break
                run.private_values.extend(values)
            if run.rounds and repr(intent) in run.attempted:
                continue
            retry_read = run.rounds > 0 and repr(intent) not in run.original_operations
            if retry_read and kind not in {"OPEN_SITE", "FOLLOW_LINK", "GOAL", "SEARCH", "READ_MAIN",
                                           "ABOUT_SITE", "CURRENT_STEP", "POLICY_QUESTION", "FIND_PLACE"}:
                run.remaining.clear()
                break
            run.attempted.add(repr(intent))
            limited_read = retry_read or kind in ("GOAL", "FOLLOW_LINK", "SEARCH") and bool(
                {"login", "application", "submission", "personal_input"}.intersection(run.task.exclusions))
            local = replace(turn, text=user_text, intentType=kind, ctx=replace(turn.ctx, public_lookup=limited_read))
            refused = self._gate([intent])
            if refused:
                yield refused
                return
            if kind == "GOAL":
                if run.browser_steps >= steps:
                    break
                last = await self.browse.run_goal(intent["goal"], local.ctx, max_steps=steps - run.browser_steps,
                                                  exclusions=run.task.exclusions, requested_steps=(intent["goal"],))
            else:
                last = await self._route(intent, local)
            yield last
            if last["semanticAction"] == "none" or any(
                    not a["policy"]["allowed"] or not (a.get("result") or {}).get("ok")
                    for a in last.get("actions", ())):
                run.remaining.clear()
                break

    async def _review_lookup(self, run: ReviewedTask, turn: Turn, missing: tuple[str, ...]) -> dict | None:
        _, steps, _ = REVIEW_LIMITS[run.difficulty]
        # 쌓인 근거를 보존하고, 재시도는 원래 기관·조건 안에서 빠진 항목만 조사한다.
        goal = run.task.goal if not run.rounds else f"확인할 항목: {missing[0]}\n원래 대상과 조건: {run.task.goal}"
        private = sorted({value for value in run.private_values if value}, key=len, reverse=True)
        subtask = replace(run.task, goal=self._replace_values(goal, private),
                          subject=self._replace_values(run.task.subject, private))
        if run.rounds and run.route == "browser":
            subtask = replace(subtask, facts=("other",))
        mode = None if run.background else run.task.search_mode
        if run.route == "quiet" or (mode == "quiet" and run.route == "browser"):
            mode = "quiet"
        elif run.route == "browser":
            mode = "visible"
        kind = {"browser": "GOAL", "quiet": "GOAL", "welfare": "POLICY_QUESTION", "places": "FIND_PLACE"}[run.route]
        refused = self._gate([{"type": kind}])
        if refused:
            return refused
        if mode == "visible" and run.browser_steps >= steps:
            return None
        step = replace(turn, intentType=kind, ctx=replace(turn.ctx, public_lookup=True))
        return await self._execute_public(subtask, step, mode, research=run.background,
                                          max_steps=max(0, steps - run.browser_steps), continue_page=bool(run.browser_steps),
                                          requested_steps=tuple(self._replace_values(p, private) for p in missing)
                                          if mode == "visible" else ())

    @staticmethod
    def _review_intent_allowed(kind: str, exclusions: tuple[str, ...]) -> bool:
        allowed = {"OPEN_SITE", "OPEN_OFFICIAL", "OPEN_BROWSER", "FOLLOW_LINK", "GOAL", "SEARCH",
                   "START_APPLICATION", "FILL", "NEXT", "PREV", "READ_FIELD", "REVIEW", "PREPARE_SUBMIT",
                   "LOGIN", "READ_MAIN", "CURRENT_STEP", "ABOUT_SITE", "LIST_LINKS", "POLICY_QUESTION", "FIND_PLACE"}
        excluded = {"personal_input": {"FILL"}, "submission": {"PREPARE_SUBMIT"}, "login": {"LOGIN"},
                    "application": {"START_APPLICATION", "FILL", "PREPARE_SUBMIT"}}
        return kind in allowed and not any(kind in excluded.get(item, ()) for item in exclusions)

    async def _quiet_lookup(self, task: public_task.PublicTask, turn: Turn) -> dict:
        """현재 탭과 저장 작업을 건드리지 않고 이 턴에서 공개 출처를 확인한다."""
        answer = {}
        signal = turn.ctx.signal
        if (self.deps.quiet_search and self.consent_status == "granted" and not signal.aborted
                and all(self._history_speech(term) == term and not detect_sensitive(term).kinds
                        for term in (task.goal, task.subject))):
            try:
                answer = await race_abort(self.deps.quiet_search(task, self._lang, signal), signal)
            except Exception:
                answer = {}
        if signal.aborted:
            return draft("STOPPED", "none", FIXED["stopBusy"][self._lang], lang=self._lang)
        if answer and answer.get("sources") and answer.get("speech"):
            return draft(self.state, "web-answer", answer["speech"], sources=answer["sources"],
                         reviewQuotes=answer.get("reviewQuotes"), reviewQuoteSources=answer.get("reviewQuoteSources"),
                         lang=self._lang)
        return draft(self.state, "web-answer", public_task.LOOKUP_UNAVAILABLE[self._lang], lang=self._lang)

    def _planning_context(self, goal: str, site_url: str | None) -> dict:
        view = self.web.current_view or {}
        label = site_label(site_url or view.get("url") or "")
        if not label and self._active_service:
            label = self._active_service[0]
        active = self._active_service if self._active_service and self._active_service[0] == label else None
        context = {"language": self._lang, "agency": label, "service": active[1] if active else "",
                   "recentTurns": [turn for turn in self._public_turns if turn["agency"] == label]}
        if self._profile.get("ctpv") and rx(r"지역|우리\s*동네|근처|가까운|거주지|내\s*주변").search(goal):
            context["region"] = self._profile["ctpv"]
        return context

    def missed_speech_hint(self) -> str:
        if self._lang != "ko":
            return FIXED["retry"][self._lang]
        if self._active_service:
            agency, topic = self._active_service
            return f"소리가 잘 들리지 않았어요. {topic or agency}에서 궁금한 점을 짧게 말씀해 주세요."
        return "소리가 잘 들리지 않았어요. '정부24 열어줘'처럼 기관 이름이나 필요한 업무를 말씀해 주세요."

    def _clarify_heard(self, turn: Turn) -> dict:
        heard = self._history_speech(redact_text(turn.text)).strip()[:65]
        question = "어느 기관이나 업무를 찾으세요?"
        if self._active_service:
            agency, topic = self._active_service
            question = f"{topic or agency}에 이어서 물으신 건가요, 다른 업무를 찾으시나요?"
        lead = f"'{heard}'라고 들었어요. " if heard and REDACTED not in heard else ""
        return draft(self.dialogue.state, "clarify", lead + question)

    def _public_followup(self, text: str) -> str | None:
        if not self._active_service or self.dialogue.state not in ("IDLE", "BROWSING"):
            return None
        view = self.web.current_view or {}
        agency, topic = self._active_service
        if view.get("pageId") not in (None, "blank") and site_label(view.get("url") or "") != agency:
            return None
        if mentions_known_site(text, fuzzy=False) or public_service_site(text):
            return None
        words = rx(r"\s+").sub("", text).strip(".!?")
        if not rx(r"^(?:(?:그럼|그러면|여기서|여기|그건|그|이|필요한|제출할))*"
                  r"(?:신청|발급|제출서류|필요|준비|자격|대상|서류|마감|기한|언제|어떻게|어디서|수수료|비용|기간|온라인)").search(words):
            return None
        if rx(r"연금|급여|수당|바우처|지원금|장려금|눌러|클릭|열어|대신신청|제출해|접수해|신청해줘").search(words):
            return None
        return " ".join(part for part in (agency + "에서", topic, text) if part)

    async def _understand(self, text: str, turn: Turn, *, max_steps: int = 6) -> Understood:
        """이번 턴의 대화 상태를 붙여 말 이해(understanding/understand.py)에 맡긴다."""
        awaiting = self.dialogue.awaiting
        current = self.web.current_view
        if followup := self._public_followup(text):
            return Understood([{"type": "GOAL", "goal": followup}], "context")
        understood = await self.understanding.understand(
            text,
            IntentContext(state=self.dialogue.state, awaitingFieldId=awaiting),
            awaited=self.web.field(awaiting) if awaiting else None,
            clarifying=bool(self.dialogue.clarification),
            page=current.get("title") if current else None,
            recent=self._recent_dialogue(4),
            max_steps=max_steps,
            trace=lambda note: self._trace(turn, "PLANNING", AGENT_IDS.orchestrator, note),
        )
        if (not awaiting and len(understood.intents) == 1 and understood.intents[0]["type"] == "UNKNOWN"
                and rx(r"(열어|접속|들어가|이동해|가\s*줘|켜\s*줘|띄워)").search(text)):
            direct = await self.deps.welfare.resolve_site_link(
                text, ctpv=self._profile.get("ctpv"), sgg=self._profile.get("sgg")
            )
            if direct and direct.get("url"):
                return Understood([{"type": "OPEN_SITE", "target": text}], "direct-link")
        return understood

    async def _run_plan(self, intents: list[dict], turn: Turn) -> dict:
        """여러 명령을 차례로 실행. 확인·승인이 필요한 단계에서 멈추고 남은 일을 알려 준다."""
        drafts: list[dict] = []
        for i, intent in enumerate(intents):
            if turn.epoch != self._epoch:
                break
            self._trace(turn, "PLANNING", AGENT_IDS.orchestrator, f"단계 {i + 1}/{len(intents)}: {intent['type']}")
            step = turn
            if intent["type"] == "UNKNOWN":
                step = replace(turn, text=intent["text"])
            elif intent["type"] == "FIND_PLACE":
                parts = self._rules.split_commands(turn.text)
                if len(parts) != len(intents):
                    drafts.append(draft(self.dialogue.state, "clarify", "찾으시는 기관 이름과 지역을 함께 다시 말씀해 주세요."))
                    break
                step = replace(turn, text=parts[i])
            d = await self._route(intent, step, planned_question=intent["type"] == "UNKNOWN")
            drafts.append(d)
            if d["state"] in PLAN_STOP_STATES or d["semanticAction"] == "consent" or self.dialogue.place_ask:
                break
        if not drafts:
            return draft("STOPPED", "stop", "멈췄어요.")
        last = drafts[-1]
        if len(drafts) > 1 and all(intent["type"] in QUESTION_TYPES for intent in intents):
            parts = [f"{i}. {nz(d.get('summary'), d['speech'])}" for i, d in enumerate(drafts, 1)]
        else:
            parts = [nz(d.get("summary"), d["speech"]) for d in drafts[:-1]] + [last["speech"]]
        skipped = len(intents) - len(drafts)
        if skipped:
            parts.append(f"나머지 {skipped}가지 요청은 이것부터 해결한 뒤 다시 말씀해 주세요.")
        speech = " ".join(part for part in parts if part)
        out = {
            **last,
            "speech": speech,
            "actions": [a for d in drafts for a in d.get("actions") or []],
            "sources": [s for d in drafts for s in d.get("sources") or []],
        }
        if any(d.get("privateHistory") for d in drafts):
            out["privateHistory"] = True
        if any(d.get("pictureHistory") for d in drafts):
            out["pictureHistory"] = "화면 사진 설명 요청을 처리했어요."
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
            return draft(self.dialogue.state, "discover", f"{intro}{profile_question(nxt, self._profile)}")
        self.dialogue.profile_done()
        self._trace(turn, "PLANNING", AGENT_IDS.welfare, "맞춤 복지 찾기")
        return self._welfare_draft(await self.deps.welfare.discover(self._profile), "discover")

    def _welfare_draft(self, answer: Any, semantic: str) -> dict:
        if answer.grounded and answer.service:
            self._grounded = {"servNm": answer.service["servNm"], "sources": answer.sources}
        card = answer.card
        return draft(self.dialogue.state, semantic, speak_answer_card(card) if card else answer.speech,
                     sources=answer.sources, answerCard=card, reviewQuotes=answer.review_quotes)

    async def _rephrase(self, turn: Turn) -> dict:
        """"쉽게 말해줘": 직전 안내를 쉬운 말로(LLM이 없거나 숫자를 바꿔 말하면 그대로 다시)."""
        last_speech = next((h["text"] for h in reversed(self._history) if h["role"] == "assistant"), None)
        if not last_speech:
            return draft(self.dialogue.state, "rephrase", "아직 드린 안내가 없어요. 무엇을 도와드릴까요?")
        # "그 번호를 다시 천천히": 바꿔 말하지 않고 그대로, 전화번호는 한 자리씩. 전화번호를 물었으면 전화번호가 있는 문장만
        # ('그 번호'만으로는 접수번호일 수도 있어 다 말한다).
        if rx(r"천천히|느리게").search(turn.text):
            sentences = [x for x in rx(r"(?<=[.!?。])\s+").split(last_speech) if x.strip()]
            numbered = [x for x in sentences if has_phone_number(x)] if rx(r"전화").search(turn.text) else []
            return draft(self.dialogue.state, "rephrase", f"천천히 다시 말씀드릴게요. {spell_phone_numbers(' '.join(numbered or sentences))}")
        model = self.deps.web_llm or self.deps.llm
        if model:
            out = await model.generate(
                system="정보취약계층 사용자가 방금 들은 안내를 이해하지 못했다. 같은 내용을 더 쉬운 말로, 짧은 문장 2~4개로 다시 말해라. 새 정보를 지어내지 말고, 숫자·금액·출처는 그대로 유지. 존댓말.",
                user=last_speech,
                schemaName="simple",
                schema=SIMPLE_TEXT_SCHEMA,
                signal=turn.ctx.signal,
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
        if turn.link_question and route not in ("general", "clarify"):
            return draft(self.dialogue.state, "clarify", "이 링크의 어떤 내용을 알고 싶으세요?")
        if not route:
            if turn.from_voice:
                return self._clarify_heard(turn)
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

    async def _route(self, intent: dict, turn: Turn, *, planned_question: bool = False) -> dict:
        if intent["type"] == "FOLLOW_LINK" and turn.stale_link_offer:
            return self._changed_link_reply()
        # 모델이 풀어 쓴 질문을 번호 선택이나 입력 칸의 값으로 받아들이지 않는다.
        if planned_question:
            refused = self._consent_gate(intent)
            if refused:
                return refused
            before = self.web.current_view
            answer = await self._free_chat(turn.text, turn)
            return await self.browse.recognize_auth_page(answer, before, turn.ctx)
        # '복지루·복지관에서'처럼 사이트 이름이 한 글자 다르면 가기 전에 소리로 확인한다(주인 결정 2026-11-19)
        if intent["type"] in ("GOAL", "OPEN_SITE"):
            guess = near_site_guess(turn.text, self.browse.mock_sites())
            if guess:
                site, word = guess
                self.dialogue.ask_site({"text": turn.text.replace(word, site.label, 1), "label": site.label})
                return draft(self.dialogue.state, "clarify", f"'{site.label}' 말씀이세요? 맞으면 '네', 아니면 '아니'라고 말씀해 주세요.")
        # 되묻기에 대한 답(예: "실거주지 주소")
        short_reply = len(turn.text) <= 20 and not rx(r"\d").search(turn.text)
        if self.dialogue.clarification and (short_reply or intent["type"] == "UNKNOWN"):
            picked = self.web.pick_candidate(turn.text, self.dialogue.clarification["candidates"])
            if picked:
                clarification = self.dialogue.clarification
                value = clarification["value"]
                self.dialogue.clear_choice()
                run = clarification.get("reviewedTask")
                if run:
                    view = await self.web.observe(turn.ctx)
                    if (self._consent != "granted" or turn.ctx.signal.aborted
                            or view.get("url") != clarification.get("reviewedUrl")):
                        return draft(self.state, "none", "입력할 페이지가 바뀌어 작업을 중단했어요.")
                    turn.ctx = replace(turn.ctx, counter=run.counter, action_limit=REVIEW_LIMITS[run.difficulty][2])
                    return await self._review_task(run, turn, resumed=await self.form.fill_one(picked, value, turn.ctx))
                return await self.form.fill_one(picked, value, turn.ctx)
        if intent["type"] != "UNKNOWN":
            self.dialogue.clear_choice()

        # 맞춤 찾기 목록 속 제도를 가리키면("1번 신청하고 싶어", "너가 찾은 기장군 교통비 지원") 그 제도로 이어 간다.
        # (링크 목록을 막 읽어 준 뒤의 "2번"은 링크 고르기라 제외)
        list_just_read = (self._last_semantic in ("list-links", "describe-picture")
                          or self._last_semantic == "describe-screen" and bool(self.browse.link_choices))
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
        before = self.web.current_view
        result = await handle(self, intent, turn) if handle else await self._unknown(intent.get("text", turn.text), turn)
        return await self.browse.recognize_auth_page(result, before, turn.ctx)

    async def _welfare_reply(self, pending: Awaitable[Any], semantic: str) -> dict:
        return self._welfare_draft(await pending, semantic)

    async def _discover(self, turn: Turn) -> dict:
        self._profile = {**self._profile, **parse_profile_answer(turn.text, known=self._profile)}
        return await self._discover_step(turn, True)

    def _place_reply(self, reply: PlaceReply) -> dict:
        self.dialogue.ask_place(reply.ask)
        return draft(self.dialogue.state, reply.semantic, reply.speech, sources=list(reply.sources),
                     reviewQuotes=reply.review_quotes)

    def _find_place(self, turn: Turn) -> dict:
        return self._place_reply(self.deps.places.answer(turn.text, hint=self._profile.get("ctpv"), lang=self._lang))

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

    async def _open_service_page(self, current: str, turn: Turn, tail: str) -> dict | None:
        """Agent B가 고른 제도의 공식 상세 페이지를 Agent A가 읽기 전용으로 연다. 주소가 없거나 못 열면 None."""
        welfare = self.deps.welfare
        url = welfare.current_service_url
        if not url or self.web.access_mode({"url": url}) == "none":
            return None
        out = await self.web.open_site(url, turn.ctx)
        if out.status != "ok" or not out.view:
            return None
        self.browse.after_navigation(out.view)
        try:
            brief = await welfare.briefing()
        except Exception:  # noqa: BLE001
            brief = None
        speech = f"{current} 공식 안내를 열었어요. {brief or ''}{tail}"
        return draft(browse_state(out.view), "agent-handoff", rx(r"\s+").sub(" ", speech).strip(), actions=out.actions, view=out.view)

    async def _open_official(self, service: str | None, turn: Turn) -> dict:
        """
        "공식 안내 열어줘": 신청 시작 없이 고른 제도의 공식 안내만 연다. 번호·제도 이름을 말했으면 그 제도를 먼저 고른다.
        어떤 제도인지 모르거나 말한 제도를 찾지 못하면 묻는다(다른 제도를 열거나 주소를 지어내지 않음).
        """
        welfare = self.deps.welfare
        if service:
            hit = welfare.pick(service) if welfare.find_in_matches(service) else None
            if hit:
                current = hit["servNm"]
            else:
                try:
                    current = await welfare.select_service(
                        service, ctpv=self._profile.get("ctpv"), sgg=self._profile.get("sgg")
                    )
                except TypeError:
                    current = await welfare.select_service(service)
            if not current:
                return draft(self.dialogue.state, "clarify", f"'{service}'에 맞는 제도를 찾지 못했어요. 목록 번호나 제도 이름을 다시 말씀해 주세요.")
            self._grounded = None
        else:
            current = (self._grounded or {}).get("servNm") or welfare.current_service_name
        if not current:
            return draft(self.dialogue.state, "clarify", "어떤 제도의 공식 안내를 열까요? 제도 이름이나 목록 번호를 말씀해 주세요.")
        hint = self.narrator.once("official", " 자세히는 '본문 읽어줘'라고 하세요.")
        opened = await self._open_service_page(current, turn, hint)
        if opened:
            return opened
        return draft(
            self.dialogue.state,
            "clarify",
            f"{current}의 공식 안내 주소를 확인하지 못했어요. '복지로에서 {current} 찾아줘'라고 하시면 찾아볼게요.",
        )

    async def _start_application(self, turn: Turn) -> dict:
        # 실제 사이트 모드(practice_mode=False)에서는 "연습/모의"라고 할 때만 연습 신청서, 그 밖에는 공식 안내 페이지로 간다.
        practice = self.deps.practice_mode is not False or bool(rx(r"(연습|모의)").search(turn.text))
        named = bool(rx(r"장애인\s*연금").search(turn.text))
        welfare = self.deps.welfare
        if welfare.current_is_private and welfare.refers_to_selection(turn.text):
            return self._welfare_draft(await welfare.prepare(None), "prepare-apply")
        if not practice or welfare.current_is_private:
            picked = await welfare.select_service(turn.text)
            if picked:
                self._grounded = None
            elif welfare.current_is_private:
                return draft(self.dialogue.state, "clarify", "신청하려는 사업을 확인하지 못했어요. 목록 번호나 사업 이름을 다시 말씀해 주세요.")
        # 어떤 제도인지 말하지 않았고 앞선 대화에도 없으면 추측하지 않고 묻는다.
        if not named or not practice:
            current = (self._grounded or {}).get("servNm") or welfare.current_service_name
            if not current:
                return draft(self.dialogue.state, "clarify", "어떤 제도를 신청하시려고요? 제도 이름을 말씀해 주세요.")
            if current != "장애인연금" or not practice:
                # 실제 신청은 로그인 후 사용자가 직접
                hint = self.narrator.once("apply", " 자세히는 '본문 읽어줘', 입력 칸은 '하나씩 채워줘'라고 하세요.")
                opened = await self._open_service_page(current, turn, f" 온라인 신청은 로그인과 본인인증 후 직접 하셔야 해요.{hint}")
                if opened:
                    return opened
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
        같은 말을 바로 한 번 더 하면 명령으로 보고 통과시킨다. 번역하기 전 원문에 적용한다.
        """
        view = self.web.current_view
        risky = hint or self.dialogue.state == "AUTH_HANDOFF" or bool(view and view.get("pageId") == "mock-login")
        if not risky:
            self._secret_guarded = None
            return False
        # 값을 기다리는 칸(비밀이 아닌 칸)·칸 채우기·금고 확인·맞춤 찾기 질문의 대답이면 그쪽이 받는다
        d = self.dialogue
        if not hint and (d.awaiting or d.guided or d.vault_confirm or d.profile_question):
            return False
        t = rx(r"[.!?。~]+$").sub("", text).strip()
        if not t or (len(t) > 30 and " " in t) or is_question_like(t) or ack_kind(t) or done_reply(t, whole=True):
            return False
        if d.expects_confirmation and approval(text, self._lang):
            return False
        if detect_lang_switch(t) or guardian_command(t) or parse_personal_command(t):
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
            FIXED["possibleSecretAuth" if self.dialogue.auth_waiting else "possibleSecret"][self._lang],
            lang=self._lang,
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
        pending = self.dialogue.approval or {}
        run = pending.get("reviewedTask")
        if not isinstance(run, ReviewedTask):
            return await self._execute_approval(turn)
        # 1회 승인과 같은 지문을 확인해야 기존 작업을 이어 간다.
        turn.ctx = replace(turn.ctx, action_limit=REVIEW_LIMITS[run.difficulty][2], counter=run.counter)
        with self.progress.review():
            result = await self._execute_approval(turn)
            return await self._review_task(run, turn, resumed=result)

    async def _execute_approval(self, turn: Turn) -> dict:
        """
        승인 문. 물어볼 때 읽어 준 그대로(지문: 누를 대상·화면 주소·입력 칸 값)일 때만 실행한다. 다르면 승인을 버리고 무엇이 바뀌었는지 말한다.
        그대로라도 물은 지 2분이 지났으면 실행하지 않고 요약을 다시 읽어 새로 묻는다. 그대로이고 2분 안이면 다시 묻지 않는다.
        """
        approval = self.dialogue.approval
        if not approval:
            return draft(self.dialogue.state, "none", "지금 승인할 작업이 없습니다. 승인은 실행 직전에만 요청합니다.")
        if approval.get("then") == "login-submit":
            ended = self.browse.auth_end_if_unavailable(turn.ctx)
            if ended:
                return ended
        kind = approval.get("kind")
        if kind == "research":
            expired = self.dialogue.approval_age >= APPROVAL_TTL_S
            self.dialogue.clear_approval()
            saved = (not expired and self.consent_status == "granted" and self.deps.delegate_research
                     and await self.deps.delegate_research(approval["confirmation"]["actionId"], approval["goal"]))
            return draft("IDLE", "none", "조사를 맡겼어요. 자료 조사와 저장한 메모에서 결과를 확인할 수 있어요."
                         if saved else "조사를 시작하지 못했어요. 개인 기기 설정과 질문을 확인해 주세요.")
        if kind == "visual":
            if self.dialogue.approval_age >= APPROVAL_TTL_S:
                self.dialogue.clear_approval()
                return draft("BROWSING", "clarify", "시간이 지나 사진 전송 요청을 닫았어요. 필요한 업무를 다시 말씀해 주세요.")
            return await self.browse.resume_visual(approval, turn.ctx)
        if kind == "file":
            if self.dialogue.approval_age >= APPROVAL_TTL_S:
                self.dialogue.clear_approval()
                return await self.browse.read_download({"type": "READ_DOWNLOAD"}, approval["question"], turn.ctx)
            return await self.browse.analyze_approved(approval, turn.ctx, self._lang)
        actions = approval.get("actions") or [approval["action"]]
        view = await self.web.observe(turn.ctx)
        if turn.ctx.signal.aborted or self.dialogue.approval is not approval:
            return draft(self.dialogue.state, "none", "이 확인 요청은 취소됐어요.")
        now, changed = recheck(approval["fingerprint"], view, actions)
        bind_record = (kind == "assist" or bool(approval.get("reviewedTask"))
                       or kind == "click" and not self.web.is_approved_url(approval.get("url", "")))
        if bind_record and approval.get("url") != view.get("url"):
            changed = "여쭤본 뒤에 화면 주소가 바뀌었어요."
        if changed:
            self.dialogue.clear_approval()
            state = "AUTH_HANDOFF" if self.dialogue.auth_waiting else browse_state(view)
            return draft(state, "none", f"{changed} 그래서 {NOT_DONE[kind]} 바뀐 대로 하시려면 한 번 더 말씀해 주세요.", view=view)
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
                result = await self.browse.click_approved(approval, turn.ctx)
                if self.dialogue.approval is approval:
                    self.dialogue.ask_approval(approval)
                return result
            if kind == "assist":
                filled = await self.form.assist_approved(actions, turn.ctx)
                if approval.get("guided") and self.guided.active() and filled.get("semanticAction") == "fill":
                    return await self.guided.after_assist(filled, turn.ctx)
                if self.dialogue.approval is approval:
                    self.dialogue.ask_approval(approval)
                return filled
            result = await self.form.submit_approved(approval["action"], turn.ctx)
            if self.dialogue.approval is approval:
                self.dialogue.ask_approval(approval)
            return result

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
        result = self._welfare_draft(answer, "welfare-retrieval")
        if resume:
            result["speech"] += f" 이어서 {resume}"
        return result

    async def _read_field(self, mention: str, turn: Turn) -> dict:
        """
        입력 칸 읽기. 신청서가 없는 화면에서 "문의할 기관 이름이 뭐야?"는 칸('이름')을 읽으라는 말이 아니라 물음이다:
        읽을 칸이 없으니 '입력을 대신하지 않아요'로 막지 말고 질문으로 답한다(LLM이 있을 때).
        """
        if not is_form_open(self.web.current_view) and self.deps.llm and is_question_like(turn.text):
            return await self._free_chat(turn.text, turn)
        return await self.form.read_field(mention, turn.ctx)

    async def _unknown(self, text: str, turn: Turn) -> dict:
        if self.dialogue.clarification:
            names = ", ".join(speak_label(c.label) for c in self.dialogue.clarification["candidates"])
            return draft("NEEDS_CLARIFICATION", "clarify", f"{names} 중 어느 쪽인지 말씀해 주세요.")
        if rx(r"^(더|다른\s*(거|것|제도)|다음\s*(거|것))\s*(알려|말해|있어|보여)?").search(text) and self.deps.welfare.has_matches:
            return self._welfare_draft(self.deps.welfare.more_matches(), "discover")
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
        if turn.from_voice:
            return self._clarify_heard(turn)
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
    "OPEN_OFFICIAL": lambda s, i, t: s._open_official(i.get("service"), t),
    "LOGIN": lambda s, i, t: s.browse.login(t.text, t.ctx),
    "CLEAR_LOGIN": lambda s, i, t: s.browse.clear_login(t.ctx),
    "READ_DOWNLOAD": lambda s, i, t: s.browse.read_download(i, t.text, t.ctx),
    "AUTH_DONE": lambda s, i, t: s.browse.auth_done(t.ctx),
    "FILL": lambda s, i, t: s.form.fill(i["fills"], t.ctx),
    "READ_FIELD": lambda s, i, t: s._read_field(i["fieldMention"], t),
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
    "DESCRIBE_PICTURE": lambda s, i, t: s.browse.picture(i["question"], t.ctx),
    "DESCRIBE_SCREEN": lambda s, i, t: s._describe_screen(t, i.get("exclusions", ())),
    "ABOUT_SITE": lambda s, i, t: _ready(s.browse.about_site()),
    "REPHRASE": lambda s, i, t: s._rephrase(t),
    "GOAL": lambda s, i, t: s.browse.run_goal(i["goal"], t.ctx),
    "DISCOVER": lambda s, i, t: s._discover(t),
    "FIND_PLACE": lambda s, i, t: _ready(s._find_place(t)),
    "SERVICE_DETAIL": lambda s, i, t: s._welfare_reply(s.deps.welfare.service_detail(i.get("service")), "discover"),
    "PRECHECK": lambda s, i, t: s._welfare_reply(s.deps.welfare.precheck(i.get("service"), s._profile), "precheck"),
    "PREPARE_APPLY": lambda s, i, t: s._welfare_reply(s.deps.welfare.prepare(i.get("service")), "prepare-apply"),
    "OPEN_BROWSER": lambda s, i, t: s._open_browser(t),
    "POLICY_QUESTION": lambda s, i, t: s._policy_question(i["topic"], t),
    "HELP_HUMAN": lambda s, i, t: _ready(s._help_human()),
    "READ_START_GUIDE": lambda s, i, t: _ready(draft(s.dialogue.state, "help",
        "청음은 동의를 받으면 공공서비스 웹사이트를 열고 화면과 신청 절차를 읽어 드립니다. "
        "음성과 읽어 드릴 문장은 설정한 음성 API에 전달하고, 질문과 화면 글은 설정한 AI로 보낼 수 있어요. "
        "화면 설명은 먼저 글로 확인해요. 그림을 봐야 답할 수 있으면 입력란을 가린 페이지 사진도 OpenAI에 보내요. 글로만 들으려면 '사진 없이 화면 설명해줘'라고 하세요. "
        "비밀번호나 주민등록번호는 말하지 마세요. 중요한 동작은 미리 확인하고 실제 제출과 본인 인증은 직접 하셔야 합니다. "
        "언제든 '멈춰'라고 말씀해 주세요.")),
    "WHAT_CAN_I_SAY": lambda s, i, t: _ready(s._what_can_i_say(bool(i.get("more")))),
    "INTRO_REPLAY": lambda s, i, t: _ready(s.first_run.intro_draft(replay=True)),
    # 화면이 처음 설정을 연다(app.js가 intentType을 보고). 동의 전에도 된다.
    "SETUP_RESTART": lambda s, i, t: _ready(draft(s.dialogue.state, "help", "처음 설정을 다시 열게요. 숫자 키와 Enter로 답해 주세요.")),
    "STOP": lambda s, i, t: _ready(draft("STOPPED", "stop", "멈췄습니다.")),
    # 보통은 handle_turn이 대기열 앞에서 답한다. 여기 오는 것은 여러 명령·질문 속의 물음뿐(대기열은 이 턴 자신이 잡고 있다).
    "PROGRESS": lambda s, i, t: _ready(s._progress_draft(busy=False)),
}
