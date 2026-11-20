"""
core/intents.py: 바뀌는 곳만. 의도 표(intents.py:76 INTENTS)에 다섯 줄과, 평탄화 매개변수 대응을 표에서 파생하게 하는 칸 하나.

규칙(CLAUDE.md, core/intents.py:1-5):
 - 모델(LLM)은 APPROVE·STOP·PROGRESS 말고 모두 만들 수 있다. 새 의도도 llm=True. 모델이 고르는 것은 '어느 이름 붙은 일인가'와 '어느 이름인가'뿐이고,
   그 이름은 코드가 앱 표(core/apps.py)와 파일 시스템에서 다시 찾는다. 못 찾으면 실행하지 않고 되묻는다.
 - 새 의도는 before_consent=False(기본): 동의 뒤에만 한다. 파일 이름이 귀에 들리는 일이라 동의 전에는 하지 않는다.
 - 첫 예문은 IDLE·BROWSING·APPLICATION_OPEN 어디서든 같은 의도로 읽혀야 한다(test_registry.py:41). 그래서 첫 예문에는 폴더·탐색기처럼 낱말이 분명한 말만 둔다.
 - 규칙 파서의 순서는 rules.py에서 정한다(앱 규칙은 웹 규칙 앞).
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

# 1) 도움말 묶음에 '내 컴퓨터' 하나(intents.py:26 HelpGroup, :27 HELP_GROUPS). 화면에 맞는 묶음을 앞세우는 곳(session.py:909 _what_can_i_say)은
#    상태가 APP_OPEN이면 lead = ("내 컴퓨터",).
HelpGroup = Literal["시작", "복지 정보", "웹 읽기", "신청서", "내 컴퓨터", "언제든"]

# 2) IntentSpec에 칸 하나: 평탄화 스키마의 topic 칸이 이 의도에서는 어느 매개변수인가.
#    llm_planner.flat_to_intent(llm_planner.py:54)가 의도마다 손으로 적은 if(:72-89)를 이 칸 하나로 바꾼다. 같은 변경에서 옛 분기를 지운다.
#    (IntentSpec 끝에 topic_param: str | None = None, _row에 같은 이름의 키워드 인자)

_TEXT = Annotated[str, Field(min_length=1)]
_REQ = ...

NEW_ROWS = (
    # ---- 내 컴퓨터(1차 4개 + 2차 1개). 줄 위치는 '웹 읽기' 묶음 뒤, '신청서' 묶음 앞.
    # _row("OPEN_APP", "컴퓨터 앱 열기: topic에 앱 이름(파일 탐색기 등). 브라우저·사이트는 OPEN_BROWSER·OPEN_SITE",
    #      "내 컴퓨터", ["파일 탐색기 열어줘", "탐색기 켜줘"], target=(_TEXT, _REQ), topic_param="target"),
    #
    # _row("APP_OPEN_ITEM", "열려 있는 앱 안에서 폴더나 알려진 폴더(다운로드·문서·바탕 화면)로 들어가기: topic에 그 이름",
    #      "내 컴퓨터", ["다운로드 폴더 열어줘", ("이력서 폴더 열어줘", "APP_OPEN"), ("바탕 화면에 뭐 있어?", "IDLE")],
    #      name=(_TEXT, _REQ), topic_param="name"),
    #
    # _row("APP_LIST", "앱 안의 목록(폴더 내용) 읽기: 이어서 더 알려 달라면 more=true",
    #      "내 컴퓨터", ["폴더 내용 읽어줘", ("목록 더 알려줘", "APP_OPEN")], more=(bool, _REQ)),
    #
    # _row("APP_UP", "한 단계 위 폴더로", "내 컴퓨터", ["상위 폴더로 가줘", ("위로 가줘", "APP_OPEN")]),
    #
    # _row("APP_READ_ITEM", "[2차] 폴더 안 파일의 글 읽어 주기: topic에 파일 이름",
    #      "내 컴퓨터", [("이력서 읽어줘", "APP_OPEN"), ("이력서 파일 읽어줘", "APP_OPEN")], name=(_TEXT, _REQ), topic_param="name"),
)
# 그 밖에 의도 표를 바꾸지 않는 것:
#  - DESCRIBE_SCREEN(intents.py:195)에 매개변수를 더하지 않는다. '사진으로' 청했는지는 기존 '자세히' 처럼 기술이 발화 글에서 읽는다
#    (browse.py:492 detailed = rx(...).search(text)). 사진 낱말 목록은 core/vision.py의 PICTURE_ASK 한 곳.
#  - PREV(intents.py:159)는 앱 상태에서는 앱의 '이전 폴더'로 간다(ROUTES에서 상태로 가름). 의도를 따로 만들지 않는다.
#
# test_registry.py가 바뀌는 곳(구현 때 같이): 행 수 37(:28)→41(1차)→42(2차), ALLOWED_WITHOUT_CONSENT(:57)는 그대로,
# TOPIC_PARAMS(:98)는 표에서 파생(손 목록을 지운다), 도움말 쪽 수(help_pages)는 표에서 나오므로 그대로 통과해야 한다.
