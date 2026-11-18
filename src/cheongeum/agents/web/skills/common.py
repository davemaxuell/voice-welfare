"""신청서·웹 읽기 기술과 오케스트레이터가 함께 쓰는 순수 함수: 화면 종류에 맞는 상태, 신청서가 열렸는지, 실패 안내, 결과 말 세 갈래, 됐는지 모를 때 다시 묻기, 막다른 길 다음 단계."""
from __future__ import annotations

from cheongeum.agents.web.agent import WebOutcome
from cheongeum.agents.web.effect import click_note, press_result, unconfirmed_message
from cheongeum.agents.web.playbook import blocked_speech, help_human_speech, next_step
from cheongeum.core.turn import draft

# 오케스트레이터·Narrator·시험이 common을 통해 쓰도록 다시 내보낸다.
# press_result·unconfirmed_message·click_note 본문은 agents.web.effect(레이어상 autopilot도 씀).
__all__ = [
    "ask_again",
    "blocked_speech",
    "browse_state",
    "click_note",
    "fill_confirmed",
    "help_human_draft",
    "help_human_speech",
    "is_form_open",
    "not_open",
    "outcome_failure",
    "press_result",
    "unconfirmed_message",
]


def browse_state(view: dict) -> str:
    """화면 종류에 맞는 세션 상태"""
    page = view.get("pageId")
    if page == "mock-welfare":
        return "MOCK_SUBMITTED" if view.get("status") else "APPLICATION_OPEN"
    if page == "mock-login":
        return "AUTH_HANDOFF"
    if page == "blank":
        return "IDLE"
    return "BROWSING"


def is_form_open(view: dict | None) -> bool:
    return bool(view) and view.get("pageId") == "mock-welfare" and bool(view.get("step")) and not view.get("status")


def not_open(current: dict | None, state: str) -> dict:
    keep = ("AUTH_HANDOFF", "MOCK_SUBMITTED", "BROWSING")
    return draft(
        state if state in keep else "IDLE",
        "none",
        "이 사이트에서는 입력을 대신하지 않아요. 읽기, 이동, 검색만 도와드려요."
        if current and current.get("pageId") == "external"
        else "지금 화면에는 입력할 신청서가 없어요. 무엇을 도와드릴까요?",
    )


def fill_confirmed(label: str, shown: str, guide: str = "") -> str:
    """입력 확인됨: 화면에 들어간 값을 다시 읽어 맞춘 뒤 말한다."""
    return f'{label}에 "{shown}" 넣었어요. {guide}'.strip()


def outcome_failure(out: WebOutcome, fallback_state: str) -> dict:
    denied = out.status == "policy-denied"
    state = "STOPPED" if out.status == "aborted" else fallback_state if denied else "RECOVERING"
    url = (out.view or {}).get("url") if out.view else None
    if denied:
        tail = next_step("policy-denied", url)
        body = f"{out.message or '실행하지 못했습니다.'} 안전 규칙에 따라 실행하지 않았습니다. {tail}"
    else:
        body = f"{out.message or '실행하지 못했습니다.'} 다시 시도하거나 다른 명령을 말씀해 주세요."
    return draft(state, "none", body, actions=out.actions, view=out.view)


def ask_again(out: WebOutcome, semantic: str, how: str) -> dict:
    """
    승인받은 조작이 됐는지 확인하지 못했다(unconfirmed): 저절로 다시 하지 않고 승인 대기를 그대로 둔 채 사용자에게 묻는다.
    '응'이면 승인 문(SessionOrchestrator._approve)이 화면을 다시 보고 그대로일 때만 한 번 더 한다.
    """
    return draft("WAITING_FOR_USER_CONFIRMATION", semantic, f"{out.message} 다시 할까요? {how}", actions=out.actions, view=out.view)


def help_human_draft(
    state: str,
    *,
    contact_name: str | None = None,
    contact_number: str | None = None,
    url: str | None = None,
    service_name: str | None = None,
    step_hint: str | None = None,
) -> dict:
    return draft(
        state,
        "help",
        help_human_speech(
            contact_name=contact_name,
            contact_number=contact_number,
            url=url,
            service_name=service_name,
            step_hint=step_hint,
        ),
    )
