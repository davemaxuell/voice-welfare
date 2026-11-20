import sys
from pathlib import Path

OUT = Path(sys.argv[1])

rows = [
    # test_playbook.py
    ("tests/unit/test_playbook.py", "43", "COUPLED", "should",
     'assert "브라우저" in first and ("직접" in first or "찾아" in first)',
     "Pins '브라우저' and the 'open it yourself' advice in blocked_speech (agents/web/playbook.py:26,52,56,71,133). A plainer word or a next step for users who cannot open sites alone breaks this.",
     "playbook 문구를 바꿀 때 이 단언도 함께 고친다(예: '브라우저' 대신 '인터넷 창', 혼자 못 여는 분께는 전화 안내 등)."),
    ("tests/unit/test_playbook.py", "59", "COUPLED", "consider",
     'assert "본문 읽어줘" in speech or "검색" in speech or "이동" in speech',
     "Loosely pins the policy-denied next step (playbook.py:57 example '본문 읽어줘') spoken via common.py:65; fixture at line 53 copies guard.py:157 '읽기 전용입니다. 클릭할 수 없습니다.', also spoken.",
     "playbook·guard 문구를 쉬운 말로 바꾸면 53행 fixture 메시지와 59행 후보 낱말도 맞춘다."),
    # test_policy.py
    ("tests/unit/test_policy.py", "138", "GAP", "should",
     '("my password is 1234", True), ("密码是1234", True), ("パスワードは1234です", True)',
     "Secret rules (privacy.py:31) and these cases cover only en/zh/ja keywords; the Korean PII model skips non-Hangul text (line 206). A 결혼이민자 giving a password in Vietnamese or Tagalog is not caught.",
     "대화 언어를 늘릴 때 베트남어(mật khẩu)·타갈로그어·크메르어 등 비밀번호·인증번호 키워드를 privacy.py와 이 시험 사례에 함께 더한다."),
    # test_progress.py
    ("tests/unit/test_progress.py", "21", "COUPLED", "should",
     '(done("read_more"), "본문을 이어서 보고 있어요."),',
     "Pins the exact spoken progress sentence from agents/web/skills/browse.py:60; '본문' is jargon for many 정보취약계층 users, so a PLAIN fix there must update this expectation.",
     "browse.py를 '내용을 이어서 보고 있어요.' 등으로 바꾸면 이 기대값도 같이 바꾼다."),
    ("tests/unit/test_progress.py", "22", "COUPLED", "should",
     '(done("find", "신청 방법"), "본문에서 \'신청 방법\'을 찾았어요."),',
     "Pins browse.py:62 '본문에서 …찾았어요/찾아봤어요' exactly; this progress line is spoken unasked (Progress.spoken defaults on).",
     "'화면 내용에서 …을 찾았어요' 등으로 바꿀 때 함께 수정."),
    ("tests/unit/test_progress.py", "20", "COUPLED", "consider",
     '(done("back"), "이전 페이지로 돌아갔어요."),',
     "Pins browse.py:58 exactly; '페이지' is borderline for older or low-literacy users, '화면' is the word used elsewhere in speech.",
     "'이전 화면으로 돌아갔어요.'로 바꾸면 함께 수정."),
    # test_registry.py
    ("tests/unit/test_registry.py", "144", "COUPLED", "should",
     '@pytest.mark.parametrize("lead", [("신청서",), ("웹 읽기",), ("시작", "복지 정보")])',
     "Pins help group name '웹 읽기' (core/intents.py:26-27, orchestrator/session.py:1038), which help speaks aloud as '웹 읽기: …'; '웹' may be unfamiliar to older users.",
     "묶음 이름을 '사이트 읽기'·'인터넷 화면 읽기' 등으로 바꾸면 이 매개변수도 바꾼다."),
    ("tests/unit/test_registry.py", "40", "COUPLED", "should",
     "def test_help_example_is_understood_on_any_screen(type_, text, state):",
     "Help speaks each intent's first example; lines 35-44 require rules.py to parse it on every screen. Swapping '본문 읽어줘' (intents.py:135) or '링크 목록 알려줘' (:142) needs rules.py to know the new phrase.",
     "쉬운 예문(예: '내용 읽어줘', '누를 수 있는 것 알려줘')으로 바꿀 때 rules.py가 그 말을 먼저 알아듣게 한다."),
    # test_result_speech.py
    ("tests/unit/test_result_speech.py", "49", "COUPLED", "consider",
     'assert "API 실시간" not in a.speech',
     "Live-source label 'API 실시간' (welfare/agent.py:35, welfare/data/__init__.py:234) is spoken via source_sentence (agent.py:209-213). Renaming it in plain words makes lines 49,56,64,81 pass vacuously.",
     "실시간 라벨을 '공식 자료 실시간 조회' 등으로 바꾸면 부정 단언 4곳도 새 라벨로 바꾼다."),
    # test_welfare.py
    ("tests/unit/test_welfare.py", "14", "GAP", "consider",
     'LIST = (FIXTURES / "welfare-list-disability-pension.xml").read_text(encoding="utf-8")',
     "API mapping, topic answers, RAG and the Recall/MRR gate (line 164) all run on one disability program (장애인연금). Programs for 고령층(기초연금), 저소득층, 농어민, 다문화가족 are never exercised.",
     "기초연금·기초생활보장·농어업인·다문화가족 제도 fixture를 하나씩 더해 같은 매핑·RAG 검사를 돌린다."),
    ("tests/unit/test_welfare.py", "323", "GAP", "should",
     '@pytest.mark.parametrize("v,ok", [("김하늘", True), ("남궁민수", True), ("John Smith", True), ...',
     "Only Korean 2-5 syllables and ASCII English are tested; profile.py:114-115 rejects 결혼이민자 names with Vietnamese diacritics, Chinese characters or Korean spellings over 5 syllables, and re-asks.",
     "'Nguyễn Thị Hoa', '응우옌티투하'(6자), '王芳' 같은 사례를 넣고 validate_name이 받을 범위를 정한다."),
    ("tests/unit/test_welfare.py", "318", "COUPLED", "consider",
     'assert [s.id for s in f.scenarios if is_active_pc(s)] == ["S1-normal-flow", "S2-field-validation", ...',
     "Pins exactly four active PC scenarios in demo_scenarios.json, whose persona is '시각장애인 이용자(가상)'; adding 고령층·결혼이민자 scenarios as active fails here (that file is marked do-not-modify).",
     "새 대상 시나리오는 별도 파일에 두거나, 이 단언을 '기존 4개를 포함한다'로 완화한다."),
    ("tests/unit/test_welfare.py", "338", "COUPLED", "consider",
     '"source": {"title": "출처", "url": "https://example.com/x", "lastCheckedAt": "2026-11-18", "version": "API 실시간"},',
     "Fixture copies the spoken live-source label (welfare/agent.py:35); tests at 345-384 speak '(출처: 출처, API 실시간)'. Won't fail on a rename but would keep exercising the old jargon label.",
     "라벨을 바꾸면 fixture의 version 값도 같은 말로 바꾼다."),
]

files = [
    ("tests/unit/test_picture.py", "full"),
    ("tests/unit/test_picture_speech.py", "full"),
    ("tests/unit/test_pii_model.py", "full"),
    ("tests/unit/test_playbook.py", "full"),
    ("tests/unit/test_policy.py", "full"),
    ("tests/unit/test_progress.py", "full"),
    ("tests/unit/test_registry.py", "full"),
    ("tests/unit/test_result_speech.py", "full"),
    ("tests/unit/test_shot_plan.py", "full"),
    ("tests/unit/test_vision_llm.py", "full"),
    ("tests/unit/test_welfare.py", "full"),
]

lines = []
for r in rows:
    path, line, cat, sev, excerpt, why, sug = r
    assert len(excerpt) <= 120, (path, line, len(excerpt))
    assert len(why) <= 200, (path, line, len(why))
    assert len(sug) <= 200, (path, line, len(sug))
    for f in r:
        assert "\t" not in f and "\n" not in f
    lines.append("\t".join(r))
for path, how in files:
    n = sum(1 for r in rows if r[0] == path)
    lines.append("\t".join([path, "-", "CHECKED", "-", str(n), how, "-"]))
OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(len(rows), "findings;", len(files), "files")
