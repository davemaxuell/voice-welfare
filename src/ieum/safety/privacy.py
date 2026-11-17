"""민감정보 탐지·비식별화."""
from __future__ import annotations

from dataclasses import dataclass, field

from ieum.core.jsutil import I, rx

SENSITIVE_LABELS_KO: dict[str, str] = {
    "password": "비밀번호",
    "otp": "인증번호",
    "rrn": "주민등록번호",
    "account": "계좌번호",
    "card": "카드번호",
    "health": "건강정보",
}

REDACTED = "[비공개]"

KEYWORDS = [
    ("password", rx(r"(비밀\s*번호|비번|패스\s*워드|password|암호)", I)),
    ("otp", rx(r"(OTP|일회용\s*(비밀)?\s*번호|인증\s*번호|보안\s*코드)", I)),
    ("rrn", rx(r"(주민\s*(등록)?\s*번호|외국인\s*등록\s*번호)")),
    ("account", rx(r"(계좌\s*(번호)?)")),
    ("card", rx(r"(카드\s*번호)")),
    ("health", rx(r"(진단명|병명|질병명|병력|처방\s*내역)")),
]

VALUE_PATTERNS = [
    ("rrn", rx(r"\d{6}\s*-\s*[1-8]\d{6}|(?<!\d)\d{6}[1-8]\d{6}(?!\d)")),
    ("card", rx(r"(?<!\d)(?:\d{4}[- ]){3}\d{4}(?!\d)")),
]


def _has_value_after(kind: str, after: str) -> bool:
    if kind == "health":
        return len(rx(r"[은는이가:\s]").sub("", after)) >= 2 and not rx(r"(뜻|의미|뭐)").search(after)
    return bool(rx(r"\d").search(after) or rx(r"[A-Za-z]{4,}").search(after))


@dataclass
class SensitiveDetection:
    kinds: list[str] = field(default_factory=list)
    # 키워드 뒤에 실제 값으로 보이는 내용이 있거나, 값 패턴(주민번호 등)이 직접 등장
    hasSecretValue: bool = False


def detect_sensitive(text: str) -> SensitiveDetection:
    kinds: dict[str, None] = {}
    secret = False
    for kind, pattern in KEYWORDS:
        m = pattern.search(text)
        if not m:
            continue
        kinds[kind] = None
        if _has_value_after(kind, text[m.end() :]):
            secret = True
    for kind, pattern in VALUE_PATTERNS:
        if pattern.search(text):
            kinds[kind] = None
            secret = True
    return SensitiveDetection(kinds=list(kinds), hasSecretValue=secret)


def redact_text(text: str) -> str:
    """저장·로그·모델 입력 전에 반드시 거치는 비식별화. 민감 키워드 뒤의 값은 통째로 가린다."""
    out = text
    for _, pattern in VALUE_PATTERNS:
        out = pattern.sub(REDACTED, out)
    for kind, pattern in KEYWORDS:
        m = pattern.search(out)
        if not m:
            continue
        end = m.end()
        if _has_value_after(kind, out[end:]):
            out = f"{out[:end]} {REDACTED}"
    return out


def mask_value(value: str) -> str:
    """전화번호 등 개인정보를 읽어줄 때의 마스킹 (예: 010-****-5678)."""
    digits = rx(r"\D").sub("", value)
    if len(digits) >= 9:
        return f"{digits[:3]}-****-{digits[-4:]}"
    if len(value) <= 2:
        return "*" * len(value)
    return f"{value[0]}{'*' * (len(value) - 2)}{value[-1]}"
