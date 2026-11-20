"""
서버가 제안하는 선택지(아바타·대화 창 버튼). 무엇을 제안할지도, 고른 뒤 무엇을 할지도 서버가 정한다.
버튼 이름은 그대로 말해도 같은 뜻이 되게 정한다(로그인했어요 → AUTH_DONE, 인증 취소 → 인계 취소).
"""
from __future__ import annotations

from typing import Literal

ChoiceKey = Literal["auth-done", "auth-cancel", "read-main"]
CHOICE_KEYS: tuple[str, ...] = ("auth-done", "auth-cancel", "read-main")

_LABELS: dict[str, dict[str, str]] = {
    "auth-done": {"ko": "로그인했어요", "en": "I'm done", "zh": "完成了", "ja": "終わりました"},
    "auth-done-check": {"ko": "인증 끝났어요", "en": "I'm done", "zh": "完成了", "ja": "終わりました"},
    "auth-cancel": {"ko": "인증 취소", "en": "Cancel", "zh": "取消", "ja": "キャンセル"},
    "read-main": {"ko": "본문 읽기", "en": "Read the page", "zh": "朗读正文", "ja": "本文を読む"},
}

# 고르면 이 말과 의도로 한 턴을 처리한다(기록에도 이 말로 남는다). 말이 None이면 버튼 이름(한국어) 그대로.
# 인계 취소는 말 규칙으로 알아듣으므로 '인증 취소'여야 한다.
CHOICE_TURNS: dict[str, tuple[str | None, dict]] = {
    "auth-done": (None, {"type": "AUTH_DONE"}),
    "auth-cancel": ("인증 취소", {"type": "REJECT"}),
    "read-main": ("본문 읽어줘", {"type": "READ_MAIN", "more": False}),
}


def choice_label(key: str, lang: str, auth_kind: str | None = None) -> str:
    row = _LABELS["auth-done-check" if key == "auth-done" and auth_kind not in (None, "login") else key]
    return row.get(lang) or row["ko"]
