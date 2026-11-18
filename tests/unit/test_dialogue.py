import pytest

from cheongeum.core.dialogue import DialogueState

APPROVAL = {"action": {"id": "submit-1"}, "confirmation": {"actionId": "submit-1"}}


@pytest.mark.parametrize(
    "name",
    ["state", "approval", "awaiting", "clarification", "profile_question", "vault_confirm", "guided", "auth_resume"],
)
def test_slots_are_read_only(name):
    d = DialogueState("IDLE")
    with pytest.raises(AttributeError):
        setattr(d, name, None)


def test_value_filled_releases_matching_wait_and_voids_approval():
    d = DialogueState("APPLICATION_OPEN")
    d.ask_value("applicantName")
    d.ask_approval(APPROVAL)
    d.value_filled("applicantName")
    assert d.awaiting is None
    assert d.approval is None
    assert d.confirmation is None


def test_value_filled_keeps_wait_for_another_field():
    d = DialogueState("APPLICATION_OPEN")
    d.ask_value("address")
    d.ask_approval(APPROVAL)
    d.value_filled("applicantName")
    assert d.awaiting == "address"
    assert d.approval is None


def test_navigated_off_form_drops_wait_and_approval():
    d = DialogueState("APPLICATION_OPEN")
    d.ask_value("applicantName")
    d.ask_approval(APPROVAL)
    d.navigated(on_form=False)
    assert d.awaiting is None
    assert d.approval is None


def test_navigated_on_form_keeps_wait():
    d = DialogueState("APPLICATION_OPEN")
    d.ask_value("applicantName")
    d.ask_approval(APPROVAL)
    d.navigated(on_form=True)
    assert d.awaiting == "applicantName"
    assert d.approval is None


def test_approval_age_counts_from_the_latest_ask():
    now = [100.0]
    d = DialogueState("APPLICATION_OPEN", clock=lambda: now[0])
    d.ask_approval(APPROVAL)
    now[0] += 90
    assert d.approval_age == 90
    d.ask_approval(APPROVAL)
    assert d.approval_age == 0


def test_stop_clears_every_wait():
    d = DialogueState("APPLICATION_OPEN")
    d.ask_approval(APPROVAL)
    d.ask_value("applicantName")
    d.ask_which("부산", ["주민등록 주소", "실거주지 주소"])
    d.ask_profile("age")
    d.ask_vault_confirm({"kind": "vault-clear"})
    d.start_guided("https://example.org/form", ["f1", "f2"])
    d.hold_auth({"kind": "form"})
    d.stop()
    assert (d.approval, d.awaiting, d.clarification) == (None, None, None)
    assert (d.profile_question, d.vault_confirm, d.guided, d.auth_resume) == (None, None, None, None)


def test_hold_auth_and_take_resume():
    d = DialogueState("APPLICATION_OPEN")
    d.hold_auth({"kind": "form"})
    assert d.auth_resume == {"kind": "form"}
    assert d.take_auth_resume() == {"kind": "form"}
    assert d.auth_resume is None
