"""키를 넣기 전(1단계)에는 녹음해 둔 문장을 튼다. 화면 글과 녹음 글이 같은 목록(manifest)에서 나온다."""
import json
from pathlib import Path

AUDIO = Path(__file__).resolve().parents[2] / "src" / "cheongeum" / "web" / "static" / "setup-audio"
MANIFEST = json.loads((AUDIO / "manifest.json").read_text(encoding="utf-8"))
LANGS = {"ko", "en", "zh", "ja"}


def test_every_manifest_entry_has_a_clip_for_each_of_its_languages():
    for clip_id, texts in MANIFEST.items():
        for lang, text in texts.items():
            path = AUDIO / lang / f"{clip_id}.mp3"
            assert text.strip() and path.is_file() and path.stat().st_size > 0, (clip_id, lang)


def test_shared_steps_exist_in_all_four_languages_and_language_options_in_their_own():
    for clip_id, texts in MANIFEST.items():
        if clip_id.startswith("lang-"):
            assert set(texts) == {clip_id.removeprefix("lang-")}, clip_id
        else:
            assert set(texts) == LANGS, clip_id


def test_stage1_has_every_step_the_wizard_plays():
    want = {"lang-ko", "lang-en", "lang-zh", "lang-ja", "who", "key-alone", "key-checking", "key-invalid",
            "key-quota", "key-network", "pc", "handover"}
    assert want <= set(MANIFEST)
    assert MANIFEST["who"]["ko"] == "지금 누가 설정하고 계세요? 사용하실 분 본인이면 1번, 가족이나 복지관 직원이면 2번."
