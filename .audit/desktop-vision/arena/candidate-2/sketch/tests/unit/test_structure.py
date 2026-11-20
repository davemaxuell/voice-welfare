"""
[바뀌는 시험·새 시험] 구조를 고정하는 시험들. 사람이 기억해야 할 규칙을 실패하는 시험으로 바꾼 것이다.
"""

# ---------------------------------------------------------------- tests/unit/test_layers.py (:12 ALLOWED, :44 layer)
#
# ALLOWED에 두 줄, 기존 두 줄에 낱말:
#   "agents.desktop":        {"core", "safety", "speech.phrasing"},
#   "agents.desktop.skills": {"agents.desktop", "core", "safety", "speech.phrasing", "understanding"},
#   "orchestrator":          {..., "agents.desktop", "agents.desktop.skills"},
#   "server":                {..., "agents.desktop"},
# layer()는 agents/web/skills만 따로 보던 것(:46)을 agents/<이름>/skills 모두로 넓힌다.
# 고정되는 것: agents.desktop과 agents.web은 서로 가져오지 않는다. 둘 다 speech.screen(Narrator)을 가져오지 않는다.
# speech/picture.py는 layer()에서 "speech.phrasing" 단계다(:52). core·safety만 가져온다.
# safety/run.py는 core만 가져온다(ExecContext가 core/exec.py로 옮겨 갔기 때문에 가능하다).


def test_picture_is_only_sealed_by_the_two_capture_functions():
    """
    src 전체의 AST에서 `Picture.masked(`와 `Picture(` 호출을 찾는다.
    허용: agents/web/browser/__init__.py 의 capture, agents/desktop/windows.py 의 capture. 그 밖에 있으면 실패.
    (가리지 않은 바이트가 Picture가 되는 길이 새로 생기면 여기서 걸린다)
    """
    raise NotImplementedError


def test_vision_is_called_from_one_place():
    """`.see(` 호출은 speech/picture.py의 Eyes.describe 한 곳뿐이다(사진이 다른 프롬프트로 새지 않게)."""
    raise NotImplementedError


def test_web_and_desk_action_types_do_not_overlap():
    """set(ACTION_TYPES) & set(DESK_ACTION_TYPES) == set(). TurnResult.actions의 합(Union)이 한쪽으로만 읽히는 근거."""
    raise NotImplementedError


def test_no_coordinates_in_any_contract():
    """
    Action, ActionTarget, 모든 DeskAction, ItemTarget, FolderRef, UiItem, Entry, DeskView, MaskPlan의 필드 이름에
    x, y, left, top, width, height, box, rect, coords, hwnd, pid 가 없다.
    그리고 parse_action({... "coords": [1, 2]})와 parse_desk_action({... "coords": [1, 2]})가 None이다(test_policy.py:50의 짝).
    """
    raise NotImplementedError


def test_every_app_row_is_complete():
    """
    core.apps.APPS의 줄마다: names가 비지 않고, verbs가 DESK_ACTION_TYPES의 부분집합이고, acts의 name이 서로 다르고,
    resolve_app(names[0])가 그 줄을 돌려준다. PLACES도 같다. (의도 표의 test_registry와 같은 역할)
    """
    raise NotImplementedError


def test_every_approval_kind_has_a_not_done_sentence():
    """src에서 ask_approval({... "kind": X ...})의 X를 AST로 모아 NOT_DONE의 키와 같은지 본다(KeyError로 턴이 죽지 않게)."""
    raise NotImplementedError
