"""암호화 조작 기록·봉인."""
from __future__ import annotations

import os

from cheongeum.agents.web.agent import _action_label
from cheongeum.personal.action_log import ActionLog
from cheongeum.personal.commands import parse_personal_command
from cheongeum.personal.seal import Seal


def test_seal_roundtrip():
    key = os.urandom(32)
    s = Seal(key=key)
    blob = s.seal(b'{"ok":true}')
    assert s.is_sealed(blob)
    assert s.open(blob) == b'{"ok":true}'


def test_action_log_hash_chain(tmp_path):
    key = os.urandom(32)
    seal = Seal(key=key)
    path = tmp_path / "actions.sealed"
    log = ActionLog(str(path), seal=seal)
    a = log.append({"host": "example.go.kr", "actionType": "click", "label": "다음 누르기", "phase": "before"})
    b = log.append({"host": "example.go.kr", "actionType": "click", "label": "다음 누르기", "phase": "after", "ok": True})
    assert a["hash"] == b["prev"]
    assert path.exists()
    if hasattr(os, "stat") and os.name != "nt":
        assert (path.stat().st_mode & 0o777) == 0o600
    again = ActionLog(str(path), seal=seal)
    assert len(again.recent(10)) == 2
    assert "오늘 한 일" in again.speak_recent()


def test_action_log_refuse_path_memory():
    log = ActionLog()
    log.append({"actionType": "navigate", "label": "포털 열기", "phase": "before"})
    assert log.speak_recent().startswith("오늘 한 일")


def test_parse_action_log_read():
    assert parse_personal_command("오늘 한 일 들려줘") == {"kind": "action-log-read"}
    assert parse_personal_command("오늘 뭐 했어") == {"kind": "action-log-read"}


def test_action_label_redacts():
    assert "검색" in _action_label({"type": "fill", "reason": "검색어 입력: 기초연금"})
