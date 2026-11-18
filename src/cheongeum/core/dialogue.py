"""대화가 지금 어디에 서 있는지: 세션 상태 하나와 "무엇을 기다리는가" 여섯 자리."""
from __future__ import annotations


class DialogueState:
    """
    세션당 하나. 밖에서는 읽기만 하고(setter 없음), 바꾸는 길은 아래 동작뿐이다. 동작마다 부르는 곳을 적어 둔다.
    여섯 자리는 서로 독립이라 동시에 둘 이상 설 수 있다.
    이벤트 루프 하나에서만 쓴다. 멈춤(stop)은 락 밖에서 오고, 그 뒤 진행 중이던 턴의 commit은 오케스트레이터가 epoch으로 막는다.
    """

    __slots__ = ("_state", "_approval", "_awaiting", "_clarification", "_profile_question", "_vault_confirm", "_guided")

    def __init__(self, state: str) -> None:
        self._state = state
        self._approval: dict | None = None
        self._awaiting: str | None = None
        self._clarification: dict | None = None
        self._profile_question: str | None = None
        self._vault_confirm: dict | None = None
        self._guided: dict | None = None

    @property
    def state(self) -> str:
        """세션 상태(IDLE, BROWSING, APPLICATION_OPEN …)"""
        return self._state

    @property
    def approval(self) -> dict | None:
        """승인 대기 {'kind'?, 'action', 'actions'?, 'confirmation'}. kind 없음 = 모의접수 클릭, 'assist' = 실제 사이트 입력란 채우기(제출은 사용자가 직접)."""
        return self._approval

    @property
    def confirmation(self) -> dict | None:
        """승인 대기의 confirmation(snapshot·TurnResult의 pendingConfirmation)"""
        return (self._approval or {}).get("confirmation")

    @property
    def expects_confirmation(self) -> bool:
        """승인 대기 중이거나 상태가 WAITING_FOR_USER_CONFIRMATION(외국어 승인 단어 판정용)"""
        return bool(self._approval) or self._state == "WAITING_FOR_USER_CONFIRMATION"

    @property
    def awaiting(self) -> str | None:
        """다음에 값만 말해도 채울 fieldId"""
        return self._awaiting

    @property
    def clarification(self) -> dict | None:
        """어느 입력란인지 되묻는 중 {'value', 'candidates': [FieldProfile]}"""
        return self._clarification

    @property
    def profile_question(self) -> str | None:
        """맞춤 복지 찾기에서 지금 묻고 있는 항목"""
        return self._profile_question

    @property
    def vault_confirm(self) -> dict | None:
        """저장·삭제 확인을 기다리는 금고 명령"""
        return self._vault_confirm

    @property
    def guided(self) -> dict | None:
        """실제 사이트 칸을 하나씩 묻고 채우는 중 {'url', 'fieldIds', 'index', 'suggestion'?}. index·suggestion은 GuidedFill이 이 dict를 직접 고친다."""
        return self._guided

    def commit(self, state: str) -> None:
        """턴의 결과 상태를 확정한다. (SessionOrchestrator._finish)"""
        self._state = state

    def stop(self) -> None:
        """
        멈춤: 승인 대기·값 대기·되묻기만 지운다. 맞춤 찾기 질문·금고 확인·칸 채우기는 남는다(지금 동작 그대로).
        (SessionOrchestrator._stop, 락 밖에서)
        """
        self._approval = None
        self._awaiting = None
        self._clarification = None

    def ask_approval(self, approval: dict) -> None:
        """실행 직전 승인을 물었다. (FormSkill._assist_fill_request, FormSkill.prepare_submit)"""
        self._approval = approval

    def clear_approval(self) -> None:
        """승인 요청이 끝났거나 무효. (FormSkill.assist_approved, submit_approved, reject, edit_field)"""
        self._approval = None

    def ask_value(self, field_id: str) -> None:
        """
        이 항목 값을 물었다: 다음에 값만 말해도 채운다.
        (FormSkill.ask_next, fill_one 형식 오류, edit_field, _after_step_move 검증 오류)
        """
        self._awaiting = field_id

    def drop_value_wait(self) -> None:
        """값 대기를 접는다. (SessionOrchestrator._open_application, FormSkill._after_step_move 이동 성공, FormSkill.prepare_submit)"""
        self._awaiting = None

    def value_filled(self, field_id: str) -> None:
        """값을 넣었다: 기다리던 항목이면 대기를 풀고, 내용이 바뀌었으니 승인 요청은 무효. (FormSkill.fill_one)"""
        if self._awaiting == field_id:
            self._awaiting = None
        self._approval = None

    def navigated(self, on_form: bool) -> None:
        """다른 페이지로 갔다: 승인 요청은 무효, 신청서 화면이 아니면 값 대기도 접는다. (BrowseSkill.after_navigation)"""
        self._approval = None
        if not on_form:
            self._awaiting = None

    def ask_which(self, value: str, candidates: list) -> None:
        """value를 넣을 입력란이 여럿이라 어느 쪽인지 물었다. (FormSkill._resolve)"""
        self._clarification = {"value": value, "candidates": candidates}

    def clear_choice(self) -> None:
        """되묻기를 접는다. (SessionOrchestrator._route 두 곳, _short_reply)"""
        self._clarification = None

    def ask_profile(self, slot: str) -> None:
        """맞춤 복지 찾기 항목을 물었다. (SessionOrchestrator._discover_step)"""
        self._profile_question = slot

    def profile_done(self) -> None:
        """맞춤 찾기 질문을 접는다. (SessionOrchestrator._discover_step 다 모임, _process_korean 다른 명령)"""
        self._profile_question = None

    def ask_vault_confirm(self, command: dict) -> None:
        """금고 저장·삭제를 해도 되는지 물었다. (PersonalDialogue.run 두 곳)"""
        self._vault_confirm = command

    def take_vault_confirm(self) -> dict | None:
        """확인 대기를 꺼내면서 지운다. (PersonalDialogue.confirm)"""
        command, self._vault_confirm = self._vault_confirm, None
        return command

    def start_guided(self, url: str, field_ids: list[str]) -> None:
        """이 페이지의 칸을 하나씩 묻기 시작한다. (GuidedFill.start)"""
        self._guided = {"url": url, "fieldIds": field_ids, "index": 0}

    def end_guided(self) -> None:
        """칸 채우기를 접는다. (GuidedFill.active 페이지를 떠남, GuidedFill.answer 네 곳)"""
        self._guided = None
