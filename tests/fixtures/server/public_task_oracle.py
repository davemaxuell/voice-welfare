# Writes public-task.json. Run from the Python reference worktree: uv run --frozen python -I <this file> > public-task.json
import asyncio, json
from cheongeum.core.jsutil import AbortController
from cheongeum.orchestrator.public_task import DECISION_SCHEMA, RESEARCH_SCHEMA, AGENCY_CATALOG, PublicTask, decide, parse_decision, review_completion

def D(kind="find_information", **f):
    base = {"kind": kind, "source": "browser", "agency": "정부24", "subject": "주민등록등본", "goal": "주민등록등본 발급 서류",
            "requestedFacts": ["documents"], "exclusions": [], "continuation": False, "question": None, "choices": []}
    base.update(f)
    return base
cases = {
 "find": D(), "find_mode_quiet": D(searchMode="quiet"), "find_mode_null": D(searchMode=None), "find_no_source": D(source=None),
 "find_no_facts": D(requestedFacts=[]), "find_no_goal": D(goal=None), "unknown_agency": D(agency="없는기관"), "null_agency": D(agency=None),
 "approve_kind": D(kind="approve"), "extra_key": D(tool="submit"), "url_goal": D(goal="https://external.invalid"), "www_goal": D(goal="WWW.example 서류"),
 "secret_goal": D(goal="비밀번호 1234 알려줘"), "redacted_goal": D(goal="[비공개] 서류"), "blank_subject": D(subject="  "), "long_subject": D(subject="가" * 101),
 "long_goal_ok": D(goal="가" * 500), "emoji_goal": D(goal="😀" * 500), "three_choices": D(kind="clarify", question="어느 쪽?", choices=["a", "b", "c"]),
 "clarify": D(kind="clarify", question="어느 서류요?", choices=["등본", "초본"]), "clarify_no_question": D(kind="clarify"),
 "find_with_question": D(question="왜요?"), "find_with_choices": D(choices=["a"]), "open_agency": D(kind="open_agency", source=None, requestedFacts=[]),
 "open_no_agency": D(kind="open_agency", agency=None), "read_skill": D(kind="read_skill", skill="READ_MAIN"), "read_skill_missing": D(kind="read_skill"),
 "skill_on_find": D(skill="READ_MAIN"), "conversation": D(kind="conversation", reply="안녕하세요!"), "conversation_no_reply": D(kind="conversation"),
 "conversation_blank_reply": D(kind="conversation", reply=""), "delegate": D(kind="delegate_research"), "delegate_no_goal": D(kind="delegate_research", goal=None),
 "review": D(kind="review_before_output", searchMode="quiet", requirements=["서류"], difficulty="easy"), "review_no_req": D(kind="review_before_output", searchMode="quiet"),
 "review_action": D(kind="review_before_output", source=None, requestedFacts=[], requirements=["열고 입력"]), "review_action_mode": D(kind="review_before_output", source=None, searchMode="quiet", requirements=["x"]),
 "review_source_no_facts": D(kind="review_before_output", requestedFacts=[], searchMode="quiet", requirements=["x"]), "review_blank_req": D(kind="review_before_output", searchMode="quiet", requirements=[" "]),
 "nine_facts": D(requestedFacts=["documents"] * 9), "six_exclusions": D(exclusions=["login"] * 6), "bool_as_int": D(continuation=1), "existing": D(kind="existing", source=None, requestedFacts=[]),
 "not_dict": [1], "missing_required": {"kind": "existing"}, "long_choice": D(kind="clarify", question="q?", choices=["가" * 65]),
}
parsed = {}
for name, raw in cases.items():
    d = parse_decision(raw)
    parsed[name] = None if d is None else d.model_dump()
task = PublicTask(agency="정부24", subject="주민등록등본", goal="등본 서류", facts=("documents",), exclusions=("login",), search_mode="quiet")
adv = {}
for name, raw in {"continue_same": D(kind="existing", continuation=True, agency=None, subject=None, goal=None, requestedFacts=[], exclusions=["submission"], source=None),
                  "continue_other": D(continuation=True, agency="한국장학재단", requestedFacts=["dates", "dates"]),
                  "fresh": D(continuation=False, agency=None, subject=None, goal=None, requestedFacts=[], kind="existing", source=None),
                  "clarify": D(kind="clarify", question="어느 서류요?", choices=["등본", "초본"], continuation=True)}.items():
    t = task.advance(parse_decision(raw))
    adv[name] = {"context": t.context(), "revision": t.revision}

class Fake:
    def __init__(self, reply): self.reply, self.calls = reply, []
    async def generate(self, **kw):
        self.calls.append(kw); return self.reply
async def run():
    pending = PublicTask(question="어느 서류요?", choices=("주민등록등본", "주민등록초본"), goal="서류")
    sel = {}
    for said in ["주민등록초본", "2번", "두 번째", "첫번째", "네", "second", "第一"]:
        f = Fake(D())
        await decide(f, said, "ko", pending, voice=True, recent=[], signal=AbortController().signal)
        sel[said] = json.loads(f.calls[0]["user"])["selectedChoice"]
    one = PublicTask(question="이거요?", choices=("주민등록등본",))
    f = Fake(D())
    await decide(f, "네", "ko", one, voice=False, recent=[{"agency": "정부24", "request": "등본 서류 알려줘", "reply": "신분증이 필요해요."}, {"agency": None, "request": "다른 질문", "reply": "네."}], signal=AbortController().signal,
                 speech_candidates=("정부24",), corroborated=True, saved_notes=["큰 글씨"], research=True)
    user = json.loads(f.calls[0]["user"]); user.pop("koreaDate")
    payload = {"user": user, "schemaName": f.calls[0]["schemaName"], "systemTail": f.calls[0]["system"][-300:],
               "schemaKind": f.calls[0]["schema"]["properties"]["kind"]}
    f = Fake(D(kind="review_before_output", searchMode="quiet", requirements=["바꿔 말한 요구"]))
    rewritten = (await decide(f, "등본 서류를 찾아 정리해줘", "ko", PublicTask(), voice=True, recent=[], signal=AbortController().signal)).requirements
    reviews = {}
    for name, reply in {"all": {"coverage": "all", "checks": [{"request": "등본 서류", "quote": "신분증"}]},
                        "all_bad_quote": {"coverage": "all", "checks": [{"request": "등본 서류", "quote": "없는 말"}]},
                        "all_bad_request": {"coverage": "all", "checks": [{"request": "다른 요청", "quote": "신분증"}]},
                        "some": {"coverage": "some", "checks": []}, "unrelated": {"coverage": "unrelated", "checks": []},
                        "null_quote": {"coverage": "all", "checks": [{"request": "등본 서류", "quote": None}]}, "not_dict": "x",
                        "no_checks": {"coverage": "all", "checks": []}}.items():
        reviews[name] = await review_completion(Fake(reply), "등본 서류 알려줘", "준비물: 신분증", AbortController().signal)
    reviews["empty_evidence"] = await review_completion(Fake({}), "q", "", AbortController().signal)
    reviews["no_model"] = await review_completion(None, "q", "e", AbortController().signal)
    return sel, payload, rewritten, reviews
sel, payload, rewritten, reviews = asyncio.run(run())
print(json.dumps({"schema": DECISION_SCHEMA, "research": RESEARCH_SCHEMA, "catalog": AGENCY_CATALOG, "cases": cases, "parsed": parsed,
  "advance": adv, "selected": sel, "payload": payload, "rewritten": rewritten, "reviews": reviews}, ensure_ascii=False))
