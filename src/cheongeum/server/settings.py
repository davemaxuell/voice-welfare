"""이용 설정은 PC에 원자적으로 저장하고, 직접 입력한 키만 OS 자격 증명 키로 봉인한다."""
from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from cheongeum.core.region import province_name
from cheongeum.personal.seal import Seal
from cheongeum.understanding.sites import KNOWN_SITES
from cheongeum.voice.config import DEFAULT_SPEED


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    language: Literal["ko", "en", "zh", "ja"] = "ko"
    region: str = Field(default="", max_length=20)
    speed: float = Field(default=DEFAULT_SPEED, ge=0.75, le=2)
    rememberService: bool = False
    deviceUse: Literal["unidentified", "personal", "shared"] = "unidentified"
    # 평소 쓰는 크롬(로그인 유지) 또는 따로 쓰는 브라우저. 개인 PC에서만 크롬을 고를 수 있다.
    browser: Literal["separate", "chrome"] = "separate"

    @field_validator("region")
    @classmethod
    def region_name(cls, value: str) -> str:
        if value and not province_name(value):
            raise ValueError("시·도를 선택해 주세요.")
        return province_name(value)


# 첫 실행 설정을 어디까지 했는지. stage2 = 키를 저장한 뒤 소리 확인부터, 그 뒤는 동의 뒤 음성 단계, done = 끝.
FIRST_RUN_STEPS = ("stage2", "mic", "name", "stop", "intro", "practice", "done")


class SettingsInput(Preferences):
    apiKey: SecretStr = Field(default_factory=lambda: SecretStr(""))

    @field_validator("apiKey")
    @classmethod
    def key_format(cls, secret: SecretStr) -> SecretStr:
        key = secret.get_secret_value().strip()
        if key and (len(key) > 512 or not key.isascii() or not key.isprintable() or " " in key):
            raise ValueError("API 키를 확인해 주세요.")
        return SecretStr(key)


class SettingsStore:
    def __init__(self, path: Path, seal_factory=Seal):
        self.path = path
        self.seal_factory = seal_factory
        self.preferences = Preferences()
        self.key = ""
        self._credential = ""
        self.last_service: tuple[str, str] | None = None
        self.completed = False
        self.load_error = False
        # 파일이 없으면 1단계를 저장한 뒤 이어 갈 곳. 이 기능 전에 만든 파일은 이미 끝난 것으로 본다.
        self.first_run = "stage2"
        try:
            data = json.loads(path.read_bytes())
            self.preferences = Preferences.model_validate(data["preferences"])
            if data["credential"]:
                self.key = self.seal_factory().open(base64.b64decode(data["credential"], validate=True)).decode("ascii")
            self._credential = data["credential"]
            step = data.get("firstRun", "done")
            self.first_run = step if step in FIRST_RUN_STEPS else "done"
            saved = data.get("lastService")
            if self.preferences.deviceUse == "personal" and self.preferences.rememberService and isinstance(saved, list) and len(saved) == 2:
                if any(s.label == saved[0] and (saved[1] == "" or saved[1] in s.services) for s in KNOWN_SITES):
                    self.last_service = (saved[0], saved[1])
            self.completed = True
        except FileNotFoundError:
            pass
        except Exception:
            # 자격 증명이 사라졌을 때에도 새 키를 입력할 수 있게 한다.
            self.load_error = True

    def save(self, values: SettingsInput) -> None:
        prefs = Preferences.model_validate(values.model_dump(exclude={"apiKey"}))
        if prefs.deviceUse != "personal":
            prefs = prefs.model_copy(update={"rememberService": False, "browser": "separate"})
        key = values.apiKey.get_secret_value() or self.key
        credential = base64.b64encode(self.seal_factory().seal(key.encode("ascii"))).decode("ascii") if key else ""
        last_service = self.last_service if prefs.rememberService else None
        self._write(prefs, credential, last_service, self.first_run)
        self.preferences, self.key, self.completed, self.load_error = prefs, key, True, False
        self._credential, self.last_service = credential, last_service

    def remember_service(self, agency: str, topic: str) -> None:
        if self.preferences.deviceUse != "personal" or not self.preferences.rememberService or self.last_service == (agency, topic):
            return
        if not any(s.label == agency and (not topic or topic in s.services) for s in KNOWN_SITES):
            return
        self._write(self.preferences, self._credential, (agency, topic), self.first_run)
        self.last_service = (agency, topic)

    def set_first_run(self, step: str) -> None:
        """첫 실행 설정을 어디까지 했는지 적는다(앱을 닫았다 열면 그 단계부터 한 번 이어 간다)."""
        if step not in FIRST_RUN_STEPS:
            raise ValueError(step)
        self._write(self.preferences, self._credential, self.last_service, step)
        self.first_run = step

    def _write(self, prefs: Preferences, credential: str, last_service: tuple[str, str] | None, first_run: str) -> None:
        payload = json.dumps({"preferences": prefs.model_dump(), "credential": credential, "lastService": last_service,
                              "firstRun": first_run}, ensure_ascii=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        f = tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.path.parent, delete=False)
        tmp = Path(f.name)
        try:
            with f:
                f.write(payload)
            os.replace(tmp, self.path)
        finally:
            tmp.unlink(missing_ok=True)

    def claim_startup_guide(self) -> bool | None:
        """새 창이나 다음날 켠 앱도 한 사용자 설정에서 최초 한 번만 자동 안내한다."""
        try:
            self.path.with_name("startup-guide-seen").touch(exist_ok=False)
        except FileExistsError:
            return False
        except OSError:
            return None  # 저장소가 읽기 전용이면 화면의 로컬 기록으로 결정한다.
        return True
