"""
[바뀌는 부분만] core/intents.py

새 도움말 묶음 '컴퓨터'와 네 줄. 모두 LLM 계획이 만들 수 있고(llm=True), 동의 뒤에만 실행한다(before_consent=False).
매개변수 이름은 기존 이름(target·name·more)을 다시 써서 평탄화 칸(topic·more)과 시험의 대응(TOPIC_PARAMS)이 그대로 맞는다.
첫 예문은 IDLE·BROWSING·APPLICATION_OPEN 어디서나 규칙이 이 종류로 알아들어야 한다(test_registry).
의도 수: 37 → 41.
"""
from __future__ import annotations

from typing import Literal, Optional

HelpGroup = Literal["시작", "복지 정보", "웹 읽기", "신청서", "컴퓨터", "언제든"]
HELP_GROUPS = ("시작", "복지 정보", "웹 읽기", "신청서", "컴퓨터", "언제든")

_TEXT = ...  # 지금 정의 그대로
_REQ = ...

NEW_ROWS = (
    # ---- 컴퓨터: '웹 읽기' 묶음 다음, '신청서' 앞에 둔다
    _row(  # noqa: F821
        "OPEN_APP",
        "컴퓨터 앱이나 폴더 열기(파일 탐색기, 다운로드 폴더, 바탕화면 등): topic에 그 이름. 웹사이트는 OPEN_SITE",
        "컴퓨터",
        ["파일 탐색기 열어줘", "다운로드 폴더 열어줘"],
        target=(_TEXT, _REQ),
    ),
    _row(  # noqa: F821
        "LIST_ITEMS",
        "폴더에 있는 파일 목록 읽기: 폴더 이름을 말했으면 topic에, 이어서 더 알려 달라면 more=true",
        "컴퓨터",
        ["다운로드 폴더에 뭐 있어?", "바탕화면에 뭐 있어?", "파일 목록 더 알려줘"],
        target=(Optional[str], None),
        more=(bool, _REQ),
    ),
    _row(  # noqa: F821
        "OPEN_ITEM",
        "목록에 있는 파일이나 폴더 열기(폴더면 들어가기): topic에 그 이름",
        "컴퓨터",
        ["회의자료 폴더로 들어가줘", "신청서 파일 열어줘"],
        name=(_TEXT, _REQ),
    ),
    _row(  # noqa: F821
        "READ_ITEM",
        "파일 내용 읽어 주기(PDF·HWPX·글 파일): topic에 파일 이름",
        "컴퓨터",
        ["안내문 파일 읽어줘", "공고 문서 읽어줘"],
        name=(_TEXT, _REQ),
    ),
)

# DESCRIBE_SCREEN 줄은 예문만 하나 더(첫 예문은 그대로): "이 창 설명해줘"
# _row("DESCRIBE_SCREEN", "화면 전체 설명(웹 페이지나 지금 앞에 있는 창)", "언제든", ["화면 설명해줘", "지금 화면에 뭐가 있어?", "이 창 설명해줘"])
