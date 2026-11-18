"""
민감정보 탐지·비식별화.
규칙(정규식)이 기본이고, 로컬 개인정보 인식 모델(set_pii_model)이 있으면 함께 본다: 둘 중 하나라도 걸리면 민감.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Protocol

from cheongeum.core.jsutil import B, I, rx

log = logging.getLogger("cheongeum.privacy")

SENSITIVE_LABELS_KO: dict[str, str] = {
    "password": "비밀번호",
    "otp": "인증번호",
    "rrn": "주민등록번호",
    "account": "계좌번호",
    "card": "카드번호",
    "idnum": "신분증 번호",
    "health": "건강정보",
}

REDACTED = "[비공개]"

# (종류, 키워드, 엄격) — 엄격이면 키워드 뒤에 "그것에 대한 말"이 아닌 내용이 오면 값으로 본다(한국어 비밀번호·인증번호).
# 엄격하지 않으면 숫자·영문 4자 이상·한글로 읽은 숫자가 뒤따를 때만 값으로 본다.
KEYWORDS = [
    ("password", rx(r"(비밀\s*번호|비번|패스\s*워드|암호(?!화)|핀\s*번호)"), True),
    ("password", rx(rf"(password|passcode|密码|密碼|パスワード|暗証番号|{B}PIN{B})", I), False),
    ("otp", rx(r"(OTP|일회용\s*(비밀)?\s*번호|인증\s*번호|보안\s*코드)", I), True),
    ("otp", rx(r"(验证码|驗證碼|認証コード|確認コード|verification\s*code|one[-\s]?time\s*(pass(word|code)?|code))", I), False),
    ("rrn", rx(r"(주민\s*(등록)?\s*번호|외국인\s*등록\s*번호)"), False),
    ("account", rx(r"(계좌\s*(번호)?)"), False),
    ("card", rx(r"(카드\s*번호)"), False),
    ("idnum", rx(r"(여권\s*번호|운전\s*면허\s*(증\s*)?번호)"), False),
    ("health", rx(r"(진단명|병명|질병명|병력|처방\s*내역)"), False),
]

VALUE_PATTERNS = [
    ("rrn", rx(r"\d{6}\s*-\s*[1-8]\d{6}|(?<!\d)\d{6}[1-8]\d{6}(?!\d)")),
    ("card", rx(r"(?<!\d)(?:\d{4}[- ]){3}\d{4}(?!\d)")),
]

# 한글로 읽은 숫자("공일공 일이삼사"): 4음절 이상 이어질 때만(“이사”, “오이” 같은 낱말은 제외). 판정에만 쓰고 원문은 바꾸지 않는다.
_DIGIT_WORDS = "공영일이삼사오육륙칠팔구"
_SPOKEN_RUN = rx(rf"[{_DIGIT_WORDS}](?:[ \-]?[{_DIGIT_WORDS}]){{3,}}")
_SPOKEN_MAP = str.maketrans(_DIGIT_WORDS, "001234566789")

# 키워드 바로 뒤의 조사·문장부호(“비밀번호는 …”, “비밀번호요?”)
_LEAD = rx(r"^(?:은|는|이|가|을|를|도|의|란|이란|요)?[\s:：,.、~!?\-]*")
# 비밀번호를 "말하는" 게 아니라 "그것에 대해" 말하는 첫 낱말(“칸이 어디야”, “잊어버렸어”, “재설정 페이지 열어줘”, “직접 입력할게”)
_ABOUT_IT = rx(
    r"^(어디|뭐|무엇|무슨|어떤|어떻게|어케|왜|몇|칸|란|창|입력|넣|써|쓰|적|채워|직접|잊|까먹|몰라|모르|기억|찾|변경|바꾸|바꿔|바꿀|재설정|초기화|"
    r"틀|안\s|안$|안돼|오류|에러|확인|규칙|조건|자리|글자|만들|설정|보여|보이|가려|가리|숨겨|화면|페이지|버튼|메뉴|필요|때문|대신|말고|없|다음|이전|"
    r"그거|이거|저거|관련|문제|방법|요구|물어|있)"
)
_ENDING_ONLY = rx(r"^(이?야|예요|이에요|입니다|이다|임|요)[\s.!?~]*$")
# 값을 말해 주겠다는 말(“알려줄게, 사과나무”) — 그 뒤에 무언가 있으면 값으로 본다
_OFFER = rx(r"^(알려\s*(줄게|줄께|드릴게)|말할게|말해\s*줄게|불러\s*줄게|말씀\s*드릴게)")


class SecretFinder(Protocol):
    """로컬 개인정보 인식 모델. 1등급(말하면 안 되는 값)만 (종류, 시작, 끝)으로 돌려준다. 종류는 SENSITIVE_LABELS_KO의 키."""

    def secret_spans(self, text: str) -> list[tuple[str, int, int]]: ...


_finder: SecretFinder | None = None
_cache: tuple[int, str, list[tuple[str, int, int]]] | None = None


def set_pii_model(finder: SecretFinder | None) -> None:
    """서버 시작 때 한 번. None이면 규칙만 쓴다(테스트 기본)."""
    global _finder, _cache
    _finder = finder
    _cache = None


def _model_spans(text: str) -> list[tuple[str, int, int]]:
    """모델이 있으면 1등급 구간. 한글이 없는 글(외국어)은 보지 않는다(한국어 모델). 모델 오류는 규칙만으로 계속한다."""
    global _cache
    finder = _finder
    if finder is None or not rx(r"[가-힣]").search(text):
        return []
    if _cache is not None and _cache[0] == id(finder) and _cache[1] == text:
        return _cache[2]
    try:
        spans = list(finder.secret_spans(text))
    except Exception as e:  # noqa: BLE001
        log.error("[privacy] 개인정보 모델 오류(%s) → 규칙만 사용", type(e).__name__)
        return []
    _cache = (id(finder), text, spans)
    return spans


def spoken_digit_spans(text: str) -> list[tuple[int, int, str]]:
    """한글로 읽은 숫자 덩어리의 (시작, 끝, 숫자). 예: "공일공 일이삼사" → "0101234"."""
    return [(m.start(), m.end(), rx(r"[ \-]").sub("", m.group()).translate(_SPOKEN_MAP)) for m in _SPOKEN_RUN.finditer(text)]


# 한글로 읽은 숫자는 뒤의 조사까지 숫자로 읽힐 수 있어("…오육칠 이에요"의 "이") 경계 없이 찾는다
_SPOKEN_VALUE_PATTERNS = [("rrn", rx(r"\d{6}[1-8]\d{6}")), ("card", rx(r"\d{16}"))]


def _spoken_value_kind(digits: str) -> str | None:
    for kind, pattern in _SPOKEN_VALUE_PATTERNS:
        if pattern.search(digits):
            return kind
    return None


def _has_value_after(kind: str, after: str, strict: bool) -> bool:
    if kind == "health":
        return len(rx(r"[은는이가:\s]").sub("", after)) >= 2 and not rx(r"(뜻|의미|뭐)").search(after)
    if rx(r"\d").search(after) or rx(r"[A-Za-z]{4,}").search(after) or _SPOKEN_RUN.search(after):
        return True
    if not strict:
        return False
    rest = _LEAD.sub("", after, count=1)
    # 끝맺음만 남았으면 값이 없다(“비밀번호요”, “오늘 비번이야”)
    if not rest or _ENDING_ONLY.search(rest):
        return False
    offer = _OFFER.search(rest)
    if offer:
        return bool(rx(r"[^\s,.!?。~]").search(rest[offer.end() :]))
    return not _ABOUT_IT.search(rest)


@dataclass
class SensitiveDetection:
    kinds: list[str] = field(default_factory=list)
    # 키워드 뒤에 실제 값으로 보이는 내용이 있거나, 값 패턴(주민번호 등)이 직접 등장
    hasSecretValue: bool = False


def detect_sensitive(text: str, *, model: bool = True) -> SensitiveDetection:
    """model=False면 규칙만(PolicyGuard: 결정적으로, 턴 입구에서 이미 모델로 본 값)."""
    kinds: dict[str, None] = {}
    secret = False
    for kind, pattern, strict in KEYWORDS:
        m = pattern.search(text)
        if not m:
            continue
        kinds[kind] = None
        if _has_value_after(kind, text[m.end() :], strict):
            secret = True
    for kind, pattern in VALUE_PATTERNS:
        if pattern.search(text):
            kinds[kind] = None
            secret = True
    for _s, _e, digits in spoken_digit_spans(text):
        kind = _spoken_value_kind(digits)
        if kind:
            kinds[kind] = None
            secret = True
    if model:
        for kind, _s, _e in _model_spans(text):
            kinds[kind] = None
            secret = True
    return SensitiveDetection(kinds=list(kinds), hasSecretValue=secret)


def redact_text(text: str) -> str:
    """저장·로그·모델 입력 전에 반드시 거치는 비식별화. 민감 키워드 뒤의 값은 통째로 가린다."""
    out = text
    # 위치가 원문 기준인 것(모델 구간, 한글로 읽은 주민번호·카드번호)부터 뒤에서 앞으로 가린다
    spans = [(s, e) for _k, s, e in _model_spans(text)]
    spans += [(s, e) for s, e, digits in spoken_digit_spans(text) if _spoken_value_kind(digits)]
    for s, e in sorted(_merge(spans), reverse=True):
        out = f"{out[:s]}{REDACTED}{out[e:]}"
    for _, pattern in VALUE_PATTERNS:
        out = pattern.sub(REDACTED, out)
    for kind, pattern, strict in KEYWORDS:
        m = pattern.search(out)
        if not m:
            continue
        end = m.end()
        if _has_value_after(kind, out[end:], strict):
            out = f"{out[:end]} {REDACTED}"
    return out


def _merge(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """겹치는 구간을 합친다."""
    merged: list[tuple[int, int]] = []
    for s, e in sorted(spans):
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def mask_value(value: str) -> str:
    """전화번호 등 개인정보를 읽어줄 때의 마스킹 (예: 010-****-5678)."""
    digits = rx(r"\D").sub("", value)
    if len(digits) >= 9:
        return f"{digits[:3]}-****-{digits[-4:]}"
    if len(value) <= 2:
        return "*" * len(value)
    return f"{value[0]}{'*' * (len(value) - 2)}{value[-1]}"
