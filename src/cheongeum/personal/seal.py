"""
이 컴퓨터에만 두는 파일 암호화: AES-GCM, 키는 OS 자격 증명 저장소(keyring).
금고(item 11)·행동 기록(item 10)이 같은 키를 쓴다. 키를 잃으면(OS 프로필 삭제) 복호화할 수 없다.
"""
from __future__ import annotations

import os
from typing import Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SERVICE = "cheongeum-voice-welfare"
KEY_NAME = "data-key"
MAGIC = b"CE1\0"
NONCE_LEN = 12


class KeyStore(Protocol):
    def get_password(self, service: str, username: str) -> str | None: ...
    def set_password(self, service: str, username: str, password: str) -> None: ...


class Seal:
    """키 32바이트로 AES-GCM 봉인. key=를 주면 keyring을 쓰지 않는다(시험용)."""

    def __init__(self, key: bytes | None = None, store: KeyStore | None = None) -> None:
        if key is not None:
            if len(key) != 32:
                raise ValueError("key must be 32 bytes")
            self._key = key
            return
        self._key = self._load_or_create(store)

    @staticmethod
    def _load_or_create(store: KeyStore | None) -> bytes:
        import keyring

        kr: KeyStore = store or keyring
        raw = kr.get_password(SERVICE, KEY_NAME)
        if raw:
            return bytes.fromhex(raw)
        key = os.urandom(32)
        kr.set_password(SERVICE, KEY_NAME, key.hex())
        return key

    def seal(self, plain: bytes) -> bytes:
        nonce = os.urandom(NONCE_LEN)
        ct = AESGCM(self._key).encrypt(nonce, plain, None)
        return MAGIC + nonce + ct

    def open(self, blob: bytes) -> bytes:
        if not blob.startswith(MAGIC):
            raise ValueError("not a cheongeum sealed blob")
        nonce = blob[len(MAGIC) : len(MAGIC) + NONCE_LEN]
        ct = blob[len(MAGIC) + NONCE_LEN :]
        return AESGCM(self._key).decrypt(nonce, ct, None)

    def is_sealed(self, blob: bytes) -> bool:
        return blob.startswith(MAGIC)
