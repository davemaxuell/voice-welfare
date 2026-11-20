"""
[바뀌는 부분만] understanding/filters.py

picture_request: 사용자가 그림으로 봐 달라고 했는지(사용자 말만 본다. 화면 글은 보지 않는다).
BrowseSkill.screen이 지금 '자세히'를 말에서 보는 것(browse.py:492)과 같은 자리에서 쓴다. 새 의도를 만들지 않는다.
"""
from __future__ import annotations

from cheongeum.core.jsutil import rx

_PICTURE = rx(
    r"(사진|그림|이미지|스크린\s*샷|캡처)\s*(으로|로)"
    r"|(생김새|모양|보이는\s*대로|어떻게\s*생겼|색깔|배치)"
    r"|(사진|그림|이미지|도표|그래프|차트|포스터)\s*(이|가|은|는|을|를)?\s*(뭐|설명|어떻게|무슨|읽어)"
)


def picture_request(text: str) -> bool:
    """"화면 사진으로 설명해줘", "어떻게 생겼어?", "이 그래프 설명해줘" → True."""
    raise NotImplementedError
