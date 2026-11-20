"""
[새 시험의 모양] 호출하는 쪽의 사용법이 곧 명세다. PLAN.md의 각 단위가 이 이름들로 증명한다.
몸통은 의사 코드(스케치). 실제 데스크톱·OpenAI 없이 FakeDesktop(tmp_path)과 FakeVision으로 돈다.
"""
from __future__ import annotations


async def test_list_downloads_reads_recent_first(new_session, tmp_path):
    """
    port = make_known_folders(tmp_path); (downloads/기초연금_안내.pdf 오늘, downloads/회의자료/ 어제) 만들고 with_desktop(s, port)
    r = await s.handle_turn("다운로드 폴더에 뭐 있어?")
    assert r["semanticAction"] == "list-items"
    assert "1번 기초연금 안내" in r["speech"] and "회의자료 폴더" in r["speech"]
    assert r["observation"]["url"].startswith("desktop://explorer/downloads")  # 실제 경로·사용자 이름 없음
    assert "기초연금" not in s.export_history()[-1]["text"]                    # LLM에 가는 기록에는 파일 이름 없음
    assert port.executed == []                                                 # 목록 읽기는 OS 동작이 아님
    """


async def test_numbered_read_after_desktop_list_reads_text(new_session, tmp_path):
    """
    목록 뒤 "1번 읽어줘" → read_file 한 번(가드 ALLOWED), 말에 PDF 첫 문장. 웹 링크 목록을 그 뒤에 읽으면 "1번"은 다시 웹 차례.
    """


async def test_internet_file_open_asks_then_opens_once(new_session, tmp_path):
    """
    port.internet_files = {"신청서.hwp"}; 목록 → "신청서 파일 열어줘"
      → state WAITING_FOR_USER_CONFIRMATION, semantic confirm-open, '진행해' 안내, port.executed에 select_item만
    "진행해" → open_file 한 번(policy APPROVED), 조작 기록 '전'·'후' 두 줄, 승인 대기 비움
    """


async def test_changed_file_after_ask_is_not_opened(new_session, tmp_path):
    """묻고 나서 파일을 고쳐 쓰면 "진행해" → open_file 없음, "여쭤본 뒤에 '신청서.hwp' 파일 내용이 바뀌었어요. 그래서 열지 않았어요."."""


async def test_executable_is_refused_with_spoken_reason(new_session, tmp_path):
    """"설치 파일 열어줘"(설치.exe) → policy DENIED_EXECUTABLE, 말에 '프로그램 파일이라 말로 실행하지 않아요'와 대안. 묻지 않는다."""


async def test_rel_cannot_escape_the_place(tmp_path):
    """다운로드 안의 정션이 C:\\Windows를 가리키면 resolve_in_place → None, 동작은 VERIFY_FAILED. '..' 조각은 계약에서 DENIED_SCHEMA."""


async def test_user_switch_wins_and_unchanged_foreground_keeps_surface():
    """
    resolve_focus 표: (청음이 웹을 열었고 앞 창은 그대로 탐색기) → web, (사용자가 Alt+Tab으로 카카오톡) → desktop/foreign,
    (앞 창이 청음 셸) → 지난 표면, (데스크톱 꺼짐) → web.
    """


async def test_picture_answer_is_labelled_and_unverified_numbers_named(new_session):
    """
    s.deps.vision_llm = FakeVision(reading("기초연금 인상 안내 포스터예요.", details=["월 최대 34만 2510원"]))
    모의 사이트 이미지 공지 페이지에서 "화면 사진으로 설명해줘"
    → 말이 "화면 그림을 보고 말씀드릴게요."로 시작, "34만 2510원" 뒤에 '그림에서만 보이는 숫자' 안내, flags.picture True,
      FakeVision.calls[0]의 user에 입력 칸 값 없음, 그림 1장.
    """


async def test_captcha_page_is_never_captured(new_session):
    """reCAPTCHA 틀이 있는 페이지에서 "화면 사진으로 설명해줘" → FakeVision 호출 0번, 자동 입력 방지 안내."""


async def test_rules_do_not_steal_existing_examples():
    """
    "받은 파일 읽어줘"→READ_DOWNLOAD, "받은 파일 목록"→READ_DOWNLOAD, "지금 화면에 뭐가 있어?"→DESCRIBE_SCREEN,
    "크롬 켜줘"→OPEN_BROWSER, "신청서 열어줘"→START_APPLICATION, "이 사진 뭐야?"→DESCRIBE_SCREEN,
    "사진 폴더 열어줘"→OPEN_APP, "바탕화면에 뭐 있어?"→LIST_ITEMS, "2번 열어줘"→UNKNOWN(번호 고르기는 _unknown),
    "다운로드 폴더에 뭐 있어?"→LIST_ITEMS{more: False}('폴더'의 '더'에 속지 않음), "이 파일 읽어줘"→READ_ITEM{name: "이"}.
    """


async def test_deictic_read_falls_back_to_download_when_desktop_off(new_session):
    """데스크톱이 꺼진 세션에서 "이 파일 읽어줘" → 오늘처럼 받은 파일(READ_DOWNLOAD) 읽기."""
