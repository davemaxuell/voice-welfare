"""
사용자 본인의 정보(기능 4: 개인 정보 금고)와 신청 기록(기능 5: 신청 후 추적)을 두는 곳.
- 사용자가 말해서 저장을 확인한 것만 이 컴퓨터에 둔다(파일 권한 600, Seal이 있으면 AES-GCM). 경로가 없으면 이번 대화(메모리)에서만.
- 비밀번호·주민등록번호·계좌·카드번호는 저장하지 않는다(처리 전에 이미 가려지고, 여기서도 거부).
- OS 자격 증명 키를 잃으면(프로필 삭제) 금고를 열 수 없다.
"""
from __future__ import annotations

import json
import os
from uuid import uuid4
from pathlib import Path
from typing import TYPE_CHECKING

from cheongeum.core.jsutil import jdumps, rx
from cheongeum.personal.atomic import write_private

if TYPE_CHECKING:
    from cheongeum.personal.seal import Seal

VAULT_KEYS = ("name", "address", "phone", "email", "birth")
MOBILE = rx(r"(?:010[0-9]{8}|01[16789][0-9]{7,8})")
VAULT_LABELS = {"name": "이름", "address": "주소", "phone": "연락처", "email": "이메일", "birth": "생년월일"}

# 말하기 설정(기본값). 금고 파일의 speech에 두고, 음성 명령으로만 바꾼다.
DEFAULT_SPEECH = {"rate": 1.25, "length": "normal", "voice": None, "progressSpoken": True}
SPEECH_LABELS = {"rate": "말하는 속도", "length": "답 길이", "voice": "목소리", "progressSpoken": "진행 상황 알림"}


class PersonalStore:
    """파일(있으면) 또는 메모리에 둔다. 신청 기록 = {id, service, appliedAt, receiptNo?, dueDate?, dueNote?, done?}"""

    def __init__(self, path: str | None = None, seal: Seal | None = None) -> None:
        self.path = path
        self._seal = seal
        self._data: dict = {"vault": {}, "applications": [], "speech": dict(DEFAULT_SPEECH), "siteAllow": {}}
        if path and os.path.exists(path):
            try:
                raw_bytes = Path(path).read_bytes()
                if seal and seal.is_sealed(raw_bytes):
                    text = seal.open(raw_bytes).decode("utf-8")
                else:
                    text = raw_bytes.decode("utf-8")
                raw = json.loads(text)
                speech = {**DEFAULT_SPEECH, **(raw.get("speech") or {})}
                self._data = {
                    "vault": raw.get("vault") or {},
                    "guardian": raw.get("guardian"),
                    "callName": raw.get("callName"),
                    "applications": raw.get("applications") or [],
                    "speech": speech,
                    "siteAllow": dict(raw.get("siteAllow") or {}),
                }
                # 평문 파일이고 Seal이 있으면 다음 저장부터 봉인(첫 로드 직후 한 번 옮겨 적음)
                if seal and not seal.is_sealed(raw_bytes):
                    self._save()
            except (OSError, ValueError, AttributeError, UnicodeError):
                pass  # 깨진 파일은 무시하고 새로 시작(덮어쓰기 전까지 원본은 그대로)

    @property
    def persistent(self) -> bool:
        return bool(self.path)

    def vault(self) -> dict:
        return dict(self._data["vault"])

    def save_vault(self, values: dict) -> None:
        self._save(vault={**self._data["vault"], **values})

    def clear_vault(self) -> None:
        self._save(vault={}, guardian=None, callName=None)

    def call_name(self) -> str | None:
        """청음이 사용자를 부르는 이름(첫 실행에서 물음). 금고의 법적 이름(name)과 따로 둔다."""
        name = self._data.get("callName")
        return name if isinstance(name, str) and name else None

    def set_call_name(self, name: str | None) -> None:
        self._save(callName=name or None)

    def guardian(self) -> dict | None:
        contact = self._data.get("guardian")
        if not isinstance(contact, dict) or not isinstance(contact.get("name"), str) or not contact["name"]:
            return None
        phone = contact.get("phone")
        if not isinstance(phone, str) or not MOBILE.fullmatch(phone):
            return None
        return {"name": contact["name"], "phone": phone}

    def set_guardian(self, contact: dict | None) -> None:
        self._save(guardian=dict(contact) if contact else None)

    def speech(self) -> dict:
        return {**DEFAULT_SPEECH, **(self._data.get("speech") or {})}

    def save_speech(self, patch: dict) -> dict:
        """말하는 속도·답 길이·목소리·진행 알림. None은 기본 목소리로 되돌림."""
        cur = self.speech()
        for k, v in patch.items():
            if k in DEFAULT_SPEECH:
                cur[k] = v
        self._save(speech=cur)
        return dict(cur)

    def clear_speech(self) -> dict:
        self._save(speech=dict(DEFAULT_SPEECH))
        return self.speech()

    def site_allowed(self, origin: str) -> bool:
        return bool((self._data.get("siteAllow") or {}).get(origin))

    def allow_site(self, origin: str) -> None:
        self._save(siteAllow={**self._data.get("siteAllow", {}), origin: True})

    def revoke_site(self, origin: str | None = None) -> None:
        """origin이 없으면 사이트 허용을 모두 지운다."""
        self._save(siteAllow={o: ok for o, ok in self._data.get("siteAllow", {}).items() if origin and o != origin})

    def allowed_sites(self) -> list[str]:
        return [o for o, ok in (self._data.get("siteAllow") or {}).items() if ok]

    def applications(self) -> list[dict]:
        return [dict(a) for a in self._data["applications"]]

    def add_application(self, rec: dict) -> dict:
        full = {**{k: v for k, v in rec.items() if v is not None}, "id": str(uuid4())}
        self._save(applications=[*self._data["applications"], full])
        return full

    def update_application(self, id_: str, patch: dict) -> None:
        self._save(applications=[{**a, **patch} if a["id"] == id_ else a for a in self._data["applications"]])

    def _save(self, **updates) -> None:
        data = {**self._data, **updates}
        if self.path:
            payload = jdumps(data, indent=2).encode("utf-8")
            write_private(Path(self.path), self._seal.seal(payload) if self._seal else payload)
        self._data = data


SECRET = rx(r"(비밀\s*번호|패스워드|주민|계좌|카드\s*번호|인증\s*번호|\[비공개\])")
