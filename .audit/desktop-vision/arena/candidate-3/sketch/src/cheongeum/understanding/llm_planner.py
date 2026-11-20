"""
understanding/llm_planner.py: 바뀌는 곳만. flat_to_intent(llm_planner.py:54)가 의도마다 손으로 적은 분기(:72-89: POLICY_QUESTION→topic, GOAL→goal, OPEN_SITE→target,
FOLLOW_LINK→name, SEARCH→query, SERVICE_DETAIL·PRECHECK·PREPARE_APPLY→service)를 의도 표의 topic_param 칸 하나로 바꾼다.

이유: 새 의도 다섯 개가 오는데, 분기를 다섯 개 더 적으면 '의도 하나 더하기 = 표, 규칙, ROUTES, flat_to_intent' 네 곳 수정이 된다.
표에 칸이 있으면 flat_to_intent는 새 의도를 모르고도 맞게 돈다. 손으로 적은 분기와 표가 어긋날 수 없게 같은 변경에서 옛 분기를 지운다.
LLM이 만들 수 없는 것(APPROVE, STOP, PROGRESS)은 그대로 표의 llm=False(llm_planner.py:21).
"""
from __future__ import annotations

from typing import Any

# flat_to_intent 몸의 가운데(기존 :70-89 를 이 열 줄로):
#
#   spec = SPEC_BY_TYPE[t]                                # 의도 표에서 한 번 만든 dict
#   topic = flat.get("topic")
#   if spec.topic_param:
#       candidate[spec.topic_param] = topic if topic is not None else (utterance if spec.topic_defaults_to_utterance else None)
#   # (more·list·fills·fieldMention 처럼 topic이 아닌 칸은 기존 분기를 그대로 둔다: 칸 이름이 다른 일은 표가 모른다)
#
# topic_defaults_to_utterance는 기존에 topic이 비면 발화를 대신 쓰던 셋(POLICY_QUESTION·GOAL·OPEN_SITE)만 True.
# 새 앱 의도는 False: 이름이 없으면 None → parse_intent가 거절 → '계획 전체가 규칙 결과로 돌아간다'(추측 금지, test_registry.py:135-137 와 같은 방식).
#
# 모델이 낸 이름(OPEN_APP의 target, APP_OPEN_ITEM의 name)은 여기서 검증하지 않는다. 사용자 말에서 나온 글일 뿐 명령이 아니다.
# 앱은 resolve_app, 폴더·파일은 AppAdapter가 파일 시스템에서 다시 찾는다. 못 찾으면 실행하지 않고 되묻는다.


def flat_to_intent(flat: Any, utterance: str) -> dict | None:
    raise NotImplementedError
