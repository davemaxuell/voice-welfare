import pytest

from cheongeum.core.lexicon import ack_kind, agree, approval, cancel_reply, done_reply, foreign_approval


@pytest.mark.parametrize("text,lang,want", [
    ("승인", "ko", "approve"), ("모의접수 승인", "ko", "approve"), ("응", "ko", "approve"),
    ("눌러줘", "ko", "approve"), ("보내줘", "ko", "approve"),
    ("아니", "ko", "reject"), ("보내지 마", "ko", "reject"),
    ("이 버튼 눌러도 돼?", "ko", None), ("응 근데 이거 뭐야", "ko", None),
    ("Yes, go ahead", "en", "approve"), ("no", "en", "reject"), ("승인", "en", None),
    ("はい", "ja", "approve"), ("取消", "zh", "reject"),
])
def test_approval(text, lang, want):
    assert approval(text, lang) == want


def test_foreign_approval_ignores_korean_sessions():
    assert foreign_approval("응", "ko") is None


@pytest.mark.parametrize("text,want", [("어", "yes"), ("맞아요", "yes"), ("yes", "yes"), ("はい", "yes"), ("아냐", "no"), ("不对", "no"), ("글쎄", None)])
def test_agree(text, want):
    assert agree(text) == want


@pytest.mark.parametrize("text,want", [("알았어요.", "ack"), ("괜찮아", "no"), ("알았어 다음", None)])
def test_ack_kind(text, want):
    assert ack_kind(text) == want


@pytest.mark.parametrize("text,want", [("다 했어요", True), ("I'm done", True), ("다음으로", False)])
def test_done_reply(text, want):
    assert done_reply(text) is want


def test_login_secret_exemption_requires_the_whole_reply():
    assert done_reply("I'm done", whole=True)
    assert not done_reply("apple done tree", whole=True)


@pytest.mark.parametrize("text,want", [("인증 취소", True), ("cancel", True), ("취소 수수료 얼마야", False)])
def test_cancel_reply(text, want):
    assert cancel_reply(text) is want


@pytest.mark.parametrize("text", [
    "Please don't cancel", "What happens if I cancel?", "인증 취소하지 마세요",
    "不要取消", "キャンセルしないでください",
])
def test_sign_in_cancellation_respects_the_whole_reply(text):
    assert not cancel_reply(text)


@pytest.mark.parametrize("text", [
    "I'm not done yet", "I'll let you know when I'm done", "로그인 완료했어?",
    "인증을 다 했어요, 아니 아직이에요", "别以为我已经完成了", "「終わりました」とは言っていません",
])
def test_sign_in_completion_requires_an_affirmative_statement(text):
    assert not done_reply(text)


@pytest.mark.parametrize("text", ["인증이 끝났어요.", "로그인했어요", "I’m done.", "完成了。", "終わりました！"])
def test_sign_in_accepts_complete_spoken_statements(text):
    assert done_reply(text)
