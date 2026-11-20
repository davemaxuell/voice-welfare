"""
사진을 쓸지 말지: 순수 함수 하나와 거절 말 하나. 표로 시험한다(tests/unit/test_sight_policy.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import AbstractSet, Literal

from cheongeum.core.vision import PICTURE_ASK, ScreenFacts, ShotRefusalReason

# 글이 이만큼보다 적고 그림·캔버스·액자가 크게 있으면 '글이 거의 없는 화면'이다(주인 결정: 사진은 요청 때나 글이 적을 때만).
LITTLE_TEXT_CHARS = 150

Mode = Literal[
    "text",  # 지금처럼 글로만(사진을 찍지 않는다)
    "ask",  # 사진이 도움이 되지만 이번 대화에서 아직 허락받지 않았다 → 한 번 묻는다
    "both",  # 글 설명 뒤에 사진으로 더 본 것을 잇는다(사진만으로 말하지 않는다: 글이 있으면 글이 먼저다)
    "refuse",  # 사진을 청했는데 이 화면은 사진 길에 넣지 않는다(이유를 말한다)
]


@dataclass(frozen=True)
class Advice:
    mode: Mode
    reason: ShotRefusalReason | None = None
    # trace에 남기는 짧은 이유("사용자가 사진을 청함", "글이 거의 없고 큰 그림이 있음")
    why: str = ""
    # 사용자가 사진을 청했는데 못 하는 경우에 덧붙일 말이 있는가(사진 설명이 꺼져 있음 등)
    note: str = ""


def advise(facts: ScreenFacts, ask: str, grants: AbstractSet[str], *, available: bool) -> Advice:
    """
    순서:
      1) 사진이 도움이 될 때만 본다: 사용자가 청했다(PICTURE_ASK) 또는 글이 거의 없고 글로 안 읽히는 것이 크게 있다(LITTLE_TEXT_CHARS).
         둘 다 아니면 mode="text". 사진이 필요 없는 말에는 어떤 안내도 붙이지 않는다.
      2) 사진 길에서 빼는 화면(facts.blocked: 로그인·본인인증·보안문자·접속 차단)이면 mode="refuse", reason=그것.
         사용자가 청하지 않았으면 조용히 글로 간다(글 길에는 이미 blocked_speech가 있다).
      3) available이 False(사진 모델 없음)면 mode="text". 청한 경우에만 note로 '사진 설명이 켜져 있지 않아요'.
      4) "shot"이 grants에 없으면 mode="ask". 있으면 mode="both".
    """
    raise NotImplementedError


def refusal_speech(reason: ShotRefusalReason) -> str:
    """
    거절 이유를 말로. 코드가 만든 문장만 쓴다(화면 글·모델 글 없음). 모두 '무엇을 대신 할 수 있는지'로 끝난다.
      login → "로그인 화면은 사진으로 설명하지 않아요. 입력 칸 안내는 글로 해 드릴게요."
      verification → "본인 확인 화면은 사진으로 설명하지 않아요. 인증은 직접 하셔야 해요."
      captcha → "보안문자는 읽지도 풀지도 않아요. 도움이 필요하면 옆에 있는 분께 부탁해 주세요."
      blocked → (기존 blocked_speech를 쓰므로 여기서는 말하지 않는다)
      unmaskable → "가려야 할 개인 정보를 화면에서 찾지 못해서 사진은 보내지 않았어요. 글로 설명해 드릴게요."
      no-tier / stopped / minimized / unavailable → 각각 한 문장
    """
    raise NotImplementedError
