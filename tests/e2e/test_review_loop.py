import asyncio
import json

import pytest

from conftest import FakeLlm
from cheongeum.orchestrator.public_task import PublicTask, parse_decision
from cheongeum.orchestrator.session import ReviewedTask


PARTS = ["행사 기간", "접수 장소"]
REQUEST = " 그리고 ".join(PARTS)
QUOTES = ["행사는 가을에 열립니다.", "접수 장소는 중앙 도서관입니다."]


def decision():
    return {
        "kind": "review_before_output", "source": "browser", "searchMode": "quiet", "agency": None,
        "subject": "행사", "goal": "행사 기간과 접수 장소 확인", "requestedFacts": ["dates", "location"],
        "exclusions": ["login"], "continuation": False, "question": None, "choices": [], "reply": None,
        "skill": None, "difficulty": "medium", "requirements": PARTS,
    }


def test_intake_accepts_all_requested_steps_within_the_hard_budget():
    requirements = [f"Visit the service record labeled {n}" for n in range(32)]
    result = parse_decision({**decision(), "difficulty": "hard", "requirements": requirements})
    assert result and result.requirements == requirements


async def test_public_retry_keeps_form_values_out_of_the_search(new_session):
    session = await new_session()
    alias = "GardenAster"
    question = f"Enter the alias {alias} and find visiting hours"
    turn = session._begin_turn(question)
    run = ReviewedTask(question, PublicTask(goal=question), ("find visiting hours",), "quiet", "medium",
                       counter=turn.ctx.counter, rounds=1, private_values=[alias])
    queries = []

    async def lookup(task, lang, signal):
        queries.append(task.goal)
        return {}

    session.deps.quiet_search = lookup
    await session._review_lookup(run, turn, run.requirements)
    assert len(queries) == 1 and alias not in queries[0] and "find visiting hours" in queries[0]


def verdict(payload):
    checks = []
    for part, quote in zip(PARTS, QUOTES):
        matches = [{"id": e["id"], "quote": quote} for e in payload["evidence"] if quote in e["text"]]
        checks.append({"request": part, "kind": "fact", "citations": matches[:1]})
    complete = all(row["citations"] for row in checks)
    return {"checks": checks, "answer": " ".join(QUOTES) if complete else "", "nextRoute": None if complete else "quiet"}


@pytest.mark.parametrize(("difficulty", "limit"), [("easy", 2), ("medium", 3), ("hard", 5), (None, 3)])
async def test_missing_fact_retries_in_same_turn_and_keeps_first_quote(new_session, difficulty, limit):
    s = await new_session()
    searches = []
    def model(**call):
        if call["schemaName"] == "public_service_decision":
            return decision()
        if call["schemaName"] == "review_before_output":
            assert s.progress.snapshot()["spoken"] is False
            return verdict(json.loads(call["user"]))
    async def lookup(task, lang, signal):
        searches.append(task)
        index = len(searches) - 1
        return {"speech": "검토 전 초안", "reviewQuotes": [QUOTES[index]], "sources": [
            {"url": f"https://www.gov.kr/event/{index}", "title": "행사 자료", "lastCheckedAt": "2026-11-20"}]}
    s.deps.quiet_search = lookup
    s.deps.llm = FakeLlm(fn=model)
    result = await s.handle_turn(REQUEST, from_voice=bool(difficulty), difficulty=difficulty)
    assert result["review"] == {"status": "completed", "difficulty": difficulty or "medium",
                                "rounds": 2, "maxRounds": limit, "browserIterations": 0}
    assert result["semanticAction"] == "review-before-output" and result["speech"] == " ".join(QUOTES)
    assert len(searches) == 2 and PARTS[1] in searches[-1].goal and searches[-1].exclusions == ("login",)
    assert len(result["sources"]) == 2 and result["actions"] == []
    assert all("검토 전 초안" not in entry["text"] for entry in s.export_history())


async def test_no_progress_or_missing_reviewer_never_announces_success(new_session):
    s = await new_session()
    def model(**call):
        if call["schemaName"] == "public_service_decision":
            return decision()
        if call["schemaName"] == "review_before_output":
            return verdict(json.loads(call["user"]))
    async def lookup(task, lang, signal):
        return {"speech": "완료했다고 주장하는 초안", "sources": [{"url": "https://www.gov.kr/",
                "title": "포털", "lastCheckedAt": "2026-11-20"}]}
    s.deps.llm = FakeLlm(fn=model)
    s.deps.quiet_search = lookup
    result = await s.handle_turn(REQUEST, from_voice=True, difficulty="hard")
    assert result["review"]["status"] == "incomplete" and result["review"]["rounds"] == 2
    assert "접수 장소" in result["speech"] and "주장하는 초안" not in result["speech"]


async def test_stop_cancels_outstanding_review_without_another_lookup(new_session):
    s = await new_session()
    reviewing = asyncio.Event()
    calls = []
    async def model(**call):
        if call["schemaName"] == "public_service_decision":
            return decision()
        reviewing.set()
        await asyncio.Event().wait()
    async def lookup(task, lang, signal):
        calls.append(task)
        return {}
    s.deps.llm = FakeLlm()
    s.deps.llm.generate = model
    s.deps.quiet_search = lookup
    pending = asyncio.create_task(s.handle_turn(REQUEST))
    await asyncio.wait_for(reviewing.wait(), 8)
    stopped = await s.handle_turn("멈춰")
    result = await asyncio.wait_for(pending, 5)
    assert stopped["state"] == result["state"] == "STOPPED"
    assert len(calls) == 1 and not result.get("review")


@pytest.mark.parametrize(("difficulty", "limit"), [("easy", 2), ("medium", 3), ("hard", 5)])
async def test_new_evidence_cannot_extend_the_selected_iteration_limit(new_session, difficulty, limit):
    s = await new_session()
    searches = []
    def model(**call):
        if call["schemaName"] == "public_service_decision":
            return decision()
        if call["schemaName"] == "review_before_output":
            return verdict(json.loads(call["user"]))
    async def lookup(task, lang, signal):
        searches.append(task)
        return {"speech": "장소를 찾는 중이에요.", "sources": [
            {"url": "https://www.gov.kr/event", "title": "공고", "lastCheckedAt": "2026-11-20"}],
            "reviewQuotes": [QUOTES[0], f"공고 개정 이력 {len(searches)}"]}
    s.deps.llm = FakeLlm(fn=model)
    s.deps.quiet_search = lookup
    final = await s.handle_turn(REQUEST, from_voice=True, difficulty=difficulty)
    assert len(searches) == final["review"]["rounds"] == final["review"]["maxRounds"] == limit
    assert final["review"]["status"] == "incomplete"
    assert PARTS[1] in final["speech"] and "장소를 찾는 중" not in final["speech"]
