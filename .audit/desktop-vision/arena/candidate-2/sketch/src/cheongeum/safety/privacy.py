"""
[바뀌는 것만] safety/privacy.py — 함수 하나를 밖으로 낸다.

redact_text(privacy.py:165)는 글을 통째로 바꾼 결과만 준다. 사진을 가리려면 "어느 글이 값인가"가 필요하다.
같은 판정을 두 번 적지 않도록, redact_text의 앞 두 단계(모델 구간·한글로 읽은 번호, VALUE_PATTERNS)를 private_values로 내고
redact_text가 그것을 쓰게 고친다(결과 글은 지금과 같아야 한다: tests/unit/test_llm_privacy.py가 그대로 통과).
"""
from __future__ import annotations


def private_values(text: str) -> list[str]:
    """
    글 안에서 개인정보 '값'으로 판정된 문자열들: VALUE_PATTERNS(주민번호·카드번호 모양, privacy.py:44),
    로컬 모델의 1등급 구간(_model_spans), 한글로 읽은 주민번호·카드번호(spoken_digit_spans).
    키워드("주민등록번호")만 있고 값 모양이 없으면 아무것도 돌려주지 않는다.

    redact_text와의 차이: redact_text의 세 번째 단계는 키워드 뒤에 숫자가 어디든 있으면 그 뒤를 모두 가린다(:175-181).
    그 규칙을 사진에 그대로 쓰면 구비서류에 '주민등록번호'가 적힌 복지 안내 화면 대부분이 검게 된다.
    그래서 사진 가림은 값 구간 + 입력 칸 전부 + 금고 값 + 이번 대화에서 넣은 값을 쓰고,
    로그인·인증·신청서 화면은 아예 찍지 않는다(agents/web/shot.picture_refusal).
    """
    raise NotImplementedError
