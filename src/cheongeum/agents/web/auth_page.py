"""
로그인·본인인증 화면 판별.
'다 했어'/'인증 끝났어' 뒤 재관찰과 간편인증 인계가 같이 쓴다.
청음은 인증번호를 읽지도 입력하지도 않는다.
"""
from __future__ import annotations

from typing import Literal

from cheongeum.core.jsutil import I, rx

AuthPageKind = Literal["login", "verification", "other"]

_LOGIN_TITLE = rx(r"(로그인|log\s*-?\s*in|sign\s*-?\s*in)", I)
_VERIFY_TITLE = rx(r"(본인\s*인증|간편\s*인증|인증\s*화면|본인확인)", I)

# 간편인증 앱: (말할 이름, 화면 글 단서). 화면 제목·본문·단추 이름에서만 본다(값은 안 봄).
# ASCII 단어 경계: Python \b는 한글도 글자로 보아 'PASS로'에서 경계가 안 생긴다 → 영숫자·_만 본다.
_ASCII_WORD = r"(?<![A-Za-z0-9_]){}(?![A-Za-z0-9_])"
_VERIFY_APPS: tuple[tuple[str, object], ...] = (
    ("PASS", rx(rf"{_ASCII_WORD.format('PASS')}|패스\s*인증|모바일\s*PASS|통신사\s*PASS", I)),
    ("카카오톡", rx(r"카카오(\s*톡)?\s*(인증|로그인)|kakao\s*auth", I)),
    ("네이버", rx(r"네이버\s*(인증|로그인)|naver\s*auth", I)),
    ("토스", rx(rf"토스\s*(인증|로그인)|{_ASCII_WORD.format('toss')}", I)),
    ("금융인증서", rx(r"금융\s*인증|공동\s*인증|공동인증서")),
)


def password_fields(view: dict) -> list[dict]:
    """화면에 보이는 비밀번호 칸(값은 관찰 단계에서부터 읽지 않는다)."""
    return [f for f in view.get("fields") or [] if f.get("visible") and f["type"] == "password"]


def _view_haystack(view: dict) -> str:
    """앱 이름 판별용 글(제목·본문 앞머리·보이는 단추/링크 이름). 입력값은 넣지 않는다."""
    parts = [view.get("title") or "", (view.get("mainText") or "")[:800]]
    for item in (view.get("outline") or {}).get("items") or []:
        if item.get("name"):
            parts.append(item["name"])
    for f in view.get("fields") or []:
        if f.get("label"):
            parts.append(f["label"])
    return "\n".join(parts)


def verification_app(view: dict) -> str | None:
    """간편인증·인증서 앱 이름. 없으면 None."""
    hay = _view_haystack(view)
    for label, pattern in _VERIFY_APPS:
        if pattern.search(hay):
            return label
    return None


def auth_page_kind(view: dict) -> AuthPageKind:
    """
    화면이 로그인·본인인증·그 밖인지.
    - login: 모의 로그인 pageId, 비밀번호 칸, 또는 로그인 제목
    - verification: 본인/간편 인증 제목·앱 단서(비밀번호 칸 없음)
    - other: 이어 가도 되는 화면
    """
    if view.get("pageId") == "mock-login" or password_fields(view):
        return "login"
    title = view.get("title") or ""
    if _LOGIN_TITLE.search(title):
        return "login"
    if _VERIFY_TITLE.search(title) or verification_app(view):
        return "verification"
    return "other"


def still_needs_auth(view: dict) -> bool:
    """아직 로그인·인증 화면이면 True. '다 했어' 뒤 재관찰에 쓴다."""
    return auth_page_kind(view) != "other"


def first_fill_field(view: dict) -> dict | None:
    """사용자가 채울 첫 칸: 아이디·이메일 등 일반 칸을 비밀번호보다 먼저."""
    fields = [
        f
        for f in view.get("fields") or []
        if f.get("visible") and f.get("fieldId") and f["type"] in ("text", "email", "tel", "password", "number")
    ]
    return next((f for f in fields if f["type"] != "password"), None) or (fields[0] if fields else None)
