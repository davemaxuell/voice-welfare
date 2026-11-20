"""화면 사진(Picture)은 가린 뒤에만 생기고, 만드는 곳은 화면을 가리고 찍는 코드뿐이다."""
import ast
import base64
from pathlib import Path

import pytest

from cheongeum.core.picture import PICTURE_SCHEMA, MaskReport, Picture, png_size

SRC = Path(__file__).resolve().parents[2] / "src" / "cheongeum"
# 사진을 만들어도 되는 곳. 뒤의 것은 앱 창 사진이 들어올 자리다.
SEALERS = {"agents/web/browser/__init__.py", "agents/desktop/capture.py"}

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
MASKS = MaskReport(inputs=2, frames=1, blocks=0, cursorHidden=True)


def sealing_lines(source: str) -> list[int]:
    """Picture를 만드는 코드가 있는 줄: _sealed를 부르거나 이름으로 꺼내는 곳, Picture를 __new__로 직접 만드는 곳."""
    lines = []
    for node in ast.walk(ast.parse(source)):
        named = (
            (isinstance(node, ast.Attribute) and node.attr == "_sealed")
            or (isinstance(node, ast.Name) and node.id == "_sealed")
            or (isinstance(node, ast.Constant) and node.value == "_sealed")
        )
        raw_new = (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "__new__"
            and any("Picture" in ast.unparse(a) for a in node.args)
        )
        if named or raw_new:
            lines.append(node.lineno)
    return lines


def test_picture_cannot_be_constructed_directly():
    with pytest.raises(TypeError):
        Picture()
    with pytest.raises(TypeError):
        Picture(PNG, source="web", width=1, height=1, masks=MASKS)


def test_sealing_needs_a_mask_report_and_a_png():
    with pytest.raises(TypeError):
        Picture._sealed(PNG, source="web", width=1, height=1, masks=None)
    with pytest.raises(ValueError):
        Picture._sealed(b"GIF89a not a png at all.....", source="web", width=1, height=1, masks=MASKS)


def test_sealed_picture_shows_facts_but_not_bytes():
    picture = Picture._sealed(PNG, source="web", width=1, height=1, masks=MASKS)
    assert (picture.source, picture.width, picture.height, picture.masks) == ("web", 1, 1, MASKS)
    public = [getattr(picture, name) for name in dir(picture) if not name.startswith("_") and name != "data_url"]
    assert not any(isinstance(value, (bytes, bytearray, memoryview)) for value in public)
    assert "iVBOR" not in repr(picture)
    with pytest.raises(AttributeError):
        picture.masks = MaskReport(0, 0, 0, False)


def test_data_url_carries_the_png():
    url = Picture._sealed(PNG, source="app", width=1, height=1, masks=MASKS).data_url()
    head, _, body = url.partition(",")
    assert head == "data:image/png;base64"
    assert base64.b64decode(body) == PNG


def test_png_size_reads_the_header():
    assert png_size(PNG) == (1, 1)
    with pytest.raises(ValueError):
        png_size(b"")


def test_scan_sees_every_way_of_sealing():
    assert sealing_lines("p = Picture._sealed(png, source='web', width=1, height=1, masks=m)") == [1]
    assert sealing_lines("from cheongeum.core.picture import Picture\nmake = getattr(Picture, '_sealed')") == [2]
    assert sealing_lines("p = object.__new__(Picture)") == [1]
    assert sealing_lines("p = picture.data_url()") == []


def test_only_capture_code_seals_pictures():
    found = {}
    for path in sorted(SRC.rglob("*.py")):
        lines = sealing_lines(path.read_text(encoding="utf-8"))
        if lines:
            found[path.relative_to(SRC).as_posix()] = lines
    assert "agents/web/browser/__init__.py" in found, "웹 화면 찍기가 Picture._sealed를 쓰지 않습니다"
    outside = {name: lines for name, lines in found.items() if name not in SEALERS}
    assert not outside, f"가리고 찍는 코드 밖에서 Picture를 만듭니다: {outside}"


def test_answer_schema_is_strict_and_has_no_room_for_actions():
    assert PICTURE_SCHEMA["additionalProperties"] is False
    assert set(PICTURE_SCHEMA["required"]) == set(PICTURE_SCHEMA["properties"]) == {"screen", "description", "pressable"}
    assert PICTURE_SCHEMA["properties"]["pressable"] == {"type": "array", "items": {"type": "integer"}}
