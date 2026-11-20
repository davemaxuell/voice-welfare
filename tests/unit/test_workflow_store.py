from concurrent.futures import ThreadPoolExecutor
import os
from uuid import uuid4

import pytest

from cheongeum.server.workflow_store import DIMENSIONS, LEASE_SECONDS, WorkflowStore, installation_owner
from cheongeum.server.workflows import public_result, safe_input


@pytest.fixture(params=["sqlite", "postgres"])
def database(request, tmp_path):
    dsn = ""
    if request.param == "postgres":
        if not (dsn := os.environ.get("CHEONGEUM_TEST_DATABASE_URL")):
            pytest.skip("Set CHEONGEUM_TEST_DATABASE_URL to run the PostgreSQL/pgvector integration")
    path = tmp_path / "queue.db"
    owner = installation_owner(tmp_path / "profile")
    assert installation_owner(tmp_path / "profile") == owner
    return WorkflowStore(path, owner, dsn), WorkflowStore(path, str(uuid4()), dsn)


def test_claim_cancel_retry_restart_and_isolation(database):
    store, other = database
    key = str(uuid4())
    first = store.enqueue(key, "국가장학금 신청 기간", "ko")
    assert first == store.enqueue(key, "국가장학금 신청 기간", "ko")
    with pytest.raises(ValueError, match="conflict"):
        store.enqueue(key, "다른 질문", "ko")
    assert not other.jobs() and other.claim() is None and not other.cancel(first)
    restarted = WorkflowStore(store.path, store.owner, store.dsn)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda s: s.claim(now=50), [store, restarted]))
    job, = [r for r in claims if r]
    assert job["id"] == first
    replacement = restarted.claim(now=51 + LEASE_SECONDS)
    assert replacement["id"] == first and replacement["lease"] != job["lease"]
    assert not store.finish(job, "completed", {"text": "stale"})
    assert store.cancel(first) and not restarted.finish(replacement, "completed")
    assert restarted.jobs()[0]["state"] == "cancelled"
    assert restarted.delete_job(first)
    store.enqueue(str(uuid4()), "정부24 발급 안내", "ko")
    for i in range(3):
        job = store.claim(now=5000000000 + i * LEASE_SECONDS)
        store.retry(job)
    assert store.jobs()[0]["state"] == "failed"


def test_semantic_and_keyword_recall_and_forget(database):
    store, other = database
    vector = [1, *([0] * (DIMENSIONS - 1))]
    model = "text-embedding-3-small"
    saved = store.note("Scholarship information in English", vector, model)
    second = store.note("Prefer large type", None, None)
    assert store.search("장학금", vector, model) == [{"id": saved, "body": "Scholarship information in English"}]
    assert store.search("large", None, None)[0]["id"] == second
    assert not other.search("장학금", vector, model) and not other.delete_note(saved)
    assert store.note("Scholarship information in English", vector, model) == saved
    assert store.delete_note(saved) and not store.search("장학금", vector, model)


def test_only_explicit_public_inputs_and_verified_results_can_be_saved():
    for bad in ("name@example.org", "password is 567812", "https://portal.example/?token=private", "sk-" + "x"*40):
        assert safe_input(bad, 600) is None
    assert public_result("completed", {"text": "unsupported", "sources": []}) == ("incomplete", None)
    assert public_result("completed", {"text": "answer", "sources": [{"url": "javascript:alert(1)"}]}) == ("incomplete", None)
