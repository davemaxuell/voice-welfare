"""브라우저 다운로드를 사용자 폴더에 두고, 읽어 달라고 하면 PDF·HWPX 글을 돌려준다."""
from __future__ import annotations

import time
from pathlib import Path

from cheongeum.agents.web.docs import read_document
from cheongeum.speech.phrasing import chunk_text


class DownloadStore:
    def __init__(self, folder: str | None = None) -> None:
        self.folder = Path(folder) if folder else None
        self._files: list[dict] = []  # {name, path, at}
        if self.folder:
            self.folder.mkdir(parents=True, exist_ok=True)

    def remember(self, path: str | Path, name: str | None = None) -> dict:
        p = Path(path)
        rec = {"name": name or p.name, "path": str(p), "at": time.time()}
        self._files.append(rec)
        return rec

    def latest(self) -> dict | None:
        return self._files[-1] if self._files else None

    def list_names(self) -> list[str]:
        return [f["name"] for f in self._files]

    def speak_list(self) -> str:
        names = self.list_names()
        if not names:
            return "받은 파일이 없어요."
        return f"받은 파일은 {len(names)}개예요. " + ", ".join(names[-5:]) + (" 등이에요." if len(names) > 5 else "이에요.")

    def read_latest(self, *, max_chars: int = 1200) -> str:
        last = self.latest()
        if not last:
            return "받은 파일이 없어요. 사이트에서 파일을 받은 뒤 다시 말씀해 주세요."
        out = read_document(last["path"], max_chars=max_chars * 4)
        if not out.get("ok"):
            return out["speech"]
        head = chunk_text(out["text"], 0, max_chars)
        more = " 이어서 들으려면 '받은 파일 더 읽어줘'라고 하세요." if len(out["text"]) > max_chars else ""
        return f"'{last['name']}'을 읽어요. {head}{more}"
