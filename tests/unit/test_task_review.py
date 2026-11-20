import asyncio
import json
from unittest.mock import AsyncMock, Mock

import pytest

from cheongeum.core.jsutil import AbortController
from cheongeum.orchestrator.task_review import ReviewEvidence, evidence_from_draft, page_matches, review_before_output


REQUEST = "Fill the applicant name, open the visit guide, and find the deadline."
REQUIREMENTS = ("Fill the applicant name", "open the visit guide", "find the deadline")
RECORDS = [
    ReviewEvidence("action", "fill Applicant name"),
    ReviewEvidence("page", "https://office.example/visits · Visit guide"),
    ReviewEvidence("fact", "Applications close on November 28."),
]


def check(request, kind, index=None, quote=None):
    return {"request": request, "kind": kind, "citations": [] if index is None else [{"id": index, "quote": quote}]}


def complete():
    return {"checks": [check(req, kind, i, record.text)
                       for i, (req, kind, record) in enumerate(zip(REQUIREMENTS, ("action", "arrival", "fact"), RECORDS))],
            "nextRoute": None, "answer": "I filled the applicant name and opened the visit guide. Applications close on November 28."}


async def decide(raw, *, evidence=RECORDS, request=REQUEST, requirements=REQUIREMENTS):
    return await review_before_output(Mock(generate=AsyncMock(return_value=raw)), request, evidence,
                                      AbortController().signal, language="en", requirements=requirements)


async def test_review_releases_only_the_completed_grounded_result():
    raw = complete()
    verdict = await decide(raw)
    assert verdict.status == "complete" and verdict.answer == raw["answer"] and verdict.next_route is None


async def test_partial_review_retries_only_the_unanswered_original_fact():
    raw = complete()
    raw["checks"][-1]["citations"] = []
    raw.update(nextRoute="browser", answer="")
    verdict = await decide(raw, evidence=RECORDS[:2])
    assert (verdict.status, verdict.answer, verdict.next_route, verdict.missing) == ("retry", "", "browser", ("find the deadline",))
    raw["checks"][-1]["request"] = "submit a new application"
    assert (await decide(raw)).status == "incomplete"


@pytest.mark.parametrize("change", ["missing", "merged", "wrong-kind", "fabricated-quote", "partial-action",
                                   "unsupported-number", "unsupported-small-number", "nominal-id", "unknown-route"])
async def test_review_does_not_publish_invalid_evidence_or_claims(change):
    raw = complete()
    checks = raw["checks"]
    if change == "missing":
        checks.pop()
    elif change == "merged":
        checks[:] = [check(REQUEST, "fact", 2, RECORDS[2].text)]
    elif change == "wrong-kind":
        checks[0]["citations"] = checks[1]["citations"]
    elif change == "fabricated-quote":
        checks[2]["citations"][0]["quote"] = "Applications close on May 30."
    elif change == "partial-action":
        checks[0]["citations"][0]["quote"] = "Applicant name"
    elif change == "unsupported-number":
        raw["answer"] += " The deadline is the 27th."
    elif change == "unsupported-small-number":
        raw["answer"] += " You have 3 days."
    elif change == "nominal-id":
        checks[0]["citations"][0]["id"] = False
    else:
        raw["nextRoute"] = "submit_form"
    verdict = await decide(raw)
    assert verdict.status == "incomplete" and not verdict.answer and not verdict.next_route


async def test_last_arrival_must_match_current_page_including_repeat_visits():
    raw = complete()
    records = [*RECORDS, ReviewEvidence("page", "https://office.example/ · Welcome")]
    assert (await decide(raw, evidence=records)).status == "incomplete"
    raw["checks"][1]["citations"].append({"id": 3, "quote": "Welcome"})
    assert (await decide(raw, evidence=records)).status == "incomplete"
    raw["checks"][1]["citations"].pop()
    # 다시 방문한 화면이 처음 봤던 화면이어도 최종 위치 확인에 쓸 수 있다.
    records.append(RECORDS[1])
    raw["checks"][1]["citations"][0]["id"] = 4
    assert (await decide(raw, evidence=records)).status == "complete"


async def test_requested_order_of_two_page_visits_requires_chronological_observations():
    parts = ("Visit Eligibility", "visit Service details")
    request = " then ".join(parts)
    records = [ReviewEvidence("page", "Eligibility selected"), ReviewEvidence("page", "Service details selected")]
    checks = [check(part, "visit", index, record.text) for index, (part, record) in enumerate(zip(parts, records))]
    raw = {"checks": checks, "nextRoute": None, "answer": "I visited Eligibility and then Service details."}
    assert (await decide(raw, evidence=records, request=request, requirements=parts)).status == "complete"
    checks[0]["citations"][0]["id"], checks[1]["citations"][0]["id"] = 1, 0
    wrong_order = await decide(raw, evidence=list(reversed(records)), request=request, requirements=parts)
    assert wrong_order.status == "incomplete" and wrong_order.repair_reason == "sequence"


def action(kind, target, *, allowed=True, ok=True, verified=True, result_id="a", value=""):
    return {"policy": {"allowed": allowed}, "action": {"id": "a", "type": kind, "target": target, "value": value},
            "result": {"actionId": result_id, "ok": ok, "verified": verified, "readValue": value}}


def test_receipts_require_success_permission_and_matching_id_and_never_contain_field_values():
    private = "Marina Example"
    draft = {"speech": "I submitted everything.", "researchEvidence": "I got a receipt.",
             "view": {"url": "https://office.example/start?token=private-link-token", "title": "Visit guide",
                      "fields": [{"fieldId": "n", "label": "Applicant name", "value": private}]},
             "actions": [action("fill", {"fieldId": "n"}, value=private),
                         action("click", {"name": "Rejected"}, allowed=False),
                         action("click", {"name": "Failure"}, ok=False),
                         action("click", {"name": "Unverified"}, verified=False),
                         action("click", {"name": "Stale"}, result_id="other")],
             "reviewQuotes": ["Applications close on Friday."]}
    rows = evidence_from_draft(draft)
    assert len(rows) == 2
    assert rows[0] == ReviewEvidence("action", "fill Applicant name", "a", value_verified=True)
    assert rows[1].text == "https://office.example/start · Visit guide" and rows[1].kind == "page"
    draft["sources"] = [{"title": "Schedule", "url": "https://office.example/visit"}]
    assert evidence_from_draft(draft)[-1] == ReviewEvidence("fact", "Applications close on Friday.",
                                                            sources=("Schedule · https://office.example/visit",))
    draft["view"]["fields"].append({"fieldId": "p", "type": "password"})
    assert "page" not in [r.kind for r in evidence_from_draft(draft)]


async def test_twice_needs_two_distinct_matching_action_receipts():
    request = "Click Next twice."
    first = ReviewEvidence("action", "click Next", "local-1")
    second = ReviewEvidence("action", "click Next", "local-2")
    c = check(request, "action", 0, first.text)
    raw = {"checks": [c], "nextRoute": None, "answer": "I clicked Next 2 times."}
    assert (await decide(raw, evidence=[first], request=request, requirements=())).status == "incomplete"
    c["citations"].append({"id": 1, "quote": first.text})
    assert (await decide(raw, evidence=[first, first], request=request, requirements=())).status == "incomplete"
    assert (await decide(raw, evidence=[first, second], request=request, requirements=())).status == "complete"


async def test_actions_in_a_sequence_cannot_consume_an_old_receipt_twice_or_out_of_order():
    request = "Click Next and click Next."
    c1, c2 = check("Click Next", "action", 0, "click Next"), check("click Next", "action", 0, "click Next")
    raw = {"checks": [c1, c2], "nextRoute": None, "answer": "I clicked both times."}
    records = [ReviewEvidence("action", "click Next", f"local-{i}") for i in (1, 2)]
    assert (await decide(raw, evidence=records, request=request, requirements=())).status == "incomplete"
    c1["citations"][0]["id"] = 1
    assert (await decide(raw, evidence=records, request=request, requirements=())).status == "incomplete"
    c1["citations"][0]["id"], c2["citations"][0]["id"] = 0, 1
    assert (await decide(raw, evidence=records, request=request, requirements=())).status == "complete"


async def test_private_values_are_omitted_from_the_request_requirements_and_evidence():
    model = Mock(generate=AsyncMock(return_value=None))
    secret = "Name With Private Address"
    req = f"Fill name {secret} on https://office.example/start?token=private-link-token"
    await review_before_output(model, req, [ReviewEvidence("page", req)], AbortController().signal,
                               requirements=[req], private_values=[secret])
    payload = model.generate.await_args.kwargs["user"]
    assert secret not in payload and "private-link-token" not in payload
    assert json.loads(payload)["requirements"]


async def test_only_the_verified_public_office_phone_can_be_spoken():
    office, private = "02-1234-5678", "010-1234-5678"
    draft = {"semanticAction": "find-place", "sources": [{"title": "기관 연락처",
             "url": "https://www.data.go.kr/data/records/fileData.do", "note": office}], "reviewQuotes": [office, private]}
    rows = evidence_from_draft(draft)
    assert [row.text for row in rows] == [office]
    request = "What is the official contact number?"
    raw = {"checks": [check(request, "fact", 0, office)], "nextRoute": None, "answer": office}
    assert (await decide(raw, evidence=rows, request=request, requirements=())).answer == office


def test_each_quote_in_a_comparison_keeps_its_own_verified_source():
    urls = ("https://office.example/east", "https://office.example/west")
    quotes = ("East opens Monday.", "West opens Tuesday.")
    draft = {"sources": [{"url": url} for url in urls], "reviewQuotes": list(quotes),
             "reviewQuoteSources": {quote: [url] for quote, url in zip(quotes, urls)}}
    assert [(r.text, r.sources) for r in evidence_from_draft(draft)] == list(zip(quotes, [(u,) for u in urls]))
    del draft["reviewQuoteSources"]
    assert evidence_from_draft(draft) == []


async def test_page_visits_and_displayed_tab_contents_follow_actual_clicks():
    original = "https://office.example/details?record=summer"
    view = {"url": original, "title": "Details", "outline": {"items": [
        {"name": "Documents", "role": "tab", "selected": True}]}}
    draft = {"actions": [action("click", {"name": "Documents"})], "reviewPages": [
        {"url": "https://office.example/home", "title": "Agency", "afterActionId": "", "text": "Welcome"},
        {"url": "https://office.example/details", "title": "Details", "afterActionId": "a",
         "selected": ["Documents"], "text": "Bring a signed copy of the application."},
    ], "view": view}
    records = evidence_from_draft(draft)
    assert [r.kind for r in records] == ["page", "fact", "action", "page", "fact", "page"]
    assert "Documents" in records[3].text and "signed copy" in records[4].text
    req = "Open Documents."
    raw = {"checks": [check(req, "arrival", 5, "Documents")], "nextRoute": None, "answer": "I opened Documents."}
    raw["checks"][0]["citations"].append({"id": 2, "quote": "click Documents"})
    result = await decide(raw, evidence=records, request=req, requirements=())
    assert result.status == "complete" and page_matches(result, view)
    assert not page_matches(result, {**view, "url": original.replace("summer", "winter")})
    assert not page_matches(result, {**view, "outline": {"items": []}})
    assert "record=summer" not in repr(result)


async def test_tab_visit_with_page_corroboration_and_verified_markdown_reference():
    req = "Read the requirements and tell me the deadline."
    parts = ["Read the requirements", "tell me the deadline"]
    source = "https://office.example/program/53021"
    rows = [ReviewEvidence("page", source + " · Help"), ReviewEvidence("action", "click Requirements", "ui"),
            ReviewEvidence("page", source + " · Requirements selected"),
            ReviewEvidence("fact", "Filing closes on Monday.", sources=(source,))]
    visit = check(parts[0], "visit", 0, "Help")
    visit["citations"].extend([{"id": 1, "quote": "click Requirements"}, {"id": 2, "quote": "Requirements selected"},
                               {"id": 3, "quote": "Filing closes on Monday."}])
    fact = check(parts[1], "fact", 3, rows[3].text)
    fact["citations"].append({"id": 2, "quote": "Requirements selected"})
    raw = {"checks": [visit, fact], "nextRoute": None, "answer": f"On [the requirements page]({source}), filing closes on Monday."}
    result = await decide(raw, evidence=rows, request=req, requirements=parts)
    assert result.answer == "On the requirements page, filing closes on Monday."
    raw["answer"] = raw["answer"].replace("53021", "99999")
    invalid = await decide(raw, evidence=rows, request=req, requirements=parts)
    assert invalid.status == "incomplete" and invalid.repair_reason == "answer"


async def test_locked_in_field_needs_exact_readback_to_emit_confirmation():
    first = action("fill", {"name": "Nickname"}, value="private-nickname")
    first["result"]["readValue"] = "different-nickname"
    assert not evidence_from_draft({"actions": [first]})
    first["result"]["readValue"] = first["action"]["value"]
    row, = evidence_from_draft({"actions": [first]})
    assert row.value_verified and row.text == "fill Nickname"


async def test_stop_cancels_a_pending_review_without_returning_a_result():
    controller = AbortController()
    started = asyncio.Event()

    async def held(**kwargs):
        started.set()
        await asyncio.Event().wait()

    pending = asyncio.create_task(review_before_output(Mock(generate=held), REQUEST, RECORDS, controller.signal))
    await asyncio.wait_for(started.wait(), 2)
    controller.abort()
    result = await asyncio.wait_for(pending, 2)
    assert result.status == "incomplete" and not result.answer


async def test_missing_provider_or_schema_failure_cannot_release_a_draft():
    empty = await review_before_output(None, REQUEST, RECORDS, AbortController().signal)
    failed = await review_before_output(Mock(generate=AsyncMock(side_effect=TimeoutError)), REQUEST, RECORDS, AbortController().signal)
    malformed = await decide({"answer": "All done."})
    assert all(result.status == "incomplete" and result.answer == "" for result in (empty, failed, malformed))
    assert not empty.repair_reason and not failed.repair_reason and malformed.repair_reason == "shape"
