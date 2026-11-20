"""
⑥ 사진 길(sight): 화면 사진을 언제 쓰고, 어떻게 보고, 어떻게 말할지.
웹인지 앱 창인지 모른다. ScreenFacts(글로 아는 것)와 ShotSource(사진을 찍어 주는 쪽)만 안다.
공개하는 것은 Sight 하나(와 그 결과 Seen)다. 규칙(policy.py)과 검증·말하기(answer.py)는 이 패키지 안에서만 쓴다.
단계 방향: sight → core, safety, speech.phrasing. (test_layers.ALLOWED에 한 줄)
"""
from cheongeum.sight.sight import Advice, Seen, Sight

__all__ = ["Advice", "Seen", "Sight"]
