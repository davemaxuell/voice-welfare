# 변경 부분만 보인다. 원본: src/cheongeum/core/intents.py (INTENTS, 37행 → 41행)
# test_registry.py의 `== 37`을 41로 바꾸고, 각 행은 예시 2개 이상을 규칙이 파싱해야 한다.
# 첫 예시는 IDLE, BROWSING, APPLICATION_OPEN 세 상태에서 모두 파싱되어야 한다.

# 충돌: "다운로드 폴더에 뭐 있어?"는 지금 READ_DOWNLOAD(rules.py:177, 세션 안 목록)이다.
# 이 설계는 "폴더" 말이 붙은 이름 있는 장소를 FOLDER_LIST로 보내고, "받은 파일"은 READ_DOWNLOAD에 둔다.
# 그러면 기존 결과 하나가 바뀐다. 주인이 정할 질문이다(DESIGN.md Open questions).
_row("FOLDER_LIST", "폴더 목록 읽기", "언제든", ["바탕화면 폴더에 뭐 있어?", "문서 폴더에 뭐 있어?"], before_consent=False, place=str)
_row("FOLDER_OPEN", "폴더나 파일 열기", "언제든", ["다운로드 폴더 열어줘", "보고서 열어줘"], before_consent=False, name=str)
_row("FOLDER_UP", "상위 폴더로 가기", "탐색기에서", ["상위 폴더로 가줘"], before_consent=False)
_row("APP_OPEN", "앱 열기", "언제든", ["메모장 열어줘", "파일 탐색기 열어줘"], before_consent=False, app=str)

# DESCRIBE_SCREEN에 source 매개변수를 더한다(행 추가 아님).
_row(
    "DESCRIBE_SCREEN",
    "화면 설명",
    "언제든",
    ["화면 설명해줘", "지금 화면에 뭐가 있어?", "화면 그림으로 설명해줘"],
    source=str,  # "text" | "picture" | 없음(auto)
)

# 새 의도는 before_consent=False(동의 뒤에만). 앱 실행과 항목 열기는 행 안에서 승인 문으로 한 번 더 묻는다.
# FOLDER_*/APP_OPEN은 LLM 열거에 들어간다. APPROVE, STOP, PROGRESS는 들어가지 않는다(기존 규칙).
