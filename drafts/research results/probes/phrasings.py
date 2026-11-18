"""
Natural phrasings of the six intents that the LLM planner cannot produce, run through the rule parser alone.
No LLM, no browser, no network. Run from the repository root:

    uv run python "drafts/research results/probes/phrasings.py"

The phrasings are examples written for this check, not utterances from real users.
A MISS here falls to the LLM planner, which has no slot for these intents (see section 2 of the fit document).
"""
from cheongeum.agents.web import field_vocabulary
from cheongeum.agents.web.profile import create_mock_welfare_profile
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider

CASES = {
    "READ_MAIN": ["이 페이지 내용 좀 들려줄래", "기사 마저 읽어", "본문 읽어줘", "그 다음 내용은?"],
    "LIST_LINKS": ["여기 누를 수 있는 거 뭐 있어", "어떤 메뉴가 있어", "링크 목록 알려줘"],
    "SEARCH": ["기초연금으로 검색해 볼래", "검색창에 기초연금 쳐줘", "기초연금 검색해줘"],
    "FOLLOW_LINK": ["공지사항으로 가자", "공지사항 들어가 볼래", "공지사항 눌러줘"],
    "REPHRASE": ["무슨 소리야", "좀 더 쉽게", "쉽게 말해줘"],
    "SERVICE_DETAIL": ["첫 번째 거 자세히 알려줘", "두 번째 제도 설명해줘", "2번 자세히 알려줘"],
}

rules = RuleBasedIntentProvider(field_vocabulary(create_mock_welfare_profile("http://localhost:5174")))
misses = 0
total = 0
for want, utterances in CASES.items():
    for u in utterances:
        got = rules.parse_sync(u, IntentContext(state="BROWSING"))["type"]
        total += 1
        misses += got != want
        print(f"{want:15} {'ok  ' if got == want else 'MISS'} {u!r:28} -> {got}")
print(f"\n{misses} of {total} phrasings missed by the rules")
