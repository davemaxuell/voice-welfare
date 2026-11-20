"""A reviewed task follows live page observations and resumes from a bound field approval."""
import json
from urllib.parse import urlsplit

import pytest
from conftest import FakeLlm, flat, with_llm


PARTS = ("정부24를 열고", "방문 안내 링크를 누르고", "별칭 칸에 민들레를 입력하고", "이용 시간 안내 링크를 열어줘")
REQUEST = " ".join(PARTS)
VALUE = "민들레"
ANSWER = "방문 안내에서 별칭을 입력하고 이용 시간 안내 페이지를 열었어요."


async def install_pages(session):
    pages = {
        "/guide": ('방문 안내', """<label for="alias">별칭</label><input id="alias">
            <a href="/hours">이용 시간 안내</a>"""),
        "/hours": ("이용 시간 안내", "<p>운영 시간은 평일 오전부터입니다.</p>"),
    }
    documents = []

    async def serve(route):
        url = urlsplit(route.request.url)
        if url.hostname != "www.gov.kr" or route.request.resource_type != "document":
            return await route.abort()
        path = url.path
        documents.append(path)
        title, body = pages.get(path, ("정부24", '<a href="/guide">방문 안내</a>'))
        await route.fulfill(content_type="text/html; charset=utf-8", body=f"""<!doctype html>
            <html lang="ko"><title>{title}</title><main><h1>{title}</h1>{body}</main>
            <script>document.addEventListener('input', event => {{
                sessionStorage.setItem('alias', event.target.value);
                sessionStorage.setItem('inputs', String(Number(sessionStorage.getItem('inputs')) + 1));
            }});</script></html>""")

    await session.web.adapter.page.context.route("**/*", serve)
    return documents


def planned_model():
    def generate(*, schemaName, user, **_):
        if schemaName == "public_service_decision":
            return {
                "kind": "review_before_output", "agency": "정부24", "source": None, "searchMode": None,
                "subject": "방문 안내", "goal": "방문 안내를 열어 별칭 입력 후 이용 시간 안내를 연다",
                "requestedFacts": [], "exclusions": [], "continuation": False, "choices": [],
                "question": None, "skill": None, "reply": None, "difficulty": "medium", "requirements": list(PARTS),
            }
        if schemaName == "intent_plan":
            return {"steps": [
                flat("OPEN_SITE", site="정부24"), flat("FOLLOW_LINK", topic="방문 안내"),
                flat("FILL", fills=[{"fieldMention": "별칭", "value": VALUE}]), flat("FOLLOW_LINK", topic="이용 시간 안내"),
            ]}
        if schemaName == "review_before_output":
            payload = json.loads(user)
            assert VALUE not in user
            checks = []
            for part, kind, marker in zip(payload["requirements"], ("visit", "action", "action", "arrival"),
                                          ("정부24", "click 방문 안내", "fill 별칭", "/hours")):
                expected = "action" if kind == "action" else "page"
                row = next(e for e in payload["evidence"] if e["kind"] == expected and marker in e["text"])
                if marker == "fill 별칭":
                    assert row["valueVerified"] is True
                citations = [{"id": row["id"], "quote": row["text"]}]
                if kind == "arrival":
                    click = next(e for e in payload["evidence"] if e["text"] == "click 이용 시간 안내")
                    citations.insert(0, {"id": click["id"], "quote": click["text"]})
                checks.append({"request": part, "kind": kind, "citations": citations})
            return {"checks": checks, "nextRoute": None, "answer": ANSWER}
        return None

    return FakeLlm(fn=generate)


@pytest.mark.parametrize("decision", ["approve", "decline", "stale", "stop"])
async def test_reviewed_open_click_fill_click(new_session, decision):
    session = await new_session()
    documents = await install_pages(session)
    model = planned_model()
    with_llm(session, model)

    first = await session.handle_turn(REQUEST)
    assert first["state"] == "WAITING_FOR_USER_CONFIRMATION", first["speech"]
    assert first["review"]["status"] == "needs_input"
    approval_id = first["pendingConfirmation"]["actionId"]
    page = session.web.adapter.page
    assert await page.locator("#alias").input_value() == ""
    assert documents.count("/guide") == 1 and "/hours" not in documents
    assert not any(call["schemaName"] == "review_before_output" for call in model.calls)

    if decision == "stop":
        assert (await session.handle_turn("멈춰"))["state"] == "STOPPED"
        await session.confirm(True, approval_id)
    else:
        if decision == "stale":
            await page.evaluate("history.pushState({}, '', '?record=another')")
        final = await session.confirm(decision != "decline", approval_id)
        if decision == "approve":
            assert final["semanticAction"] == "review-before-output", final["speech"]
            assert final["review"] == {"status": "completed", "difficulty": "medium", "rounds": 1,
                                       "maxRounds": 3, "browserIterations": 0}, final["speech"]
            assert final["speech"] == ANSWER
            assert page.url.endswith("/hours")
            assert await page.evaluate("sessionStorage.getItem('alias')") == VALUE
            assert await page.evaluate("sessionStorage.getItem('inputs')") == "1"
            assert documents.count("/guide") == documents.count("/hours") == 1
            assert sum(call["schemaName"] == "review_before_output" for call in model.calls) == 1
            return
    assert not await page.evaluate("sessionStorage.getItem('alias')")
    assert documents.count("/guide") == 1 and "/hours" not in documents


async def test_final_arrival_is_checked_after_the_reviewer_replies(new_session):
    session = await new_session()
    await install_pages(session)
    model = planned_model()
    generate = model.generate

    async def review_after_user_navigates(**kwargs):
        result = await generate(**kwargs)
        if kwargs["schemaName"] == "review_before_output":
            await session.web.adapter.page.goto("https://www.gov.kr/guide")
        return result

    model.generate = review_after_user_navigates
    with_llm(session, model)
    proposal = await session.handle_turn(REQUEST)
    final = await session.confirm(True, proposal["pendingConfirmation"]["actionId"])
    assert final["review"]["status"] == "incomplete"
    assert ANSWER not in final["speech"]
    assert session.web.adapter.page.url.endswith("/guide")
    assert await session.web.adapter.page.evaluate("sessionStorage.getItem('inputs')") == "1"
