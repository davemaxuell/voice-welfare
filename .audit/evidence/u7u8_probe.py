"""
Differential probe for U7/U8: runs the same scripted sessions against one source tree and prints one JSON line per turn
(intentType, state, semanticAction, speech, trace notes, waiting slots after the turn) plus every LLM call's inputs.
Run it on the pre-U7 tree and on the current tree, then diff the outputs.
Covers the edges the suite does not pin: labels on the exception path (GUIDED_FILL, VAULT_CONFIRM, PERSONAL_*),
the guided fold falling through to the guided start, leaving the guided page, vault yes/no/other, application records,
short replies, filler, vague requests, multi-question split, LLM plan, free chat (incl. clarify dropped after clarify),
the UI-forced path, and the intent_provider path.
Usage: python probe.py <src dir> <port>
"""
import asyncio
import hashlib
import json
import sys

SRC, PORT = sys.argv[1], int(sys.argv[2])
sys.path.insert(0, SRC)

import cheongeum  # noqa: E402
from cheongeum.agents.web.browser import stop_playwright  # noqa: E402
from cheongeum.practice_site import start_mock_site  # noqa: E402
from cheongeum.server.runtime import AgentRuntime, load_config  # noqa: E402

assert cheongeum.__file__.replace("\\", "/").startswith(SRC.replace("\\", "/")), cheongeum.__file__
PORTAL = f"127.0.0.1:{PORT}/external.html"


def h(x) -> str:
    return hashlib.sha256(json.dumps(x, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]


class FakeLlm:
    name = "fake"

    def __init__(self, fn):
        self.fn = fn
        self.calls: list[dict] = []

    async def generate(self, *, system, user, schemaName, schema, signal=None):  # noqa: N803
        self.calls.append({"schemaName": schemaName, "user": user, "system": h(system), "schema": h(schema)})
        return self.fn(schemaName, len([c for c in self.calls if c["schemaName"] == schemaName]))


def boom(*a, **k):
    raise RuntimeError("probe")


async def aboom(*a, **k):
    raise RuntimeError("probe")


def chat_answers(schema_name: str, n: int):
    if schema_name == "chat_route":
        return {"route": "clarify" if n == 1 else "general", "reply": f"답 {n}", "searchQuery": None, "language": None}
    if schema_name == "split_questions":
        return {"questions": ["기초연금은 몇 살부터야?", "기초연금은 얼마 받아?"]}
    if schema_name == "simple":
        return {"text": "쉬운 말"}
    return None


def split_raises(schema_name: str, n: int):
    if schema_name == "split_questions":
        raise RuntimeError("probe")
    return None


# 각 단계: 발화 문자열, ("patch", 대상 경로, 함수), ("llm", fn), ("confirm", bool)
SCENARIOS = {
    "guided_basic": [f"{PORTAL} 열어줘", "입력 칸 하나씩 채워줘", "홍길동"],
    "guided_vault": [f"{PORTAL} 열어줘", "내 이름은 김하늘이라고 저장해줘", "응", "입력 칸 하나씩 채워줘", "응"],
    "guided_stop_skip": [f"{PORTAL} 열어줘", "입력 칸 하나씩 채워줘", "그만", "입력 칸 하나씩 채워줘", "건너뛰기", "응"],
    "guided_fold": [f"{PORTAL} 열어줘", "입력 칸 하나씩 채워줘", "화면 설명해줘", "입력 칸 하나씩 채워줘", "입력 칸 하나씩 채워줘", "전부 채워줘", "다 채워줘"],
    "guided_left": [f"{PORTAL} 열어줘", "입력 칸 하나씩 채워줘", "모의 사이트 열어줘", "홍길동"],
    "guided_answer_exc": [f"{PORTAL} 열어줘", "입력 칸 하나씩 채워줘", ("patch", "web.assist_fill", aboom), "홍길동"],
    "guided_start_exc": [f"{PORTAL} 열어줘", ("patch", "web.observe", aboom), "입력 칸 하나씩 채워줘"],
    "vault": [
        "내 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10이라고 저장해줘",
        "응",
        "내 정보 알려줘",
        "내 정보 지워줘",
        "아니",
        "내 정보 지워줘",
        "화면 설명해줘",
        "내 정보 지워줘",
        "응",
        "내 정보 알려줘",
        "정보 저장해줘",
    ],
    "records": ["기초연금 신청했어", "보완 서류는 12월 3일까지", "신청 현황 알려줘", "기초연금 결과 나왔어", "신청 현황 알려줘", "장애인연금 결과 나왔어"],
    "vault_fold_exc": [("llm", split_raises), "내 이름은 김하늘이라고 저장해줘", "기초연금은 몇 살부터고 얼마 받아?"],
    "personal_exc": [("patch", "personal.add_application", boom), "기초연금 신청했어"],
    "understanding_llm": [
        ("llm", chat_answers),
        "알았어",
        "아니",
        "알았고 화면 설명해줘",
        "열어줘",
        "검색해줘",
        "안녕 반가워",
        "음 그거 뭐였더라",
        "기초연금은 몇 살부터고 얼마 받아?",
        "쉽게 말해줘",
    ],
    "form": [
        "장애인연금 신청할래",
        "알았어",
        "아니",
        "이름은 김하늘",
        "주소 다시 읽어줘",
        "주소 수정할게",
        "부산광역시 예시구 예시로 10",
        "이름 다시 읽어줘",
        "블라블라 무슨 말",
        ("confirm", True),
    ],
    "provider_only": ["블라블라 무슨 말", "그거 해줘"],
}


def target(s, path):
    obj, attr = path.split(".")
    return (s.deps.web if obj == "web" else s._personal), attr


def row(name, i, step, r, s):
    d = s.dialogue
    return {
        "scenario": name,
        "turn": i,
        "said": step,
        "intentType": r.get("intentType"),
        "state": r.get("state"),
        "semanticAction": r.get("semanticAction"),
        "speech": r.get("speech"),
        "field": r.get("field"),
        "trace": [[t.get("phase"), t.get("agent"), t.get("note")] for t in r.get("trace", [])],
        "pending": bool(r.get("pendingConfirmation")),
        "slots": {"vault_confirm": d.vault_confirm, "guided": d.guided, "awaiting": d.awaiting, "clarifying": bool(d.clarification)},
    }


async def run(name, steps):
    rt = AgentRuntime(
        load_config(
            {
                "MOCK_SITE_URL": f"http://localhost:{PORT}",
                "HEADLESS": "true",
                "BROWSER_SLOWMO_MS": "0",
                "LLM_PROVIDER": "mock",
                "REQUIRE_CONSENT": "false",
                "READ_ONLY_WEB": "true",
                "VISUAL_CURSOR": "false",
                "WEB_SEARCH_URL": f"http://127.0.0.1:{PORT}/external.html?q={{q}}",
                "CHEONGEUM_DATA_DIR": "",
            }
        )
    )
    s = await rt.create_session()
    llm = None
    try:
        for i, step in enumerate(steps):
            if isinstance(step, tuple) and step[0] == "patch":
                obj, attr = target(s, step[1])
                setattr(obj, attr, step[2])
                continue
            if isinstance(step, tuple) and step[0] == "llm":
                llm = FakeLlm(step[1])
                s.deps.llm = llm
                s.deps.welfare.llm = llm
                continue
            if isinstance(step, tuple) and step[0] == "confirm":
                r = await s.confirm(step[1])
            else:
                r = await s.handle_turn(step)
            print(json.dumps(row(name, i, step if isinstance(step, str) else repr(step), r, s), ensure_ascii=False, sort_keys=True))
        if llm:
            for c in llm.calls:
                print(json.dumps({"scenario": name, "llm": c}, ensure_ascii=False, sort_keys=True))
    finally:
        await s.close()
        await rt.close()


async def main():
    site = start_mock_site(PORT)
    try:
        for name, steps in SCENARIOS.items():
            await run(name, steps)
    finally:
        await stop_playwright()
        site.close()


asyncio.run(main())
