"""
[새 파일] 데스크톱에서 말할 문장(코드가 짬). speech.phrasing의 josa·chunk_text를 쓴다. 파일 이름·창 제목은 비신뢰 글이라
따옴표 안에 이름으로만 넣고, 그 글이 시키는 말은 따르지 않는다.
"""
from __future__ import annotations

from cheongeum.agents.desktop.model import DesktopView, FolderView


def describe_folder(folder: FolderView, *, app_label: str | None) -> str:
    """
    "파일 탐색기, 다운로드 폴더예요. 파일 23개, 폴더 2개가 있어요. 선택된 것은 '신청서.hwp'예요.
     목록은 '파일 목록 알려줘', 내용은 '1번 읽어줘'라고 하세요."(사용법 안내는 Narrator.once처럼 대화에서 한 번)
    """
    raise NotImplementedError


def list_page(folder: FolderView, offset: int, count: int) -> str:
    """
    "최근 바뀐 순서로 읽을게요. 1번 기초연금 안내 PDF 파일, 오늘. 2번 회의자료 폴더. … 더 들으려면 '파일 목록 더 알려줘'."
    날짜는 오늘·어제·n일 전·M월 D일(speak_date). 인터넷에서 받은 파일은 이름 뒤에 '받은 파일'을 붙이지 않는다(길어짐): 열 때 말한다.
    """
    raise NotImplementedError


def describe_foreign(view: DesktopView) -> str:
    """"'<제목>' 창이에요. 제가 조작할 수는 없고 읽어 드리기만 해요. 보이는 글: …"(UIA 이름 앞 200자, redact_text)."""
    raise NotImplementedError
