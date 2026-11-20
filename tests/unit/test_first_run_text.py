"""동의 뒤 첫 실행 대화의 고정 문장과 부르는 이름 알아듣기."""
import json
import struct
from pathlib import Path

import pytest

from cheongeum.core.dialogue import DialogueState
from cheongeum.orchestrator.first_run import INTRO, INTRO_NONAME, LINES, call_name_from

LANGS = {"ko", "en", "zh", "ja"}
GLB = Path(__file__).resolve().parents[2] / "src" / "cheongeum" / "web" / "static" / "avatar" / "cheongeum-avatar.glb"


@pytest.mark.parametrize(("said", "name"), [
    ("홍길동", "홍길동"), ("홍길동이라고 불러 줘", "홍길동"), ("홍길동이라고 불러주세요", "홍길동"), ("길동님", "길동"),
    ("음 김하늘이에요", "김하늘"), ("김하늘입니다", "김하늘"), ("하늘이라고 해 줘", "하늘"),
    ("건너뛰기", None), ("건너뛸게", None), ("싫어", None), ("없어", None), ("안 할래", None), ("", None), ("가" * 25, None),
])
def test_call_name_from(said, name):
    assert call_name_from(said) == name


def test_every_line_and_intro_line_has_four_languages():
    assert set(LINES) == {"mic", "mic-heard", "mic-none", "name", "name-confirm", "name-shared",
                          "stop-practice", "stop-praise", "practice-offer", "practice-no"}
    for key, texts in LINES.items():
        assert set(texts) == LANGS and all(t.strip() for t in texts.values()), key
    assert len(INTRO) == 7 and set(INTRO_NONAME) == LANGS
    for pose, texts in INTRO:
        assert set(texts) == LANGS, pose
    assert all("{name}" in t for t in INTRO[0][1].values())
    assert LINES["mic"]["ko"] == "이제 제가 들어 볼게요. 말하기 단축키 Ctrl, Shift, 스페이스를 누르고 '안녕하세요'라고 말해 보세요."


def test_intro_poses_exist_in_the_avatar_model():
    raw = GLB.read_bytes()
    size = struct.unpack("<I", raw[12:16])[0]
    clips = {a["name"] for a in json.loads(raw[20:20 + size])["animations"]}
    poses = [pose for pose, _ in INTRO]
    assert poses == ["welcome", "listening", "screen-reading", "confirmation", "auth-handoff", "stopped", "complete"]
    assert set(poses) <= clips


def test_first_run_slot_is_pending_and_cleared_by_stop():
    d = DialogueState("IDLE")
    d.ask_first_run("name")
    assert d.first_run == "name" and d.has_pending_interaction
    d.stop()
    assert d.first_run is None


def test_end_first_run_clears_the_slot():
    d = DialogueState("IDLE")
    d.ask_first_run("practice")
    d.end_first_run()
    assert d.first_run is None and not d.has_pending_interaction


def test_intro_draft_is_a_valid_turn_result_and_replay_has_no_offer():
    from cheongeum.core.turn import IntroLine
    from cheongeum.orchestrator.first_run import FirstRunGuide

    d = DialogueState("IDLE")
    seen = []
    guide = FirstRunGuide(d, step=None, progress=seen.append, lang=lambda: "ko", call_name=lambda: None,
                          remember=lambda name: True, is_command=lambda text: False)
    replay = guide.intro_draft(replay=True)
    lines = [IntroLine.model_validate(line) for line in replay["introScript"]]
    assert len(lines) == 7 and lines[0].text == INTRO_NONAME["ko"] and not any(line.ask for line in lines)
    assert d.first_run is None and seen == []
    first = guide.intro_draft()
    assert len(first["introScript"]) == 8 and first["introScript"][-1]["ask"] is True
    assert d.first_run == "practice" and seen == ["practice"]
