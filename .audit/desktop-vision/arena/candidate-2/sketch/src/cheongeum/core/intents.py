"""
[바뀌는 것만] core/intents.py — 의도 표에 세 줄(37 → 40). tests/unit/test_registry.py:28의 숫자도 40으로.

새로 생기는 의도는 "어디로 가는가"(앱·폴더)와 "사진으로 보라"뿐이다.
폴더·앱 창 안에서 하는 말은 새 의도가 아니다. 기존 의도가 그대로 쓰이고 오케스트레이터가 지금 앞에 있는 화면으로 보낸다:
  "화면 설명해줘"(DESCRIBE_SCREEN) "목록 알려줘"(LIST_LINKS) "진단서 열어줘"(FOLLOW_LINK) "뒤로 가줘"(PREV) "읽어줘"(READ_MAIN)
그래서 웹에서 배운 말을 폴더에서도 그대로 쓴다.

세 줄 모두 before_consent=False(기본): 화면을 읽고 컴퓨터를 다루므로 동의 문을 지난다. llm=True: LLM 계획이 만들 수 있다
(만들어도 앱 표·장소 표에 없는 이름이면 실행되지 않고 되묻는다. 승인·중단은 여전히 못 만든다).
"""
from cheongeum.core.intents import _REQ, _TEXT, _row  # 기존

NEW_ROWS = (
    # ---- 시작 묶음(OPEN_SITE·OPEN_BROWSER 옆)
    _row(
        "OPEN_FOLDER",
        '컴퓨터의 폴더 열기: topic에 폴더 이름, 예 "문서 폴더 열어줘"→문서 폴더',
        "시작",
        ["문서 폴더 열어줘", "바탕화면에 뭐 있어?", "다운로드 폴더 열어줘"],
        place=(_TEXT, _REQ),
    ),
    _row(
        "OPEN_APP",
        '컴퓨터 프로그램 켜기(웹사이트 아님): topic에 프로그램 이름, 예 "메모장 켜줘"→메모장',
        "시작",
        ["파일 탐색기 열어줘", "탐색기 켜줘"],
        target=(_TEXT, _REQ),
    ),
    # ---- 언제든 묶음(DESCRIBE_SCREEN 다음 줄)
    _row(
        "LOOK",
        "지금 화면을 사진으로 찍어 그림·사진·도표·배치를 설명",
        "언제든",
        ["화면 사진으로 설명해줘", "이 그림 뭐야?", "사진으로 봐줘"],
    ),
)

# understanding/llm_planner.flat_to_intent(:54)에 두 갈래:
#   OPEN_FOLDER → place = topic(없으면 발화), OPEN_APP → target = topic(없으면 발화). LOOK은 매개변수 없음.
# tests/unit/test_registry.py:98 TOPIC_PARAMS에 "place".
# 평탄화 스키마(INTENT_JSON_SCHEMA)는 바뀌지 않는다(새 칸 없음).
