from concurrent.futures import ThreadPoolExecutor

import pytest

from cheongeum.personal.action_log import ActionLog, GENESIS
from cheongeum.personal.store import PersonalStore


def test_interrupted_save_keeps_confirmed_profile_in_memory_and_on_disk(tmp_path, monkeypatch):
    path = str(tmp_path / "profile.json")
    store = PersonalStore(path)
    store.save_speech({"length": "short"})

    def unavailable(*_):
        raise OSError("simulated failed replace")

    monkeypatch.setattr("cheongeum.personal.atomic.os.replace", unavailable)
    with pytest.raises(OSError):
        store.save_speech({"length": "long"})
    assert store.speech() == PersonalStore(path).speech()
    assert store.speech()["length"] == "short" and len(list(tmp_path.iterdir())) == 1


def test_parallel_approval_journal_keeps_one_chain(tmp_path):
    path = str(tmp_path / "actions.json")
    journal = ActionLog(path)
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda n: journal.append({"label": str(n)}), range(16)))
    rows = ActionLog(path).recent(16)
    assert [r["seq"] for r in rows] == list(range(1, 17))
    assert [r["prev"] for r in rows] == [GENESIS, *(r["hash"] for r in rows[:-1])]
