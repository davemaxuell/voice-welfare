"""받은 파일에서 읽어 줄 글 뽑기: PDF·HWPX. 옛 HWP 바이너리는 못 읽는다."""
from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

from cheongeum.core.jsutil import rx


class DocumentLimit(ValueError):
    """사용자에게 읽어 줄 파일 한도 안내."""


def read_document(path: str | Path, *, name: str | None = None, max_chars: int = 8000) -> dict:
    """
    → {ok, kind, text?, speech}
    kind: pdf|hwpx|hwp|other
    """
    p = Path(path)
    if not p.is_file():
        return {"ok": False, "kind": "other", "speech": "그 파일을 찾지 못했어요."}
    name = name or p.name
    suf = Path(name).suffix.lower()
    if suf == ".hwp":
        return {
            "ok": False,
            "kind": "hwp",
            "speech": f"'{name}'은 예전 한글 파일(HWP)이라 글자를 뽑지 못해요. HWPX나 PDF로 받아 주세요.",
        }
    if suf not in (".pdf", ".hwpx"):
        return {"ok": False, "kind": "other", "speech": f"'{name}'의 원문은 읽어 드리기 어려워요. 원문 읽기는 PDF나 HWPX만 돼요."}
    kind = suf[1:]
    try:
        text = pdf_text(p) if kind == "pdf" else hwpx_text(p)
    except DocumentLimit as exc:
        return {"ok": False, "kind": kind, "speech": str(exc)}
    except Exception:
        return {"ok": False, "kind": kind, "speech": "파일을 열지 못했어요. 손상되었거나 암호가 걸려 있을 수 있어요."}
    if not text or not text.strip():
        return {"ok": False, "kind": kind, "speech": f"'{name}'에서 글을 찾지 못했어요."}
    clipped = text.strip()[:max_chars]
    return {"ok": True, "kind": kind, "text": clipped, "speech": clipped}


def pdf_text(source: Path | BytesIO, *, max_pages: int | None = None) -> str:
    from pypdf import PdfReader

    reader = PdfReader(source)
    if max_pages is not None and len(reader.pages) > max_pages:
        raise DocumentLimit(f"PDF는 한 번에 {max_pages}쪽까지 요약할 수 있어요. 필요한 부분을 나누어 받아 주세요.")
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return rx(r"[ \t]+\n").sub("\n", "\n".join(parts))


def hwpx_text(path: Path | BytesIO) -> str:
    """HWPX = ZIP + XML. 본문 칸의 글만 이어 붙인다."""
    parts: list[str] = []
    with zipfile.ZipFile(path) as z:
        if sum(info.file_size for info in z.infolist() if info.filename.lower().endswith(".xml")) > 16_000_000:
            raise DocumentLimit("HWPX의 본문이 너무 커서 읽지 못했어요. 필요한 부분을 나누어 받아 주세요.")
        names = [n for n in z.namelist() if "section" in n.lower() and n.lower().endswith(".xml")]
        if not names:
            names = [n for n in z.namelist() if n.lower().endswith(".xml") and "content" in n.lower()]
        for name in sorted(names):
            raw = z.read(name)
            try:
                root = ET.fromstring(raw)
            except ET.ParseError:
                continue
            for el in root.iter():
                tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
                if tag in ("t", "T", "char", "Char") and el.text:
                    parts.append(el.text)
                elif tag.lower() in ("hp:t".split(":")[-1],) and el.text:
                    parts.append(el.text)
    # 네임스페이스 없는 t / 흔한 HWPX 텍스트 노드
    text = "".join(parts)
    if not text:
        # 모든 잎 글
        with zipfile.ZipFile(path) as z:
            for name in z.namelist():
                if not name.lower().endswith(".xml"):
                    continue
                try:
                    root = ET.fromstring(z.read(name))
                except ET.ParseError:
                    continue
                for el in root.iter():
                    if el.text and el.text.strip():
                        tag = el.tag.split("}")[-1]
                        if len(tag) <= 3 or tag.lower() in ("t", "text", "char"):
                            parts.append(el.text)
        text = "".join(parts)
    return rx(r"\s+").sub(" ", text).strip()
