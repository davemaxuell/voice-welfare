"""
⑥ 앱 창을 귀로 듣게 풀어 말하는 규칙 문장. speech/screen.py의 Narrator(screen.py:23)의 앱 쪽 짝이되 LLM이 없다.

폴더·파일 이름은 비신뢰 데이터이자 사적인 글이다. 그래서 이 모듈은 (가) 이름을 말로만 내보내고, (나) 어떤 LLM 입력도 만들지 않는다.
단계: speech.phrasing 층(core, safety만 가져옴). core.desktop의 WindowView 모양 dict만 받는다.
"""
from __future__ import annotations

PAGE_SIZE = 8  # 한 번에 읽어 줄 항목 수(귀로 듣는 목록은 짧게)


def kind_word(ext: str | None, kind: str) -> str:
    """종류를 한두 낱말로: pdf → "PDF 파일", hwp·hwpx → "한글 문서", docx → "워드 문서", jpg·png → "사진", mp3 → "음악 파일", 폴더 → "폴더", 모르면 "파일"."""
    raise NotImplementedError


def speak_entry(item: dict) -> str:
    """항목 하나: "이력서 PDF 파일", "계약서 폴더". 확장자는 말하지 않고 종류 낱말로 바꾼다(탐색기가 확장자를 숨기는 사용자 설정과 같게 들린다)."""
    raise NotImplementedError


def speak_window(view: dict, offset: int = 0) -> str:
    """
    창 모습을 한 번에 말할 문장. offset은 이어 읽기(목록 더)의 시작 위치.
      home:   "파일 탐색기예요. 갈 수 있는 곳은 다운로드, 문서, 바탕 화면, 사진이에요."
      folder: "{폴더 이름} 폴더예요. 폴더 {n}개, 파일 {m}개가 있어요. {앞 8개}. 더 들으시려면 '더'라고 하세요."
              비어 있으면 "{폴더 이름} 폴더는 비어 있어요."  truncated면 "너무 많아서 앞쪽만 읽어요."를 덧붙인다.
    숫자는 코드가 센 값뿐이다(verify.py 대상 아님: 화면 글이나 모델 글에서 온 숫자가 없다).
    """
    raise NotImplementedError
