r"""
understanding/rules.py: 바뀌는 곳만. RuleBasedIntentProvider.parse_sync(rules.py:152)는 '처음 맞는 규칙이 이긴다'(첫 일치)라서 규칙 위치가 곧 의미다.

앱 규칙 블록은 한 덩어리로, CLEAR_LOGIN(rules.py:174) 바로 뒤 READ_DOWNLOAD(rules.py:176) 바로 앞에 둔다. 이유(실제 파서로 확인된 현재 동작, grounding):
  - "다운로드 폴더에 뭐 있어?" 는 지금 READ_DOWNLOAD(list)로 읽힌다: rules.py:176 의 (받은 파일|다운로드).*(…뭐 있) 때문이다.
    READ_DOWNLOAD는 '브라우저가 받은 파일'(DownloadStore의 세션 목록)이고 윈도 다운로드 폴더가 아니다. '폴더'가 들어가면 앱 쪽이다.
  - "바탕화면에 뭐 있어?" 는 지금 DESCRIBE_SCREEN이다: rules.py:197 의 화면에\s*뭐 가 '바탕화면에 뭐' 안에서 맞는다.
  - "메모장 열어줘", "계산기 켜줘" 는 지금 UNKNOWN이고, LLM이 있으면 OPEN_SITE → 네이버에서 '메모장 홈페이지' 검색이 된다(browse.py:114).
  - OPEN_BROWSER(rules.py:230)의 '크롬 켜줘'와 OPEN_SITE(rules.py:278)는 건드리지 않는다: 크롬·브라우저·사이트는 앱 표에 없다.
이 블록 때문에 바뀌는 기존 말이 없어야 한다. 이는 tests/unit/test_registry.py의 기존 예문 전부(모든 상태)와, 아래 '삼키지 않기' 표가 지킨다.
"""
from __future__ import annotations

# 앱 블록의 모양(구현 때 정규식을 다듬는다. 순서가 계약이다):
#
#   app = resolve_app(text)                       # core/apps.py: 표의 이름들에서 찾는다(공백 무시, 한 글자 차이 허용)
#   place = mentions_place(text, bare=(state == "APP_OPEN"))
#
#   # 1) 앱을 열어 달라는 말. 사이트 낱말('사이트', '홈페이지')이 있으면 웹 말이다.
#   if app and has(r"(열어|켜|실행|띄워|시작)") and not has(r"(사이트|홈페이지|누리집)"):
#       return {"type": "OPEN_APP", "target": app.label}
#
#   # 2) 폴더로 가기: '다운로드 폴더 열어줘', '바탕 화면에 뭐 있어?', '문서 폴더로 가줘'
#   if place and has(r"(열어|가\s*줘|으로|로\s*가|에\s*뭐|뭐\s*있|보여|읽어|알려)"):
#       return {"type": "APP_OPEN_ITEM", "name": place.label}
#
#   # 2.5) '폴더'가 분명한 말은 어느 상태에서나: "폴더 내용 읽어줘"(APP_LIST), "상위 폴더로 가줘"(APP_UP).
#   #      도움말은 줄의 첫 예문을 세 화면(IDLE·BROWSING·APPLICATION_OPEN)에서 같게 읽는다(test_registry.py:41). 첫 예문이 상태를 안 타야 한다.
#   if has(r"폴더\s*(안\s*)?(내용|목록)"):  return {"type": "APP_LIST", "more": False}
#   if has(r"(상위\s*폴더|위\s*폴더)"):     return {"type": "APP_UP"}
#
#   # 3) 앱 상태에서만(state == "APP_OPEN"): 눌러·열어·가줘·읽어줘·목록은 앱 말이다.
#   if state == "APP_OPEN":
#       if has(r"(상위|위\s*폴더|한\s*단계\s*위|위로)"):                          return {"type": "APP_UP"}
#       if has(r"(목록|뭐\s*있|내용).*(읽어|알려|더)|^(더|계속)\s*(읽어|알려)"):      return {"type": "APP_LIST", "more": bool(has(r"(더|계속|나머지|다음)"))}
#       name = (눌러|클릭|열어|들어가|선택|가\s*줘 앞의 이름, FOLLOW_LINK의 이름 추출 rules.py:274-277과 같은 방식)
#       if name:                                                                   return {"type": "APP_OPEN_ITEM", "name": name}
#
#   # 4) 사진 낱말: DESCRIBE_SCREEN 규칙(rules.py:197)의 정규식에 PICTURE_ASK(core/vision.py)를 한 가닥으로 잇는다(손 목록을 새로 만들지 않는다).
#   #    "사진으로 화면 설명해줘"는 이미 맞는다. "이 그림 뭐야?" "차트 설명해줘"가 새로 맞게 된다.
#   #    "창" 말: (이\s*창|지금\s*창|앱\s*창).*(설명|읽어|뭐) 도 DESCRIBE_SCREEN(상태가 웹이냐 앱이냐는 ROUTES가 가른다).

# 삼키지 않기 표(tests/unit/test_app_rules.py): (말, 상태) → 의도. 앞의 것은 바뀌면 안 되고, 뒤의 것이 새로 읽혀야 한다.
UNCHANGED = [
    ("받은 파일 읽어줘", "IDLE", "READ_DOWNLOAD"),  # 폴더 낱말 없음 → 브라우저 다운로드
    ("받은 파일 목록", "BROWSING", "READ_DOWNLOAD"),
    ("다운로드 읽어줘", "IDLE", "READ_DOWNLOAD"),  # intents.py:167 의 두 번째 예문. '폴더'가 없으면 폴더가 아니다(Place.bare_ok=False)
    ("크롬 켜줘", "IDLE", "OPEN_BROWSER"),
    ("복지로 열어줘", "IDLE", "OPEN_SITE"),
    ("화면 설명해줘", "BROWSING", "DESCRIBE_SCREEN"),
    ("지금 화면에 뭐가 있어?", "APPLICATION_OPEN", "DESCRIBE_SCREEN"),
    ("공지사항 눌러줘", "BROWSING", "FOLLOW_LINK"),  # 웹 상태의 '눌러'는 그대로 웹
    ("뒤로 가줘", "BROWSING", "PREV"),
]
NEW = [
    ("파일 탐색기 열어줘", "IDLE", "OPEN_APP"),
    ("탐색기 켜줘", "BROWSING", "OPEN_APP"),
    ("메모장 열어줘", "IDLE", "OPEN_APP"),  # 표에 tier none으로 있어 '아직 못 해요'로 답한다(네이버 검색 아님)
    ("다운로드 폴더 열어줘", "IDLE", "APP_OPEN_ITEM"),
    ("다운로드 폴더에 뭐 있어?", "IDLE", "APP_OPEN_ITEM"),  # 지금은 READ_DOWNLOAD
    ("바탕화면에 뭐 있어?", "IDLE", "APP_OPEN_ITEM"),  # 지금은 DESCRIBE_SCREEN
    ("이력서 눌러줘", "APP_OPEN", "APP_OPEN_ITEM"),  # 앱 상태의 '눌러'는 앱
    ("위로 가줘", "APP_OPEN", "APP_UP"),
    ("뒤로 가줘", "APP_OPEN", "PREV"),  # 같은 말, 라우팅이 상태로 앱 이전 폴더로
    ("이 그림 뭐야?", "BROWSING", "DESCRIBE_SCREEN"),
    ("사진으로 화면 설명해줘", "BROWSING", "DESCRIBE_SCREEN"),
]
