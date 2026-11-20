"""
[새 파일] 데스크톱 창 그림에서 가릴 요소(순수 함수). WindowsDesktop.capture_window가 UIA 요소마다 부른다.
웹의 capture.plan_masks와 같은 원칙: 입력 칸은 모두, 글은 개인정보로 판정된 것만. 판정은 safety.detect_sensitive 한 곳.
"""
from __future__ import annotations

# 값을 넣는 칸(안 보이게 가린다): Edit·Document(편집 가능)·ComboBox의 편집 부분·Spinner
EDITABLE_TYPES = frozenset({"EditControl", "DocumentControl", "ComboBoxControl", "SpinnerControl"})


def should_mask(control_type: str, is_password: bool, editable: bool, name: str) -> bool:
    """비밀번호 칸·편집 가능한 칸은 언제나, 그 밖은 detect_sensitive(name).hasSecretValue일 때."""
    raise NotImplementedError
