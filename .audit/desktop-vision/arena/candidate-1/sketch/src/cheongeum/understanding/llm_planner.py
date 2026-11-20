"""
[바뀌는 부분만] understanding/llm_planner.py · flat_to_intent(llm_planner.py:54)

새 네 종류의 평탄화 칸 대응. 새 칸은 없다(topic·more만 씀). 그래서 INTENT_JSON_SCHEMA와 시험의 to_flat이 그대로다.
LLM이 고른 이름은 그대로 실행되지 않는다: OPEN_APP의 target은 understanding/apps.py 표에서 찾지 못하면 실행하지 않고,
OPEN_ITEM·READ_ITEM의 name은 청음이 읽어 준 목록(파일 시스템)에서 찾지 못하면 되묻는다.
"""


def flat_to_intent_desktop_branches(t: str, flat: dict, topic, utterance: str, candidate: dict) -> None:
    """flat_to_intent 안에 들어갈 분기(설명용으로 함수로 뗌):

    if t == "OPEN_APP":
        candidate["target"] = topic if topic is not None else utterance
    if t == "LIST_ITEMS":
        if topic:
            candidate["target"] = topic
        candidate["more"] = flat.get("more") is True
    if t in ("OPEN_ITEM", "READ_ITEM"):
        candidate["name"] = topic          # 이름 없으면 parse_intent가 실패 → None → 규칙 결과(추측 금지)
    """
    raise NotImplementedError
