"""
사용자 본인의 정보(기능 4: 개인 정보 금고)와 신청 기록(기능 5: 신청 후 추적)을 두는 곳.
- 사용자가 말해서 저장을 확인한 것만 이 컴퓨터에 둔다(파일 권한 600). 경로가 없으면 이번 대화(메모리)에서만.
- 비밀번호·주민등록번호·계좌·카드번호는 저장하지 않는다(처리 전에 이미 가려지고, 여기서도 거부).
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from ieum.core.jsutil import jdumps, rx

VAULT_KEYS = ("name", "address", "phone", "email", "birth")
VAULT_LABELS = {"name": "이름", "address": "주소", "phone": "연락처", "email": "이메일", "birth": "생년월일"}


class PersonalStore:
    """파일(있으면) 또는 메모리에 둔다. 신청 기록 = {id, service, appliedAt, receiptNo?, dueDate?, dueNote?, done?}"""

    def __init__(self, path: str | None = None) -> None:
        self.path = path
        self._data: dict = {"vault": {}, "applications": []}
        if path and os.path.exists(path):
            try:
                raw = json.loads(Path(path).read_text(encoding="utf-8"))
                self._data = {"vault": raw.get("vault") or {}, "applications": raw.get("applications") or []}
            except (OSError, ValueError, AttributeError):
                pass  # 깨진 파일은 무시하고 새로 시작(덮어쓰기 전까지 원본은 그대로)

    @property
    def persistent(self) -> bool:
        return bool(self.path)

    def vault(self) -> dict:
        return dict(self._data["vault"])

    def save_vault(self, values: dict) -> None:
        self._data["vault"] = {**self._data["vault"], **values}
        self._flush()

    def clear_vault(self) -> None:
        self._data["vault"] = {}
        self._flush()

    def applications(self) -> list[dict]:
        return [dict(a) for a in self._data["applications"]]

    def add_application(self, rec: dict) -> dict:
        full = {**{k: v for k, v in rec.items() if v is not None}, "id": str(int(time.time() * 1000))}
        self._data["applications"].append(full)
        self._flush()
        return full

    def update_application(self, id_: str, patch: dict) -> None:
        self._data["applications"] = [{**a, **patch} if a["id"] == id_ else a for a in self._data["applications"]]
        self._flush()

    def _flush(self) -> None:
        if not self.path:
            return
        p = Path(self.path)
        p.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(jdumps(self._data, indent=2))
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass  # 윈도 등


SECRET = rx(r"(비밀\s*번호|패스워드|주민|계좌|카드\s*번호|인증\s*번호|\[비공개\])")
