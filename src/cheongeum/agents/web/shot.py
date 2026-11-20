"""
웹 화면 사진의 판단(모두 순수 함수, 브라우저를 부르지 않는다): 찍어도 되는 화면인가, 무엇을 가리는가.

 - plan_shot: 찍기 전에 화면 관찰만 보고 정한다. 접속 차단·보안문자·로그인·본인인증·비밀번호 칸이 있는 화면은 찍지 않는다.
 - judge_marks: 찍기 직전에 페이지가 표시해 준 글 조각(browser/blocks.js)을 보고 가릴 조각을 정한다.
   본문에 개인정보로 보이는 글이 있는데 그것을 담은 조각을 찾지 못하면 찍지 않는다(가리지 못하면 찍지 않는다).
개인정보 판정은 PolicyGuard와 같은 규칙(detect_sensitive, 모델 없이)이라 같은 화면에는 늘 같은 답이 나온다.
가리는 것은 그 규칙이 알아보는 것뿐이다. 그림 속 글, 이름·주소처럼 규칙이 모르는 것은 여기서 가려지지 않는다.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal, Sequence

from cheongeum.agents.web.auth_page import auth_page_kind
from cheongeum.agents.web.digest import digest_page
from cheongeum.core.jsutil import I, rx, uniq
from cheongeum.safety.privacy import PICTURE_CONTACT, detect_sensitive

ShotRefusalReason = Literal["loading", "too-large", "changed", "blocked", "captcha", "login", "verification", "password", "unmaskable"]

REFUSAL_SPEECH: dict[ShotRefusalReason, str] = {
    "loading": "그림을 아직 불러오고 있어요. 잠시 뒤에 다시 촬영해 주세요.",
    "too-large": "페이지가 너무 크거나 계속 늘어나서 한 장으로 촬영할 수 없어요.",
    "changed": "촬영하는 동안 화면이 바뀌어 사진을 보내지 않았어요. 다시 요청해 주세요.",
    "blocked": "접속이 막힌 화면은 사진으로 찍지 않아요.",
    "captcha": "보안문자가 있는 화면은 사진으로 찍지 않아요. 보안문자는 읽지도 풀지도 않아요.",
    "login": "로그인 화면은 사진으로 찍지 않아요.",
    "verification": "본인인증 화면은 사진으로 찍지 않아요.",
    "password": "비밀번호 칸이 있는 화면은 사진으로 찍지 않아요.",
    "unmaskable": "가려야 할 개인정보를 화면에서 다 찾지 못해서 사진을 찍지 않았어요.",
}


@dataclass(frozen=True)
class ShotRefusal:
    reason: ShotRefusalReason
    speech: str


@dataclass(frozen=True)
class ShotPlan:
    """찍을 때 검게 덮을 것(mask)과 아예 안 보이게 할 것(hide)의 CSS 선택자."""

    url: str
    mask: tuple[str, ...]
    hide: tuple[str, ...]


# 입력 요소는 비어 있어도 덮는다(관찰과 촬영 사이에 사용자가 칠 수 있다). 다른 문서가 든 틀은 속을 볼 수 없으니 통째로.
MASK_SELECTORS = ("input", "textarea", "select", "[contenteditable]", "iframe", "embed", "object")
# 청음의 가상 커서. cursor.js의 요소 이름이 바뀌어도 맞도록 접두어로 찾는다(물결은 id 없이 애니메이션 이름만 있다).
HIDE_SELECTORS = ('[id^="__cheongeum"]', '[style*="__cheongeum"]')

_CAPTCHA_WORDS = rx(r"(captcha|보안\s*문자|자동\s*입력\s*방지|자동\s*등록\s*방지|로봇이\s*아닙니다|are you a robot)", I)
_CAPTCHA_FRAME = rx(r"(captcha|turnstile)", I)
# 이웃 조각과 맞닿았는지 볼 때 견주는 글자 수
_NEIGHBOR_CHARS = 8


def _refuse(reason: ShotRefusalReason) -> ShotRefusal:
    return ShotRefusal(reason, REFUSAL_SPEECH[reason])


def plan_shot(view: dict) -> ShotPlan | ShotRefusal:
    """화면 관찰 하나로 정한다. 찍으면 안 되는 화면이면 까닭과 사용자에게 할 말을 돌려준다."""
    fields = view.get("fields") or []
    main_text = (view.get("outline") or {}).get("mainText") or ""
    labels = " ".join(f.get("label") or "" for f in fields)
    if _CAPTCHA_WORDS.search(f"{view.get('title') or ''}\n{main_text}\n{labels}"):
        return _refuse("captcha")
    if digest_page(view).kind == "blocked":
        return _refuse("blocked")
    kind = auth_page_kind(view)
    if kind != "other":
        return _refuse(kind)
    # 보이지 않는 비밀번호 칸(접힌 로그인 상자)도 찍는 사이에 펼쳐질 수 있다
    if any(f.get("type") == "password" for f in fields):
        return _refuse("password")
    return ShotPlan(url=view["url"], mask=MASK_SELECTORS, hide=HIDE_SELECTORS)


def _secret(text: str) -> bool:
    return bool(PICTURE_CONTACT.search(text)) or detect_sensitive(text, model=False).hasSecretValue


def _secret_entries(texts: Sequence[str | None]) -> set[int]:
    """
    이어진 글 조각 가운데 개인정보 값이 든 것의 번호. None은 끊긴 자리다.
    표나 목록은 이름('계좌번호')과 값이 서로 다른 조각에 있어, 혼자서는 값이 아니어도 바로 앞 조각과 붙여 값이 되면 값으로 본다.
    """
    hit: set[int] = set()
    label: str | None = None
    for i, text in enumerate(texts):
        if text is None:
            label = None
        elif _secret(text):
            hit.add(i)
            label = None
        elif label is not None and _secret(f"{label}\n{text}"):
            hit.add(i)
            label = None
        elif text.strip():
            label = text
    return hit


def _loose(chars: Sequence[str]) -> str:
    """띄어쓰기·줄바꿈이 달라도 맞는 식."""
    return r"\s*".join(re.escape(c) for c in chars)


def _piece_pattern(piece: str, before: str, after: str):
    """
    본문에서 글 조각 하나를 찾는 식. before·after는 화면에서 바로 앞뒤에 있는 조각의 글이다.
    조각의 양 끝은 낱말 경계이거나 이웃 조각의 글과 맞닿아 있어야 한다(관찰한 본문은 조각 사이를 붙여 쓰기도 한다).
    낱말 중간에서도 끊으면 짧은 조각('3')이 다른 번호의 일부를 지워 그 번호를 못 알아보게 된다.
    """
    chars = [c for c in piece if not c.isspace()]
    tail = [c for c in before if not c.isspace()][-_NEIGHBOR_CHARS:]
    head = [c for c in after if not c.isspace()][:_NEIGHBOR_CHARS]
    left = rf"(?:(?<!\w)|(?<={_loose(tail)}\s*))" if tail else r"(?<!\w)"
    right = rf"(?:(?!\w)|(?=\s*{_loose(head)}))" if head else r"(?!\w)"
    return rx(left + _loose(chars) + right)


def _cut(text: str, pattern) -> list[str | None]:
    """text에서 pattern이 맞은 자리를 끊어 낸다(끊긴 자리는 None)."""
    out: list[str | None] = []
    at = 0
    for m in pattern.finditer(text):
        out += [text[at : m.start()], None]
        at = m.end()
    return [*out, text[at:]]


def judge_blocks(blocks: list[dict], main_text: str) -> tuple[list[str], bool]:
    """
    화면의 글 조각([{id, text}], 문서 순서)에서 가릴 조각의 id와, 본문(main_text)의 개인정보가 그 조각들로 다 가려지는지.
    한 요소의 글이 안쪽 요소로 나뉘어 있으면 같은 id가 여러 번 나온다.
    두 번째 값이 False면 가리지 못한 개인정보가 본문에 남아 있다는 뜻이다.
    """
    texts = [b["text"] for b in blocks]
    flagged = sorted(_secret_entries(texts))
    rest: list[str | None] = [main_text]
    # 긴 조각부터 끊어야 짧은 조각이 긴 조각의 일부를 먼저 지우지 않는다
    for i in sorted(flagged, key=lambda i: len(texts[i]), reverse=True):
        pattern = _piece_pattern(texts[i], texts[i - 1] if i else "", texts[i + 1] if i + 1 < len(texts) else "")
        rest = [part for chunk in rest for part in ([None] if chunk is None else _cut(chunk, pattern))]
    lines = [line for chunk in rest for line in ([None] if chunk is None else chunk.split("\n"))]
    return uniq(blocks[i]["id"] for i in flagged), not _secret_entries(lines)


def judge_marks(marks: dict, main_text: str) -> list[str] | ShotRefusal:
    """
    blocks.js가 돌려준 것({blocks, frames, inputs, passwords, overlays})으로 찍을지와 가릴 글 조각의 id를 정한다.
    화면 관찰 뒤에 화면이 바뀌었을 수 있어 비밀번호 칸과 보안문자 틀은 여기서 한 번 더 본다.
    """
    if marks["passwords"]:
        return _refuse("password")
    if any(_CAPTCHA_WORDS.search(block["text"]) for block in marks["blocks"]) or any(_CAPTCHA_FRAME.search(frame["src"]) for frame in marks["frames"]):
        return _refuse("captcha")
    flagged, covered = judge_blocks(marks["blocks"], main_text)
    return flagged if covered else _refuse("unmaskable")
