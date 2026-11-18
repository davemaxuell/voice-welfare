from cheongeum.agents.web.approval import fingerprint, recheck

LOGIN = {"ref": "r7-ab", "role": "button", "name": "로그인", "region": "menu", "disabled": False}
CLICK = {"id": "c1", "type": "click", "target": {"ref": "r7-ab", "role": "button", "name": "로그인"}}
FILL = {"id": "f1", "type": "fill", "target": {"fieldId": "address", "name": "주민등록 주소"}, "value": "부산광역시 예시구 예시로 10"}


def view(main="본문", url="https://example.kr/a?x=1", items=(LOGIN,), address="") -> dict:
    return {
        "url": url,
        "title": "가",
        "fields": [{"fieldId": "address", "label": "주민등록 주소", "value": address}],
        "outline": {"mainText": main, "items": list(items)},
    }


def change(before: dict, now: dict, action: dict = CLICK) -> str | None:
    return recheck(fingerprint(before, [action], "누를까요?"), now, [action])[1]


def test_body_text_and_title_changes_do_not_count():
    assert change(view("알림: 점검 1호"), {**view("알림: 점검 2호"), "title": "나"}) is None


def test_page_change_is_named():
    assert change(view(), view(url="https://example.kr/b")) == "여쭤본 뒤에 화면이 바뀌었어요."


def test_target_gone_or_replaced_is_named():
    assert change(view(), view(items=())) == "누르려던 '로그인' 버튼이 화면에서 없어졌어요."
    assert change(view(), view(items=({**LOGIN, "name": "회원 탈퇴"},))) == "누르려던 '로그인' 버튼이 다른 것으로 바뀌었어요."


def test_value_change_in_a_read_back_field_is_named():
    assert change(view(), view(address="다른 주소"), FILL) == "주민등록 주소 칸 값이 바뀌었어요."
    assert change(view(), view(), FILL) is None


def test_recheck_returns_a_fresh_fingerprint_with_the_same_sentence():
    asked = fingerprint(view(), [CLICK], "누를까요?")
    now, changed = recheck(asked, view("다른 본문"), [CLICK])
    assert changed is None
    assert now == asked


def test_proposed_fill_value_is_bound_in_the_fingerprint():
    """아직 화면에 없는 넣을 값도 지문에 묶여, 승인 대기 중 값이 바뀌면 막는다."""
    asked = fingerprint(view(), [FILL], "넣을까요?")
    assert asked["actions"][0].get("valueHash")
    mutated = {**FILL, "value": "서울시 다른구 다른로 1"}
    _, changed = recheck(asked, view(), [mutated])
    assert changed == "여쭤본 뒤에 넣을 값이 바뀌었어요."
    _, ok = recheck(asked, view(), [FILL])
    assert ok is None
