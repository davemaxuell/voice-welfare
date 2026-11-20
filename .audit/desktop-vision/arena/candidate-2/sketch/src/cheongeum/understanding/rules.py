"""
[바뀌는 것만] understanding/rules.py — parse_sync(:152)의 if 사슬에 규칙 넷. 첫 번째로 맞는 규칙이 이기므로 자리가 중요하다.
입력은 지금처럼 비식별화된 사용자 말뿐이다. 화면 글·파일 이름·사진 설명은 넣지 않는다.

자리 A — WHAT_CAN_I_SAY(:189-190) 바로 뒤, `elsewhere` 계산(:192) 앞:

    # "바탕화면에 뭐 있어?"가 DESCRIBE_SCREEN(:197의 '화면에\\s*뭐')으로 가던 것을 여기서 먼저 받는다.
    # "다운로드 폴더에 뭐 있어?"는 그 위 :176의 READ_DOWNLOAD가 지금처럼 먼저 받는다(바꾸지 않는다).
    if mentions_place(text) and has(r"(열어|들어가|가\\s*줘|보여|뭐가?\\s*있|목록)"):
        return {"type": "OPEN_FOLDER", "place": text}

    # 사진·그림을 말하면 사진으로 본다. DESCRIBE_SCREEN(:197)보다 먼저: "화면 사진으로 설명해줘"가 글 설명으로 가지 않게.
    # 좁게 잡는다: "신청하려면 사진 뭐 필요해?"(PREPARE_APPLY, :217)처럼 사진이라는 낱말만 든 질문을 삼키면 안 된다.
    #   (1) 사진·캡처"으로" 보라는 말:  (사진|캡처|스크린\\s*샷)\\s*(으로|로)\\s*(설명|봐|보고|알려|읽어)
    #   (2) 가리키는 말 + 그림:         (이|저|그|여기|화면의?|지금)\\s*(사진|그림|이미지|도표|그래프|차트)
    #   (3) 그림을 설명하라는 말:       (그림|이미지|도표|그래프|차트)\\s*(을|를|좀)?\\s*(설명|묘사)
    if not elsewhere_ and (has(P1) or has(P2) or has(P3)):
        return {"type": "LOOK"}
    # (elsewhere_는 :192의 elsewhere를 이 위로 올려 계산한 것. "네이버 가서 사진 뭐 있는지 알려줘"는 목표 수행으로 간다)
    # OPEN_FOLDER 규칙이 위에 있어 "사진 폴더 열어줘"는 폴더로 간다.

자리 B — OPEN_BROWSER 규칙(:230) 바로 앞:

    if mentions_app(text) and has(r"(열어|켜|띄워|실행|시작)") and not mentions_known_site(text):
        return {"type": "OPEN_APP", "target": text}

자리 C — FOLLOW_LINK 규칙(:273) 바로 앞. 폴더·앱 창에 있을 때만(state == "DESKTOP"):

    # "진단서 열어줘", "병원서류 들어가줘", "이 노래 틀어줘": 폴더에서는 '눌러'보다 '열어'라고 말한다.
    if state == "DESKTOP" and has(r"(열어|들어가|틀어|실행해)"):
        name = (따옴표를 떼고, 끝의 "(파일|폴더|문서)?(을|를|좀)? (열어|들어가|틀어|실행해)..."를 뗀 것)
        if name:
            return {"type": "FOLLOW_LINK", "name": name}

    PREV 규칙(:269)의 낱말에 `상위\\s*폴더|위\\s*폴더|위로\\s*가`를 더한다.

지켜야 할 것(tests/unit/test_registry.py가 본다)
 - 기존 37줄의 예문이 모두 지금과 같은 종류로 읽힌다. 특히 "받은 파일 읽어줘"·"다운로드 읽어줘"(READ_DOWNLOAD),
   "화면 설명해줘"·"지금 화면에 뭐가 있어?"(DESCRIBE_SCREEN), "크롬 켜줘"(OPEN_BROWSER), "신청 페이지를 열어줘"(START_APPLICATION).
 - 새 세 줄의 첫 예문이 IDLE·BROWSING·APPLICATION_OPEN에서 읽힌다.

탐색기 다음 앱부터(메모장 등): IntentContext(:15)에 `app: str | None = None`(지금 앞에 있는 앱 id)을 더하고,
자리 C 앞에서 `match_act(ctx.app, text)`(앱 표의 ActSpec.say)로 APP_ACT를 만든다. 첫 조각에는 넣지 않는다.
"""
