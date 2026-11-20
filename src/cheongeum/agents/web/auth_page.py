"""
로그인·본인인증 화면 판별.
'다 했어'/'인증 끝났어' 뒤 재관찰과 간편인증 인계가 같이 쓴다.
청음은 인증번호를 읽지도 입력하지도 않는다.
"""
from __future__ import annotations

from typing import Literal

from cheongeum.core.jsutil import I, rx

AuthPageKind = Literal["login", "verification", "captcha", "other"]
CAPTCHA = rx(r"(보안\s*문자|자동\s*입력\s*방지|captcha|verify (?:that )?you are human|are you a robot)", I)
ACCESS_BLOCK = rx(r"(접속이\s*차단|접근이\s*차단|비정상적인\s*접근|unusual traffic|access denied)", I)


def access_blocked(view: dict) -> bool:
    outline = view.get("outline") or {}
    return bool(ACCESS_BLOCK.search(f"{view.get('title', '')} {(outline.get('mainText') or '')[:600]}"))

_LOGIN_TITLE = rx(r"(로그인|log\s*-?\s*in|sign\s*-?\s*in)", I)
_VERIFY_TITLE = rx(r"(본인\s*인증|간편\s*인증|인증\s*화면|본인\s*확인|휴대\s*(폰|전화)\s*인증)", I)
# 인증을 하라는 칸·단추: 인증번호 칸, '인증번호 받기·인증 요청', 간편인증·인증서 로그인 단추
_VERIFY_CONTROL = rx(r"인증\s*번호|인증\s*(요청|받기)|간편\s*(인증|로그인)|인증서\s*로그인")
# 본문 앞머리의 인증 수단 고르기: "간편인증 서비스를 선택해 주세요"
_VERIFY_CHOOSE = rx(r"간편\s*인증\s*(서비스를?\s*)?선택|인증\s*(수단|방법)을?\s*선택")
# 본문은 '지금 인증하라'는 문장만 단서로 본다(주인 결정 2026-11-19).
# 신청 안내 화면이 절차를 설명하는 말("…로그인이 필요합니다", "…로그인한 뒤 신청하세요")은 단서가 아니다.
_DO_IT_NOW = rx(r"하세요|해\s*주세요|하십시오|진행합니다|진행해|선택해|입력해|눌러")
_DESCRIBES = rx(r"필요|뒤|후에|있어야|있으면|가능|할\s*수\s*있")
# 이 화면에서 바로 누르라는 말은 '…한 뒤'가 있어도 지금 할 일: "인증을 완료한 뒤 확인을 눌러 주세요"
_ON_PAGE = rx(r"(확인|완료|다음)\s*(버튼)?\s*(을|를)?\s*눌러")


def _instructions(main_text: str) -> str:
    sentences = rx(r"(?<=[.!?。])\s+|\n").split(main_text[:800])
    return " ".join(s for s in sentences if _DO_IT_NOW.search(s) and (_ON_PAGE.search(s) or not _DESCRIBES.search(s)))

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


# 인증서를 다루는 도구 단추: 복지로는 모든 공개 화면 머리말에 '공동인증서 내보내기'가 있다. 인증하라는 단서가 아니다.
_CERT_TOOL = rx(r"인증서\s*(내보내기|가져오기|복사|관리|안내|발급|갱신|찾기|삭제)|인증\s*마크|품질\s*인증")
_AUTH_NEWS = rx(r"점검|공지사항|이용\s*안내|서비스\s*안내|사용\s*방법|이용\s*방법")


def _auth_items(outline: dict) -> list[str]:
    return [name for item in outline.get("items") or [] if (name := item.get("name"))
            and item.get("region") != "menu" and not _CERT_TOOL.search(name) and not _AUTH_NEWS.search(name)]


def _view_haystack(view: dict) -> str:
    """앱 이름 판별용 글(제목·본문 앞머리·열린 대화상자·보이는 단추/링크·칸 이름, 인증서 도구 단추는 뺌). 입력값은 넣지 않는다."""
    outline = view.get("outline") or {}
    parts = [view.get("title") or "", (outline.get("mainText") or "")[:800]]
    for d in view.get("dialogs") or []:
        parts += [d.get("title") or "", d.get("text") or "", *(d.get("buttons") or [])]
    parts += _auth_items(outline)
    parts += [f["label"] for f in view.get("fields") or [] if f.get("label") and f.get("visible")]
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
    - verification: 본인/간편 인증 제목, 또는 앱 단서(비밀번호 칸 없음). 인증서 도구 단추(_CERT_TOOL)는 단서가 아니다.
    - other: 이어 가도 되는 화면
    """
    title = view.get("title") or ""
    outline = view.get("outline") or {}
    controls = " ".join(f.get("label") or "" for f in view.get("fields") or [] if f.get("visible"))
    controls += " " + " ".join(item.get("name") or "" for item in outline.get("items") or [])
    if CAPTCHA.search(controls) or (not access_blocked(view) and CAPTCHA.search(f"{title} {(outline.get('mainText') or '')[:600]}")):
        return "captcha"
    if view.get("pageId") == "mock-login" or password_fields(view):
        return "login"
    if _LOGIN_TITLE.search(title):
        return "login"
    names = [f.get("label") or "" for f in view.get("fields") or [] if f.get("visible")]
    names += _auth_items(outline)
    told = _instructions(outline.get("mainText") or "")
    if (
        _VERIFY_TITLE.search(title)
        or any(_VERIFY_CONTROL.search(n) for n in names)
        or _VERIFY_CHOOSE.search(told)
        or verification_app({**view, "outline": {**outline, "mainText": told}})
    ):
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
