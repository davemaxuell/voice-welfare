"""행동 승인과 대화 선택에 쓰는 말. 승인에는 문장 전체가 맞아야 한다."""
from __future__ import annotations

from typing import Literal

from cheongeum.core.jsutil import B, I, rx


def command_key(text: str) -> str:
    return "".join(text.casefold().strip(" .!?。！？").split())


# 언어별 승인 단어(규칙). 번역을 거치지 않고 한국어 '네'로 바꾼다.
APPROVE = {
    "en": rx(r"^(yes|yeah|yep|ok|okay|sure|approve[d]?|i approve|confirm(ed)?|go ahead|do it|proceed)" + B + r"[\s,.!]*(please|approve|go ahead|proceed)?[.!]*$", I),
    "zh": rx(r"^(是的?|好的?|对|行|可以|确认|同意|批准|继续)[吧啊。！!，, ]*(确认|同意|批准|继续)?[吧。！!]*$"),
    "ja": rx(r"^(はい|ええ|うん|承認(します)?|お願いします|確認しました|進めて(ください)?|オーケー|オッケー)[、。！! ]*(承認します|お願いします|進めてください)?[。！!]*$"),
}
# 언어별 거절 단어
REJECT = {
    "en": rx(r"^(no|nope|don'?t|cancel|reject|not now)" + B, I),
    "zh": rx(r"^(不|不要|不用|取消|拒绝|算了)"),
    "ja": rx(r"^(いいえ|いや|やめて|キャンセル|拒否|結構です)"),
}

EXPLICIT_APPROVE_KO = rx(r"(?:(?:모의\s*접수|네|예|응)[,\s]*)?승인(?:합니다|할게요?|해\s*줘|이요)?")
PLAIN_YES_KO = rx(r"(?:네|예|응|눌러(?:\s*줘|주세요)?|진행(?:해\s*줘|해|하세요)?|보내\s*줘|보내세요)[,\s]*(?:접수해|진행해|좋아)?")
REJECT_KO = rx(r"^(아니|아뇨|아니요|아니야|틀렸어|취소|거절)|(승인\s*안|하지\s*마|안\s*할래|보내지\s*마)")

_YES = {"네", "예", "응", "어", "맞아", "맞아요", "맞습니다", "그래", "그래요", "좋아", "네맞아요", "응맞아",
        "yes", "yeah", "はい", "是", "是的", "对"}
_NO = {"아니", "아니요", "아뇨", "아니야", "아냐", "아니에요", "틀렸어", "no", "nope", "いいえ", "不是", "不对", "不用了"}

_AUTH_ACK = rx(r"^(?:네|예|응|yes|yeah|はい|好的)[\s,.，、。]+", I)
_AUTH_SUBJECT = r"(?:(?:본인\s*인증|인증|로그\s*인)(?:[을를이가은는])?\s*)?"
_AUTH_INPUT_DONE = rx(_AUTH_SUBJECT + r"(?:다\s*)?(?:입력했|넣었)(?:어요?|습니다|다)")
_DONE = (
    _AUTH_INPUT_DONE,
    rx(_AUTH_SUBJECT + r"(?:다\s*)?(?:(?:완료했|완료됐|했|끝났|마쳤|됐)(?:어요?|습니다|다)|완료|끝)"),
    rx(r"(?:i(?:['’]?m|\s+am)\s+)?(?:all\s+)?(?:done|finished)"
       r"(?:\s+(?:with\s+)?(?:sign[ -]?in|log[ -]?in|verification))?", I),
    rx(r"(?:我)?(?:已经|已經)?(?:好了|完成了|做完了|弄好了)"),
    rx(r"(?:(?:ログイン|認証)(?:が|は|を)?)?(?:終わりました|終わった|完了しました|できました)"),
)
_CANCEL = (
    rx(_AUTH_SUBJECT + r"(?:취소|그만)(?:해\s*(?:줘요?|주세요|요)?|하세요|할게요?|요)?"),
    rx(r"(?:please\s+)?cancel(?:\s+(?:the\s+|my\s+)?(?:sign[ -]?in|log[ -]?in|verification|authentication))?(?:,?\s+please)?", I),
    rx(r"(?:请|請)?取消(?:登录|登入|验证|驗證)?"),
    rx(r"(?:(?:ログイン|認証)を)?(?:キャンセル|取り消し)(?:して(?:ください)?|します)?"),
)


def approval(text: str, lang: str = "ko") -> Literal["approve", "reject"] | None:
    t = text.strip()
    if lang == "ko":
        t = t.rstrip(".!。").rstrip()
        if EXPLICIT_APPROVE_KO.fullmatch(t) or PLAIN_YES_KO.fullmatch(t):
            return "approve"
        if REJECT_KO.search(t):
            return "reject"
    elif lang in APPROVE:
        if APPROVE[lang].fullmatch(t):
            return "approve"
        if REJECT[lang].search(t):
            return "reject"
    return None


def foreign_approval(text: str, lang: str) -> Literal["approve", "reject"] | None:
    return None if lang == "ko" else approval(text, lang)


def whole_rejection(text: str, lang: str) -> bool:
    pattern = REJECT_KO if lang == "ko" else REJECT.get(lang)
    return bool(pattern and pattern.fullmatch(text.strip().rstrip(".!。！~").rstrip()))


def agree(text: str) -> Literal["yes", "no"] | None:
    key = command_key(text)
    if key in _YES:
        return "yes"
    if key in _NO:
        return "no"
    return None


def _auth_statement(text: str, *, whole: bool = False) -> str:
    t = text.strip().rstrip(".!。！~").rstrip()
    return t if whole else _AUTH_ACK.sub("", t, count=1)


def auth_input_done(text: str) -> bool:
    return bool(_AUTH_INPUT_DONE.fullmatch(_auth_statement(text)))


def done_reply(text: str, *, whole: bool = False) -> bool:
    statement = _auth_statement(text, whole=whole)
    return any(pattern.fullmatch(statement) for pattern in _DONE)


def cancel_reply(text: str) -> bool:
    t = text.strip().rstrip(".!。！~").rstrip()
    return any(pattern.fullmatch(t) for pattern in _CANCEL)


def ack_kind(text: str) -> Literal["ack", "no"] | None:
    """맞장구("알았어")만 한 말이면 "ack", 부정("아니")만 한 말이면 "no", 둘 다 아니면 None. 끝의 문장부호·공백은 무시한다."""
    t = rx(r"[.!~?,\s]+$").sub("", text).strip()
    ack = bool(
        rx(
            r"^(응\s*)?(알았어|알았어요|알겠어|알겠어요|알겠습니다|알았습니다|알았고|오케이|오키|그래|그래요|그렇구나|그렇군요|고마워|고마워요|감사합니다|네\s*알겠어요|응\s*그래)$"
        ).search(t)
    )
    no = bool(rx(r"^(아니|아니야|아니요|아뇨|아니에요|아냐|됐어|괜찮아|괜찮아요|아니\s*괜찮아)$").search(t))
    if not ack and not no:
        return None
    return "no" if no else "ack"
