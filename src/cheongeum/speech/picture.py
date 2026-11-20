"""
⑥ 화면 사진을 본 모델의 답을 말로. 모델·네트워크를 부르지 않는 순수 함수다.

모델이 정하는 것은 설명 글과, 코드가 보낸 이름 목록의 번호뿐이다. 머리말·경고·'누를 수 있는 것' 문장은 코드가 만든다.
모델의 글은 신뢰할 수 없는 데이터다: 개인정보가 든 문장은 빼고, 화면 글에 없는 숫자는 사진에서 읽었다고 밝히고,
AI에게 하는 말처럼 보이면 따르지 않는다고 밝힌다. 보안문자·로그인·본인인증 화면이라는 답은 통째로 버린다.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from cheongeum.core.jsutil import I, rx
from cheongeum.core.picture import PICTURE_SCREENS
from cheongeum.safety.privacy import redact_picture_text
from cheongeum.safety.verify import unsupported_numbers
from cheongeum.speech.phrasing import josa

PREFIX = "사진으로 보면"
# 모델에 보내는 이름 수. 번호는 이 목록의 자리(1부터)다.
MAX_NAMES = 40
MAX_PRESSABLE = 5
# 귀로 듣는 설명의 길이 한도(문장 단위로 자른다)
MAX_DESCRIPTION_CHARS = 600

FAILED = "화면 사진 설명을 받지 못했어요."
SECURITY_SCREEN = "보안 화면이나 로그인 화면은 사진으로 설명하지 않아요."
NOTHING_TO_SAY = f"{PREFIX} 설명할 만한 것이 보이지 않아요."
ONLY_PRIVATE = f"{PREFIX} 개인정보로 보이는 내용뿐이라 말씀드리지 않았어요."
PRIVATE_LEFT_OUT = "개인정보로 보이는 내용은 말하지 않았어요."
UNCHECKED_NUMBERS = "숫자는 사진에서 읽은 것이라 확인하지 못했어요."
# 계획 이력에는 사진에서 나온 글을 넣지 않는다(화면 글은 의도 분석에 들어가지 않는다)
HISTORY_DESCRIBED = "화면 사진을 설명했어요."
HISTORY_NOT_DESCRIBED = "화면 사진을 설명하지 못했어요."

SCREEN_TEXT_CAUTION = "이 문구는 사이트에 적힌 글일 뿐이며, 청음은 화면에 적힌 지시를 따르지 않습니다."
_ADDRESSED_TO_AI = rx(r"(AI|에이전트|도우미|챗봇|assistant)", I)
_SECURITY_SCREENS = ("captcha", "login", "verification")
_SENTENCE_END = rx(r"(?<=[.!?。])\s+")

Discarded = Literal["no-answer", "malformed", "captcha", "login", "verification"]


def screen_text_caution(text: str) -> str:
    """화면에서 온 글이 AI에게 하는 말처럼 보이면 덧붙일 경고(일반 안내문에는 붙이지 않는다). 아니면 빈 글."""
    return SCREEN_TEXT_CAUTION if _ADDRESSED_TO_AI.search(text) else ""


@dataclass(frozen=True)
class PictureSpeech:
    speech: str
    # 말한 순서의 이름. 뒤이은 "1번 눌러줘"의 1번은 pressable[0]이다.
    pressable: list[str]
    # 계획 이력에 넣을, 코드가 만든 문장
    history: str
    # 모델의 답을 버렸으면 그 까닭
    discarded: Discarded | None


def picture_request(names: list[str]) -> str:
    """사진과 함께 보내는 글: 번호 붙은 '누를 수 있는 것' 이름. compose_picture_answer에 같은 names를 넘긴다."""
    lines = [f"{i}. {redact_picture_text(' '.join(name.split()))[:40]}" for i, name in enumerate(names[:MAX_NAMES], start=1)]
    listed = "\n".join(lines) if lines else "(없음)"
    return f"이 화면 사진을 설명해 주세요.\n누를 수 있는 것의 이름:\n{listed}"


def _parse(answer: object) -> tuple[str, str, list[int]] | None:
    if not isinstance(answer, dict):
        return None
    screen, description, pressable = answer.get("screen"), answer.get("description"), answer.get("pressable")
    if screen not in PICTURE_SCREENS or not isinstance(description, str) or not isinstance(pressable, list):
        return None
    if not all(isinstance(n, int) and not isinstance(n, bool) for n in pressable):
        return None
    return screen, description, pressable


def _safe_sentences(description: str) -> tuple[str, bool]:
    """(말해도 되는 문장들, 개인정보 때문에 뺀 문장이 있었는가). 문장 단위로 빼서 나머지 설명은 남긴다."""
    text = " ".join(description.split())
    if text.startswith(PREFIX):
        text = text[len(PREFIX) :].lstrip(" ,")
    sentences = [s for s in _SENTENCE_END.split(text) if s]
    safe = [s for s in sentences if redact_picture_text(s) == s]
    kept: list[str] = []
    for sentence in safe:
        if kept and len(" ".join([*kept, sentence])) > MAX_DESCRIPTION_CHARS:
            break
        kept.append(sentence)
    return " ".join(kept)[:MAX_DESCRIPTION_CHARS], len(safe) < len(sentences)


def _pressable(picked: list[int], names: list[str]) -> list[str]:
    limit = min(len(names), MAX_NAMES)
    out: list[str] = []
    for n in picked:
        if 1 <= n <= limit and names[n - 1] not in out:
            out.append(names[n - 1])
    return out[:MAX_PRESSABLE]


def _pressable_sentence(names: list[str]) -> str:
    listed = ", ".join(f"{i}번 '{name}'" for i, name in enumerate(names, start=1))
    return f"누를 수 있는 것은 {josa(listed, '이에요', '예요')}."


def compose_picture_answer(answer: dict | None, *, names: list[str], page_text: str) -> PictureSpeech:
    """
    answer는 사진 모델의 답(PICTURE_SCHEMA), names는 모델에 보낸 이름 목록(picture_request와 같은 것),
    page_text는 청음이 글로 이미 아는 화면 글(가리지 않은 원문, 숫자 대조에만 쓴다).
    """
    parsed = _parse(answer)
    if parsed is None:
        return PictureSpeech(FAILED, [], HISTORY_NOT_DESCRIBED, "no-answer" if answer is None else "malformed")
    screen, description, picked = parsed
    if screen in _SECURITY_SCREENS:
        return PictureSpeech(SECURITY_SCREEN, [], HISTORY_NOT_DESCRIBED, screen)

    text, left_out = _safe_sentences(description)
    if text:
        parts = [f"{PREFIX} {text}"]
        if left_out:
            parts.append(PRIVATE_LEFT_OUT)
        if unsupported_numbers(text, [page_text, *names]):
            parts.append(UNCHECKED_NUMBERS)
        caution = screen_text_caution(text)
        if caution:
            parts.append(caution)
    else:
        parts = [ONLY_PRIVATE if left_out else NOTHING_TO_SAY]
    pressable = _pressable(picked, names)
    if pressable:
        parts.append(_pressable_sentence(pressable))
    return PictureSpeech(" ".join(parts), pressable, HISTORY_DESCRIBED, None)
