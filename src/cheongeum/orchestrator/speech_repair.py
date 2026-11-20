"""대화 맥락에서 잘못 받아쓴 공공기관·업무 이름을 복원하고 확인할 후보를 제안한다."""
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from cheongeum.core.jsutil import AbortSignal, jdumps
from cheongeum.safety import REDACTED, detect_sensitive, redact_text
from cheongeum.understanding.sites import KNOWN_SITES, _one_edit_apart, public_service_site


@dataclass(frozen=True)
class Suggestion:
    text: str
    label: str


VOCAB = {name.replace(" ", ""): site for site in KNOWN_SITES for name in (*site.names, *site.services)
         if re.fullmatch(r"[가-힣0-9 ]{3,}", name)}
_WORDS = re.compile(r"[가-힣0-9]+")
_ENDING = re.compile(r"(?:에서|으로|까지|인가요|이요|을|를|에|로|은|는|좀|요)$")
_PRIVATE = re.compile(r"비밀번호|인증번호|주민등록번호|계좌|아이디|이메일|결제|승인|서명|대신\s*(?:신청|제출)|제출해|접수해")
_READ_ONLY = {"OPEN_SITE", "GOAL", "POLICY_QUESTION", "READ_MAIN", "LIST_LINKS", "DESCRIBE_SCREEN", "ABOUT_SITE", "UNKNOWN", "SEARCH_WEB", "PREPARE_APPLY"}


def word_suggestions(text: str) -> tuple[list[Suggestion], bool]:
    """공백·조사를 제외하고 실제 발화와 한 글자 차이인 낱말만 후보로 삼는다."""
    words = list(_WORDS.finditer(text))
    best: dict[str, Suggestion] = {}
    best_length = 0
    corroborated = False
    for i, first in enumerate(words):
        for last in words[i:i + 3]:
            span = text[first.start():last.end()]
            bare = _ENDING.sub("", span)
            word = bare.replace(" ", "")
            if len(word) < 3 or len(word) < best_length or word in VOCAB:
                continue
            # 이미 정확히 말한 이름 일부를 다른 업무로 고치지 않는다.
            if any(term in word for term in VOCAB if len(term) >= len(word) - 1):
                continue
            for term, site in VOCAB.items():
                if len(term) < 3 or term[0] != word[0] or not _one_edit_apart(word, term):
                    continue
                if len(word) > best_length:
                    best.clear()
                    best_length = len(word)
                    corroborated = False
                after = first.start() + len(bare)
                corrected = text[:first.start()] + term + text[after:]
                best[term] = Suggestion(corrected, term)
                # 다른 정확한 낱말도 같은 기관을 지목하면 경미한 기관명 오류를 바로 복원할 수 있다.
                other = public_service_site(text[:first.start()] + " " + text[after:])
                corroborated |= other is site and term in site.names
    return list(best.values())[:2], corroborated and len(best) == 1


async def interpret_speech(text: str, intent: str, context: dict, llm: Any, signal: AbortSignal,
                           parse: Callable[[str], str]) -> tuple[list[Suggestion], bool]:
    """결과는 (후보들, 독립된 단서로 확인됐는지). 모델이 추정한 요청은 항상 사용자에게 확인한다."""
    if intent not in _READ_ONLY | {"READ_FIELD", "PRECHECK"} or len(text) > 160 or REDACTED in text or _PRIVATE.search(text):
        return [], False
    candidates, clear = word_suggestions(text)
    if candidates:
        return candidates, clear
    if intent != "UNKNOWN" or llm is None or len(text) < 3:
        return [], False
    result = await llm.generate(
        system="음성으로 정부 서비스를 사용하는 사람의 받아쓰기 오류를 살펴본다. 발음과 현재 대화 양쪽에 근거가 있을 때만 "
               "원래 원했을 법한 읽기·찾기 요청 하나를 쉬운 한국어로 복원한다. 직전 답은 참고만 한다. "
               "그대로 이해되는 일반 대화, 근거 없는 추측, 숫자·개인정보·로그인·승인·입력·제출 관련 요청은 null로 둔다.",
        user=jdumps({"heard": text, "context": context}), schemaName="speech_repair",
        schema={"type": "object", "additionalProperties": False, "required": ["suggestion"],
                "properties": {"suggestion": {"type": ["string", "null"]}}}, signal=signal,
    )
    candidate = result.get("suggestion") if isinstance(result, dict) else None
    if not isinstance(candidate, str) or not 2 <= len(candidate.strip()) <= 120:
        return [], False
    candidate = candidate.strip()
    if (candidate == text or _PRIVATE.search(candidate) or detect_sensitive(candidate).hasSecretValue
            or redact_text(candidate) != candidate or parse(candidate) not in _READ_ONLY - {"UNKNOWN", "PREPARE_APPLY"}):
        return [], False
    return [Suggestion(candidate, candidate)], False
