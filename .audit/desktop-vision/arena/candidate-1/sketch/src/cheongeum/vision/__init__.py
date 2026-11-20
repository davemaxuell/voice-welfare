"""
[새 단계] 화면 그림 설명. 웹 기술(agents.web.skills)과 데스크톱 기술(agents.desktop)이 같은 한 곳을 부른다.
가져오는 단계: core, safety, speech.phrasing (tests/unit/test_layers.py ALLOWED에 "vision" 줄).
밖에서 쓰는 것은 ScreenPicture·PictureAnswer·choose_source뿐이다.
"""
from cheongeum.vision.picture import PictureAnswer, ScreenPicture, choose_source

__all__ = ["PictureAnswer", "ScreenPicture", "choose_source"]
