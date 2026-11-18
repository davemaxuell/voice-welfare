"""신청서·웹 읽기 기술과 오케스트레이터가 함께 쓰는 순수 함수: 화면 종류에 맞는 상태, 신청서가 열렸는지, 실패 안내."""
from __future__ import annotations

from cheongeum.agents.web.agent import WebOutcome
from cheongeum.core.turn import draft


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


def outcome_failure(out: WebOutcome, fallback_state: str) -> dict:
    denied = out.status == "policy-denied"
    state = "STOPPED" if out.status == "aborted" else fallback_state if denied else "RECOVERING"
    return draft(
        state,
        "none",
        f"{out.message or '실행하지 못했습니다.'} {'안전 규칙에 따라 실행하지 않았습니다.' if denied else '다시 시도하거나 다른 명령을 말씀해 주세요.'}",
        actions=out.actions,
        view=out.view,
    )
