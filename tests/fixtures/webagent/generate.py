"""웹 에이전트 단위 테스트의 기대값을 pyref(77aad3e)에서 만든다.

cd C:/Users/user/Desktop/voice-welfare-ts-pyref
uv run --frozen python -I C:/Users/user/Desktop/voice-welfare-ts-webagent/tests/fixtures/webagent/generate.py
"""
import json
from dataclasses import asdict
from pathlib import Path

from cheongeum.agents.web.link_choices import LinkChoice, LinkChoices, link_reference

HERE = Path(__file__).parent

UTTERANCES = [
    "", "네", "응", "아니요", "맞아요?", "2번 링크 열어줘", "두 번째 링크 열어줘", "첫 번째 검색 결과 눌러줘", "첫 링크", "맨 위 링크 열어",
    "３번 링크 열어줘", "12번 링크", "123번 링크", "2번호 링크", "2번", "2번 열어줘", "2번?", "2번 링크 뭐야?", "2번 링크 설명해줘",
    "2번 말고 3번 링크 열어줘", "2번 링크 말고 3번", "2번 링크는 누르지 마", "2번 링크 왜 그래?", "2번이랑 3번 링크", "아무 링크나 열어줘",
    "그거 열어줘", "그 링크 눌러줘", "이거 좀 열어 주세요", "2번 링크 맞아요", "2번 링크가 맞아요 그거 열어줘", "네, 2번 맞아요",
    "아니요 2번 맞지 않아요", "2번 맞나요?", "2번이 맞아요?", "2번 맞아요 그런데", "3번 맞아요", "링크 중 하나 열어줘", "검색 결과 중에 장애인연금 열어줘",
    "장애인연금 링크 열어줘", "2번 연금 링크", "2번 서류", "화면에 있는 2번 링크 열어줘", "결과 중에서 두 번째 거 열어", "다섯 번째 결과 클릭해줘",
    "네 번째 항목 선택해줘", "세 번째 거", "2번 링크를 열어 줄래요", "2번 링크로", "열어줘", "장애인연금 열어줘.", "  2번 링크 열어줘 ~  ",
    "1번 링크 이름 알려줘", "2번 링크 취소", "2번 안 눌러", "그거 뭐야?", "2번 링크 눌러도 돼?", "누가 운영해?", "응, 2번 링크",
]


def link_cases() -> list[dict]:
    options = [LinkChoice(f"항목{i}", f"r{i}", "link") for i in range(1, 4)]
    states = {
        "none": None,
        "stale": LinkChoices("http://x/", options, "search"),
        "proposed": LinkChoices("http://x/", options, "search", proposed=2, offer_id="o1"),
        "recent": LinkChoices("http://x/", options, "list", offer_id="o2"),
        "single": LinkChoices("http://x/", options[:1], "list", offer_id="o3"),
    }
    rows = []
    for text in UTTERANCES:
        for state, choices in states.items():
            found = link_reference(text, choices)
            rows.append({"text": text, "state": state, "result": asdict(found) if found else None})
    return rows


(HERE / "link_reference.json").write_text(json.dumps(link_cases(), ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
