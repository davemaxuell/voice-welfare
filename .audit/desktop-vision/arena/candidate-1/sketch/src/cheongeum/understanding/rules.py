"""
[바뀌는 부분만] understanding/rules.py

규칙은 위에서부터 첫 번째로 맞는 것이 이긴다. 컴퓨터 규칙 묶음은 CLEAR_LOGIN(rules.py:174-175) 바로 다음,
READ_DOWNLOAD(176) 앞에 하나로 넣는다. 그래야:
 - "다운로드 폴더에 뭐 있어?"가 READ_DOWNLOAD(청음이 이번 대화에서 받은 파일)로 가지 않고,
 - "바탕화면에 뭐 있어?"가 DESCRIBE_SCREEN('화면에\\s*뭐', rules.py:197)으로 가지 않는다.
묶음은 앱·폴더 이름(understanding/apps.py)이나 '파일·폴더·문서'라는 말이 있을 때만 잡는다. 그래서
"받은 파일 읽어줘"(READ_DOWNLOAD 예문), "크롬 켜줘"(OPEN_BROWSER), "신청서 열어줘"(START_APPLICATION)는 그대로다.
"2번 열어줘" 같은 번호 고르기는 여기서 잡지 않는다: 지금처럼 UNKNOWN이 되고 _unknown이 마지막 목록 주인에게 보낸다.

DESCRIBE_SCREEN 규칙(rules.py:197)에 두 갈래를 더한다: "이 창 설명해줘"·"지금 창 읽어줘", "이 사진 뭐야?"·"그래프 설명해줘".
"""
from __future__ import annotations

from cheongeum.core.jsutil import rx
from cheongeum.understanding.apps import find_desktop_name

_LISTISH = rx(r"(뭐|무엇|무슨|어떤)\s*(파일|게|거|것)?\s*(이|가|들)?\s*(있|들어)|목록")
_OPENISH = rx(r"(열어|켜|실행|띄워|보여)")
# 주의: '폴더'에 '더'가 들어 있다. LIST_LINKS의 (더|계속|…)를 그대로 쓰면 "다운로드 폴더에 뭐 있어?"가 more=True가 된다.
_MORE = rx(r"(?<![가-힣])더|계속|나머지")
# "받은 파일 목록"은 READ_DOWNLOAD 예문: '받은' 뒤의 '파일 목록'은 잡지 않는다
_FILE_LIST = rx(r"(?<!받은\s?)(파일|폴더)\s*목록")
_OPEN_ITEM = rx(r"^(.+?)\s*(파일|폴더|문서)\s*(을|를|로|으로)?\s*(열어|들어가|실행)")
_READ_ITEM = rx(r"^(.+?)\s*(파일|문서)\s*(을|를)?\s*(읽어|들려)")
# 받은(→READ_DOWNLOAD)·번호(→_unknown의 번호 고르기)는 이름이 아니다. '이·이거·그거'는 이름으로 받는다:
# DesktopSkill이 탐색기 창에서 선택된 항목 하나로 풀고, 데스크톱이 꺼져 있으면 경로가 READ_DOWNLOAD로 돌린다(오늘 동작 유지).
_NOT_A_NAME = rx(r"^(받은|다운로드|\d{1,2}\s*번)$")
DEICTIC = rx(r"^(이|그|이거|그거|이것|그것)$")

# DESCRIBE_SCREEN에 더하는 갈래
WINDOW_OR_PICTURE = (
    r"(이|지금|현재)\s*창\s*(을|를)?\s*(설명|읽어|뭐)"
    r"|(사진|그림|이미지|도표|그래프|차트|포스터)\s*(이|가|은|는|을|를|으로|로)?\s*(뭐|설명|어떻게|무슨|읽어)"
)


def desktop_intent(text: str) -> dict | None:
    """
    컴퓨터 규칙 묶음(parse_sync 안에서 CLEAR_LOGIN 다음에 부른다). 순서:
    1. 폴더 이름 + 목록 말("다운로드 폴더에 뭐 있어?", "바탕화면에 뭐 있어?") 또는 '파일 목록' → LIST_ITEMS{target?, more}
    2. 앱·폴더 이름 + 여는 말("파일 탐색기 열어줘", "다운로드 폴더 열어줘") → OPEN_APP{target: 말 전체}
    3. "<이름> 파일/폴더/문서 열어줘·들어가줘" → OPEN_ITEM{name}
    4. "<이름> 파일/문서 읽어줘" → READ_ITEM{name}
    이름이 _NOT_A_NAME이면(받은·번호) 잡지 않고 아래 규칙에 넘긴다.
    """
    raise NotImplementedError


# parse_sync 안의 자리(rules.py:173-176 사이):
#
#     if has(r"로그\s*아웃|로그인\s*(기록|쿠키|정보).*(지워|삭제|없애)|로그인\s*풀어"):
#         return {"type": "CLEAR_LOGIN"}
#     desk = desktop_intent(text)           # ← 새 자리
#     if desk:
#         return desk
#     if has(r"(받은\s*파일|다운로드).*(읽어|들려|알려|목록|뭐\s*있)|파일\s*읽어"):
#         return {"type": "READ_DOWNLOAD", ...}
