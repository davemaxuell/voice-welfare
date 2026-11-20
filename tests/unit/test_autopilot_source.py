"""목표 수행의 출처: 근거 문장이 실제로 있던 화면(독립 검토 2026-11-19, 먼저 본 화면을 출처로 잡던 문제)."""
import copy
import json
from pathlib import Path
from types import SimpleNamespace as NS

from cheongeum.agents.web.autopilot import Autopilot

HOME = json.loads((Path(__file__).parents[1] / "fixtures" / "bokjiro-public-pages.json").read_text(encoding="utf-8"))["home"]
NPS = "https://www.nps.or.kr/guide/basic.do"


class _Web:
    id = "web"

    def __init__(self) -> None:
        self.view = HOME
        self.official = copy.deepcopy(HOME)
        self.official.update(url=NPS, title="기초연금 신청 안내 | 국민연금공단", dialogs=[])
        self.official["outline"] = {
            **HOME["outline"],
            "items": [],
            "mainText": "기초연금신청\n기초연금은 만 65세 이상이면 주소지 주민센터나 국민연금공단 지사에서 신청할 수 있습니다.",
        }

    async def observe(self, ctx):
        return self.view

    async def open_site(self, url, ctx):
        self.view = self.official
        return NS(status="ok", view=self.official, actions=[], message=None)


class _Llm:
    def __init__(self) -> None:
        self.n = 0

    async def generate(self, **kw):
        self.n += 1
        if self.n == 1:
            return {"action": "open_url", "target": NPS, "answer": "", "evidence": []}
        return {
            "action": "answer",
            "target": "",
            "answer": "기초연금은 주소지 주민센터나 국민연금공단 지사에서 신청할 수 있어요.",
            "evidence": ["기초연금신청", "주소지 주민센터나 국민연금공단 지사에서 신청할 수 있습니다"],
        }


async def test_source_is_the_page_that_holds_the_answer():
    ctx = NS(signal=NS(aborted=False), is_stopped=lambda: False, trace=lambda *a: None)
    r = await Autopilot(_Web(), _Llm(), search_url=lambda q: f"https://s/?q={q}").run("기초연금 신청은 어디서 하는지 찾아줘", ctx)
    assert r.status == "answered"
    assert [x["url"] for x in r.sources] == [NPS]


class _TwoPageLlm(_Llm):
    async def generate(self, **kw):
        self.n += 1
        if self.n == 1:
            return {"action": "open_url", "target": NPS, "answer": "", "evidence": []}
        return {
            "action": "answer",
            "target": "",
            "answer": "맞춤형급여안내에 가입할 수 있고, 상담은 평일 09:00~18:00이에요.",
            "evidence": ["맞춤형급여안내(복지멤버십) 서비스에 가입하여 맞춤형 서비스 안내를 경험해 보세요.", "평일 09:00~18:00"],
        }


async def test_answer_from_two_pages_cites_both():
    web = _Web()
    web.official["outline"]["mainText"] += " 상담 시간은 평일 09:00~18:00입니다."
    ctx = NS(signal=NS(aborted=False), is_stopped=lambda: False, trace=lambda *a: None)
    r = await Autopilot(web, _TwoPageLlm(), search_url=lambda q: f"https://s/?q={q}").run("복지멤버십과 상담 시간 알려줘", ctx)
    assert r.status == "answered"
    assert {x["url"] for x in r.sources} == {HOME["url"], NPS}
