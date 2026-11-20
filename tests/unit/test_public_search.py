from unittest.mock import AsyncMock

import pytest

from cheongeum.core.jsutil import AbortSignal
from cheongeum.orchestrator.public_task import PublicTask
from cheongeum.server import public_search


QUESTION = PublicTask(goal="대한민국 어린이날 날짜", facts=("dates",))
PAGE = {"url": "https://www.korea.kr/news/holiday", "title": "공휴일 안내", "content": "어린이날은 5월 5일입니다."}


async def test_refines_empty_results_and_cites_the_matching_official_excerpt(monkeypatch):
    fetch = AsyncMock(side_effect=[{"results": []}, {"results": [
        {**PAGE, "url": "https://korea.kr.example.org/holiday"}, PAGE]}])
    monkeypatch.setattr(public_search, "post_json", fetch)
    model = AsyncMock()
    model.generate.side_effect = [
        {"answer": "", "citations": [], "retryQuery": "대한민국 공휴일 어린이날 공식 달력"},
        {"answer": "Children’s Day is May 5.", "citations": [{"index": 0, "quote": PAGE["content"]}], "retryQuery": None},
    ]
    result = await public_search.TavilySearch("test", model, None)(QUESTION, "en", AbortSignal())
    assert [c.args[2]["query"] for c in fetch.await_args_list] == [QUESTION.goal, "대한민국 공휴일 어린이날 공식 달력"]
    assert result["speech"] == "Children’s Day is May 5."
    assert [s["url"] for s in result["sources"]] == [PAGE["url"]]


@pytest.mark.parametrize("quote", ["어린이날은 6월 20일입니다.", PAGE["content"]])
async def test_unverified_citation_or_date_returns_no_answer(monkeypatch, quote):
    monkeypatch.setattr(public_search, "post_json", AsyncMock(return_value={"results": [PAGE]}))
    model = AsyncMock()
    model.generate.return_value = {"answer": "June 20.", "citations": [{"index": 0, "quote": quote}], "retryQuery": None}
    assert not await public_search.TavilySearch("test", model, None)(QUESTION, "en", AbortSignal())


async def test_private_query_never_reaches_search_provider(monkeypatch):
    fetch = AsyncMock()
    monkeypatch.setattr(public_search, "post_json", fetch)
    task = PublicTask(goal="Search for tvly-" + "private-test-token")
    assert not await public_search.TavilySearch("test", AsyncMock(), None)(task, "en", AbortSignal())
    fetch.assert_not_awaited()


def test_next_date_can_restate_the_reference_date_and_cite_the_calendar_year():
    quote = "12월 25~27일(기독탄신일 및 토·일요일, 3일)"
    calendar = {**PAGE, "title": "「2026년 월력요항」 발표", "text": quote}
    answer = "The next public holiday after November 20, 2026 is Christmas Day, December 25, 2026."
    response = {"answer": answer, "citations": [{"index": 0, "quote": quote}, {"index": 0, "quote": calendar["title"]}]}
    verified = public_search.TavilySearch._sourced_answer(response, [calendar], "2026-11-20", "2026년 11월 20일 기준 다음 공휴일")
    assert verified["speech"] == answer and len(verified["sources"]) == 1
