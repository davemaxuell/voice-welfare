"""PDF·HWPX 글 뽑기."""
from __future__ import annotations

import zipfile

import pytest

from cheongeum.agents.web.docs import read_document
from cheongeum.agents.web.downloads import DownloadStore
from cheongeum.core.dialogue import DialogueState
from cheongeum.understanding.rules import IntentContext, RuleBasedIntentProvider


def test_read_hwp_refused(tmp_path):
    p = tmp_path / "a.hwp"
    p.write_bytes(b"old-hwp")
    out = read_document(p)
    assert out["ok"] is False
    assert out["kind"] == "hwp"
    assert "HWPX" in out["speech"]


def test_read_hwpx(tmp_path):
    p = tmp_path / "a.hwpx"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr(
            "Contents/section0.xml",
            '<?xml version="1.0"?><root xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">'
            "<hp:t>장애인</hp:t><hp:t>연금</hp:t></root>",
        )
    out = read_document(p)
    assert out["ok"] is True
    assert "장애인" in out["text"] and "연금" in out["text"]


def test_read_pdf_kind(tmp_path):
    from pypdf import PdfWriter

    path = tmp_path / "b.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with path.open("wb") as f:
        writer.write(f)
    out = read_document(path)
    assert out["kind"] == "pdf"


def test_download_store_read(tmp_path):
    store = DownloadStore(str(tmp_path))
    p = tmp_path / "x.hwpx"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("Contents/section0.xml", '<?xml version="1.0"?><r><t>안내문</t></r>')
    store.remember(p)
    speech = store.read_latest()
    assert "안내문" in speech


@pytest.mark.asyncio
async def test_parse_read_download():
    r = RuleBasedIntentProvider([])
    assert (await r.parse("받은 파일 읽어줘", IntentContext(state="IDLE")))["type"] == "READ_DOWNLOAD"
    listed = await r.parse("받은 파일 목록", IntentContext(state="IDLE"))
    assert listed["type"] == "READ_DOWNLOAD" and listed.get("list")


@pytest.mark.parametrize("text", ["이미지 검색해줘", "이 페이지에 어떤 사진이 있어?", "화면의 이미지를 설명해줘"])
def test_screen_and_search_requests_do_not_read_downloads(text):
    parser = RuleBasedIntentProvider([])
    assert parser.parse_sync(text, IntentContext(state="BROWSING"))["type"] != "READ_DOWNLOAD"


def test_download_verbatim_can_continue_past_first_chunk(tmp_path):
    path = tmp_path / "안내.hwpx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("Contents/section0.xml", "<r><t>첫째 부분. 마지막 부분.</t></r>")
    store = DownloadStore()
    store.remember(path)
    assert "마지막" not in store.read_latest(max_chars=8)
    assert "마지막" in store.read_latest(max_chars=8, more=True)
    assert "끝까지" in store.read_latest(max_chars=8, more=True)
