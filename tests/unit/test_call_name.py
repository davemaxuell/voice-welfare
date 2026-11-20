"""부르는 이름: 개인 금고에 두고, 내 정보를 지우면 함께 지운다."""
from cheongeum.personal.store import PersonalStore
from cheongeum.speech.phrasing import speak_call_name


def test_call_name_round_trip_and_cleared_with_vault(tmp_path):
    path = str(tmp_path / "p.json")
    store = PersonalStore(path)
    store.set_call_name("홍길동")
    assert PersonalStore(path).call_name() == "홍길동"
    store.clear_vault()
    assert PersonalStore(path).call_name() is None


def test_setting_none_forgets_the_call_name(tmp_path):
    store = PersonalStore(str(tmp_path / "p.json"))
    store.set_call_name("홍길동")
    store.set_call_name(None)
    assert store.call_name() is None


def test_speak_call_name_never_doubles_nim():
    assert speak_call_name("홍길동") == "홍길동님"
    assert speak_call_name("길동님") == "길동님"
