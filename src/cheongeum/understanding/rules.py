"""결정적 한국어 규칙 파서(mock LLM). 의도는 IntentSchema 모양의 dict."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

import regex

from cheongeum.core.jsutil import B, I, rx
from cheongeum.core.lexicon import EXPLICIT_APPROVE_KO, approval, auth_input_done, done_reply
from cheongeum.core.places import is_place_request
from cheongeum.understanding.filters import strip_address
from cheongeum.understanding.sites import is_site_name, mentions_known_site, public_service_site


@dataclass
class IntentContext:
    state: str
    awaitingFieldId: str | None = None


class IntentProvider(Protocol):
    name: str

    async def parse(self, text: str, ctx: IntentContext) -> dict: ...


def escape_re(s: str) -> str:
    return rx(r"[.*+?^${}()|[\]\\]").sub(lambda m: "\\" + m.group(0), s)


def alias_pattern(alias: str) -> str:
    """"소득·재산 신고" ↔ "소득 재산신고"처럼 띄어쓰기·가운뎃점 차이를 허용"""
    return r"[\s·.]*".join(escape_re(ch) for ch in rx(r"[\s·.]").sub("", alias))


# 멈춤은 언어와 상관없이 규칙으로 즉시(번역·LLM을 거치지 않음). 중국어 '停'은 '停车场' 같은 낱말에 흔해 묶음 표현만.
STOP_RE = rx(
    r"(?:청음(?:아|이)?\s*)?(?:(?:잠깐만?|당장|긴급|지금|이제|그냥|제발|하던\s*일을?|이?\s*작업을?)\s*)*"
    r"(?:멈춰(?:\s*(?:줘요?|주세요|주실래요|요|라))?|멈추(?:세요|자|어|라고)|멈춤|잠깐(?:만요?|요)?|"
    r"(?:중지|중단|정지|스톱|취소|그만)(?:\s*(?:해(?:\s*(?:줘|주세요|요))?|하세요|시켜(?:줘|주세요)?|요))?)"
    r"|(?:hey\s+)?(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:stop|halt|cancel|pause)"
    r"(?:\s+(?:talking|speaking|everything|it|that|this|the task|the current task|now|please))*"
    r"|(?:请|請|先|马上|馬上)*(?:停止|停下|停一下|别动|暂停|停|別動|暫停)(?:吧|来|來|操作|任务|任務)?"
    r"|(?:今すぐ|ちょっと)?(?:止めて|止まって|ストップ|やめて|中止)(?:ください|下さい|して|してください)?",
    I,
)
_STOP_IMPERATIVE = rx(r"(?:^|\s)(?:멈춰\s*(?:줘|주세요|라)|멈추세요|중단해\s*(?:줘|주세요))$")
_STOP_CLAUSES = rx(r"([^,.!?;，。！？、\n]+)([,.!?;，。！？、\n]*)")
_CANCEL_WORD = rx(r"(?:취소(?:요)?|cancel)", I)


def is_stop_utterance(text: str) -> bool:
    """LLM과 무관하게 항상 규칙으로 즉시 판정하는 중단 명령."""
    for words, punctuation in _STOP_CLAUSES.findall(text):
        clause = words.strip()
        # A bare cancellation question leaves the decision open. An explicit stop still interrupts.
        if ("?" in punctuation or "？" in punctuation) and _CANCEL_WORD.fullmatch(strip_address(clause)):
            continue
        if STOP_RE.fullmatch(clause) or _STOP_IMPERATIVE.search(clause):
            return True
    return False


_PICTURE_REQUEST = rx(
    r"^(?:(?:지금|현재|이|브라우저)\s*)*"
    r"(?:(?:전체\s*)?(?:웹\s*)?(?:페이지|화면)(?:\s*전체)?(?:을|를)?\s*(?:사진|캡처|캡쳐|스크린\s*샷)|스크린\s*샷)"
    r"(?:으로|로|에서|해서|하고|을?\s*찍(?:어|어서|고)|을?\s*보고)\s*"
    r"[^?!]*(?:설명해|알려|읽어|말해|비교해|찾아|확인해|보여)\s*(?:줘|주세요|주실래요)[?？]?$"
)
_NO_PICTURE = rx(r"없이|말고|하지\s*마|찍지\s*마|보내지\s*마|안\s*찍")


def wants_text_only_screen(text: str) -> bool:
    """사진 전송을 거절한 발화는 번역이나 모델의 결정 뒤에도 글로만 읽는다."""
    if _NO_PICTURE.search(text) and rx(r"사진|캡처|캡쳐|스크린\s*샷|촬영").search(text):
        return True
    return bool(rx(
        r"글로만|글만|텍스트로만|텍스트만|text[ -]only|only (?:use |read )?(?:the )?text|"
        r"(?:no |without |don['’]t |do not |avoid |skip |never )[^.!?]{0,45}(?:screenshot|screen ?capture|page image)|"
        r"(?:截图|截屏|屏幕截图).{0,8}(?:不要|不用)|(?:别|不要|不用|不发|不传).{0,12}(?:截图|截屏)|只(?:读|看|用)文字|"
        r"(?:スクリーンショット|画面写真|画像|スクショ).{0,10}(?:なし|不要|使わず|撮らず|送らず|送らない)|(?:文字|テキスト)だけ", I
    ).search(text))


def is_picture_request(text: str, *, utterance: str | None = None) -> bool:
    return bool(_PICTURE_REQUEST.fullmatch(text) and not _NO_PICTURE.search(utterance or text))


def download_mode(text: str) -> str | None:
    """READ_DOWNLOAD의 세 가지 동작. 외부 전송 여부는 사용자가 실제로 한 말에서만 정한다."""
    noun = r"(?:파일|문서|다운로드|PDF|피디에프|HWPX|이미지|사진)"
    if not rx(noun, I).search(text):
        return None
    downloaded = rx(r"(?:받은|내려받은|다운로드한)\s*" + noun, I).search(text)
    if not downloaded and rx(r"(?:화면|페이지|사이트|검색|버튼|링크)").search(text):
        return None
    if not downloaded and rx(r"이미지|사진").search(text) and not rx(r"파일|문서|다운로드").search(text):
        return None
    if rx(r"(파일|다운로드|문서)\s*(목록|리스트|뭐\s*있)|어떤\s*파일.*(받|있)").search(text):
        return "list"
    if rx(noun + r".*(그대로|원문|읽어|들려)", I).search(text) and "요약" not in text:
        return "read"
    if rx(noun + r"(?:을|를|도)?\s*(요약|설명해)", I).search(text):
        return "analyze"
    if rx(r"(?:받은|내려받은|다운로드한|이|그)\s*" + noun + r"|" + noun + r"(?:에|에서|에는|의)", I).search(text):
        if rx(r"요약|설명해|알려|뭐야|무엇|언제|얼마|뭔가요|어떤|어떻게|몇|\?$").search(text):
            return "analyze"
    return None


_QUESTION_END = r"(?:어요?|나요?|니|죠|습니까|을까(?:요)?)"
_PROGRESS = rx(
    r"(?:지금|현재|아직|그거)?\s*(?:"
    rf"어디까지\s*(?:(?:진행\s*)?(?:했|됐|왔|갔)|(?:진행)?하고\s*있){_QUESTION_END}"
    rf"|얼마나\s*(?:(?:남았|(?:진행\s*)?(?:했|됐)){_QUESTION_END}|(?:더\s*)?걸(?:려(?:요)?|리(?:나요|죠|니)))"
    rf"|(?:뭐|뭘|무엇을?)\s*(?:하고\s*있{_QUESTION_END}|하는\s*중(?:이야|이에요|인가요|이니)?)"
    rf"|멀었{_QUESTION_END}"
    r"|언제\s*(?:끝나(?:나요|요|니)?|끝날까(?:요)?|다\s*돼(?:요)?|다\s*되(?:나요|죠))"
    r")"
)
_AFTER_QUESTION = rx(r"(?:[?!.,，。！？~]+\s*|\s+)(?:(?:그리고|그다음에?)\s+)?")


def is_progress_question(text: str) -> bool:
    """
    멈춤처럼 규칙으로만 판정한다: 일하는 중에도 턴 대기열을 거치지 않고 바로 답하기 위해. 맨 앞의 부름말은 떼고 본다.
    다른 명령이 붙은 긴 말은 아니라고 본다(물음에만 답하고 뒤의 명령을 버리지 않게).
    """
    return bool(_PROGRESS.fullmatch(strip_address(text).rstrip(" .!?。！？~")))


def after_progress_question(text: str) -> str | None:
    """A separate request following a complete status question."""
    t = strip_address(text)
    question = _PROGRESS.match(t)
    if question and (separator := _AFTER_QUESTION.match(t, question.end())):
        return t[separator.end():].strip() or None
    return None


QUOTES = rx(r"""^["'“”‘’「」]+|["'“”‘’「」.,!?。]+$""")


def clean_value(raw: str) -> str:
    v = QUOTES.sub("", raw.strip()).strip()
    v = rx(r"\s*(이?라고)\s*(써|입력해|적어)?\s*줘?(요)?$").sub("", v, count=1)
    v = rx(r"\s*(으로|로)\s*(해|입력해|적어|써|바꿔|수정해)\s*줘?(요)?$").sub("", v, count=1)
    v = rx(r"(이에요|예요|입니다|이야|이요|이고요)$").sub("", v, count=1)
    if rx(r"[가-힣]{2,}(야|요)$").search(v):
        v = v[:-1]
    return QUOTES.sub("", v).strip()


def _short(t: str) -> bool:
    return len(t) <= 16 and not rx(r"\d").search(t)


_SERVICE_REF = rx(r"([가-힣]{2,12}(?:연금|수당|급여|바우처|지원금|장려금|지원사업))")
# 찾기 결과 목록 속 제도를 순서로 가리킴("두 번째 제도"). 입력 항목 설명(EXPLAIN)이 아니다.
_LISTED_SERVICE = rx(r"(첫|두|세|네|다섯|\d{1,2})\s*번\s*째\s*(제도|복지|서비스|혜택)")

# 할 수 있는 말 안내: "뭐라고 말하면 돼?", "뭘 할 수 있어?", "도움말", "사용법 알려줘", "명령어 알려줘", "다른 말도 알려줘".
# 말 앞쪽에서만 본다("이 사이트에서 뭘 할 수 있어?"는 사이트 소개). "다른 말로 해줘"는 쉬운 말 다시 설명이라 뺀다.
_WHAT_CAN_I_SAY = rx(
    r"^(?:(?:너|넌|너는|청음|청음은|청음이는)\s*)?(?:"
    r"(?:뭐라고|어떻게)\s*(?:말|얘기)\s*(?:하면|해야)|뭐라고\s*(?:하면|해야)"
    r"|(?:뭐라고|무슨\s*말을?)\s*(?:말\s*)?할\s*수\s*있"
    r"|(?:뭘|뭐|무엇을?)\s*할\s*수\s*있|할\s*수\s*있는\s*(?:말|것|거|게)"
    r"|도움말|사용\s*법|사용\s*방법|명령어|다른\s*(?:말|명령)(?!\s*로))"
)
# 지난 안내에 이어서: "다른 말도 알려줘", "도움말 더"
_HELP_MORE = rx(r"^다른|(?:^|\s)(?:더|또)(?:\s|$)")
_GO_THERE = r"(에서|가서|들어가서|열고|열어서|접속해서)"
# 사이트 이름·주소 바로 뒤에 붙은 '에서·가서·열어서'만 '그 사이트에 가서'로 본다('화면에서'는 아니다).
# '국민연금공단 사이트에서'처럼 사이트·홈페이지 낱말이 사이에 끼어도 같다.
_BEFORE_GO_THERE = rx(r"(\S+?)\s*(?:(?:사이트|홈페이지|누리집|웹\s*사이트)\s*)?(?:에서|들어가서|가서|열고|열어서|접속해서)")
_GOAL_ASK = r"(알려|찾아|읽어|확인|보여|있는지|뭐\s*있|정리)"
# "공식 안내 열어줘", "2번 공식 안내 열어줘", "장애인연금 공식 안내 열어줘": 말 첫머리에서만('삼성전자 공식 사이트'는 사이트 열기)
_OPEN_OFFICIAL = rx(
    r"^(?:(?:그|이|방금|아까)\s*)?"
    r"(?:(?P<num>\d{1,2})\s*번\s*(?:의\s*)?"
    r"|(?P<name>(?!(?:그|이|방금|아까)\s)[가-힣0-9·\s]{2,24}?)\s*(?:의\s*)?(?=공식\s*(?:안내|페이지|화면|자료)))?"
    r"공식\s*(?:안내|페이지|화면|자료|누리집|사이트)?\s*(?:만|을|를|도)?\s*(?:좀\s*)?(?:열어|보여|띄워)(?!\S*지\s*(?:말|마|않))"
)
# 하지 말라는 말: "로그인하거나 신청하지 말고", "로그인 없이", "로그인 안 해", "로그인 필요 없어", "제출 금지",
# "로그인 버튼 누르지 마", "로그인하라는 게 아니고", "제출은 나중에 하고".
# '못 하'·'되지 않'은 넣지 않는다: "로그인 못 하겠어, 도와줘", "로그인이 되지 않아요"는 로그인을 도와 달라는 말
_NEGATION = (
    r"[^,.?!]{0,12}?(\S*(?<!되)지\s*(말|마|않)|없이|말고|안\s*(하|해|할|함)|하면\s*안\s*(돼|되)|필요\s*없|빼고|나중에|금지"
    r"|(게|건)\s*아니|하기\s*전에)"
)
_SUBMIT_NEGATED = rx(r"(접수|제출)" + _NEGATION)
# 로그인은 목적어와 수행 요청이 붙어 있을 때만. 언급만 하면 정보 질문의 대상으로 남긴다.
_LOGIN_ASK = rx(r"(?:로그인|본인\s*인증|간편\s*인증)(?:만|을|이)?\s*(?:좀\s*)?(?:$|해\s*(?:줘|주세|줄래)|하자|할래|하고\s*싶(?!지)|해야\s*해|"
                r"(?:화면|페이지|창)(?:을|를)?\s*열어|(?:버튼\s*)?눌러\s*줘|도와\s*(?:줘|주세요|줄래)|연습할래|못\s*하|안\s*(?:돼|되)|되지\s*않)")
_SUBMIT_ASK = rx(r"(?:접수|제출)(?:을|를)?\s*(?:해\s*(?:줘|주세요|$)|할게|하자|진행|(?:내용을?\s*)?확인(?:했|할게))")
# 앞의 것을 빼고 뒤의 것만: "장애수당 말고 장애인연금", "장애수당 아니고 …", "장애수당이 아니라 …"
_NOT_THIS = rx(r"\S+?\s*(?:말고|아니고|이?\s*아니라)\s*")
# 지금 연 화면·사이트·결과의 제목이나 이름을 묻는 말(입력 칸 '이름'이 아니다)
_PAGE_NAME = rx(r"(?<![가-힣])(사이트|페이지|화면|결과|글|기사|누리집|홈페이지)\s*(의\s*)?(이름|제목)")
_EDIT_WORD = r"(수정|고칠|고쳐|바꿀|바꿔|변경|틀렸|잘못)"
# 방금 들은 것을 한 번만 천천히 다시: "그 번호를 다시 천천히", "확인한 전화번호를 천천히 읽어줘"
_SLOW_REPEAT = rx(r"(천천히|느리게)\s*(다시\s*)?(말해|읽어)")
# '다시'만으로는 아니다: "주소 다시 천천히 읽어줘"는 입력 칸 읽기
_JUST_SAID = rx(r"(?:^|\s)그\s|확인한|방금|아까")
# 지금 화면·사이트를 가리키는 말
_HERE = rx(r"(?:^|\s)(?:이|여기|지금|현재|이곳)(?=\s|$)")


def goes_to_another_site(text: str, fuzzy: bool = True) -> bool:
    """
    '복지로 가서 첫 화면에 뭐가 있는지 알려줘'처럼 다른 사이트에 가서 볼 일인지. 지금 화면 질문 규칙보다 먼저 본다.
    사이트 목록에는 '기초연금'처럼 복지 낱말도 있으므로 이름이 '에서·가서' 바로 앞에 올 때만, 그리고
    '이·여기·지금'으로 지금 화면을 가리키지 않을 때만 그렇다고 본다.
    """
    if _HERE.search(text):
        return False
    return any(mentions_known_site(m.group(1), fuzzy) for m in _BEFORE_GO_THERE.finditer(text))


class RuleBasedIntentProvider:
    """
    결정적 한국어 규칙 파서(mock LLM). 키 없이 데모·테스트가 재현되도록 기본 사용한다.
    입력은 이미 비식별화된 사용자 발화뿐이며, 화면 텍스트는 절대 넣지 않는다.
    """

    name = "mock-rule"

    def __init__(self, vocabulary: Sequence[str]) -> None:
        ordered = sorted(vocabulary, key=lambda a: -len(rx(r"[\s·.]").sub("", a)))
        self.aliases = [
            {
                "alias": alias,
                "re": rx(r"^(?:(?:제|내|저의|신청인)\s*)?(?:" + alias_pattern(alias) + r")(?:\s*(?:은|는|이|가|을|를|:)\s*|\s+)(.+)$"),
                "anyRe": rx(alias_pattern(alias)),
            }
            for alias in ordered
        ]

    def mention(self, text: str) -> str | None:
        return next((a["alias"] for a in self.aliases if a["anyRe"].search(text)), None)

    def _fill_segment(self, seg: str) -> dict | None:
        for a in self.aliases:
            m = a["re"].search(seg.strip())
            if not m:
                continue
            value = clean_value(m.group(1))
            if value:
                return {"fieldMention": a["alias"], "value": value}
        return None

    def split_commands(self, input_: str) -> list[str]:
        """
        여러 명령을 한 번에 말했을 때 문장을 나눈다(예: "이름은 김하늘이고 주소는 …, 다음으로 넘어가줘").
        나누지 못하면 원문 하나를 돌려준다.
        """
        field_words = "|".join(escape_re(a["alias"]) for a in self.aliases)
        marked = input_.strip()
        # "…김하늘이고 주소는" / "…신청하고 이름은": 연결 어미 뒤에 항목·명령이 오면 나눈다
        marked = rx(r"(?<!그리)(이)?고\s+(?=(" + field_words + r"|다음|이전|그리고|모의|제출|화면|본문|링크|검색|뒤로|공식))").sub(" ␟ ", marked)
        marked = rx(r"\s*(?:[,，]|그리고|그\s*다음에?|그런\s*다음에?|다음에는|한\s*다음에?|하고\s*나서|그러고\s*나서)\s+").sub(" ␟ ", marked)
        parts = [p.strip() for p in marked.split("␟") if p.strip()]
        return parts if len(parts) > 1 else [input_.strip()]

    async def parse(self, input_: str, ctx: IntentContext) -> dict:
        return self.parse_sync(input_, ctx)

    def parse_sync(self, input_: str, ctx: IntentContext) -> dict:
        text = rx(r"[.!。]+$").sub("", rx(r"\s+").sub(" ", input_.strip()))
        state = ctx.state

        def has(pattern: str, flags: int = 0) -> bool:
            return bool(regex.search(pattern, text, flags))

        if is_stop_utterance(text):
            return {"type": "STOP"}
        if is_picture_request(text):
            return {"type": "DESCRIBE_PICTURE", "question": text}
        if is_progress_question(text):
            return {"type": "PROGRESS"}
        if has(r"(?:시작|처음|첫\s*이용|개인정보|이용)\s*(?:할\s*때\s*)?안내(?:문|사항|\s*전문)?(?:를|을)?\s*(?:다시\s*)?(?:들려|읽어|듣고|알려|말해|보여)"):
            return {"type": "READ_START_GUIDE"}
        # 첫 실행: 청음 소개 다시 듣기 · 처음 설정 다시 하기('말하기 설정 …'은 말하기 설정 명령이라 앞에 다른 말이 없을 때만)
        if has(r"(?:청음|자기)\s*소개\s*(?:를\s*)?(?:다시\s*)?(?:해|들려|알려|보여)"):
            return {"type": "INTRO_REPLAY"}
        if rx(r"^(?:청음\s*)?(?:처음\s*)?설정(?:을)?\s*(?:처음부터\s*)?다시\s*(?:해|할래|하고\s*싶)").search(text):
            return {"type": "SETUP_RESTART"}
        if has(r"(다시\s*시작|재개|계속\s*(해|하자|진행))"):
            return {"type": "RESUME"}
        if has(r"(거절|승인\s*안|하지\s*마|안\s*할래)") or (
            state == "WAITING_FOR_USER_CONFIRMATION" and approval(text) == "reject"
        ):
            return {"type": "REJECT"}
        if EXPLICIT_APPROVE_KO.fullmatch(text) or (
            state == "WAITING_FOR_USER_CONFIRMATION" and approval(text) == "approve"
        ):
            return {"type": "APPROVE"}
        if state == "AUTH_HANDOFF" and auth_input_done(text):
            return {"type": "LOGIN"}
        if (state == "AUTH_HANDOFF" or has(r"(?:인증|로그\s*인)")) and done_reply(text):
            return {"type": "AUTH_DONE"}
        # 로그아웃·로그인 기록 삭제(로그인보다 먼저: '로그아웃'에 '로그인'이 들어 있음)
        if has(r"로그\s*아웃|로그인\s*(기록|쿠키|정보).*(지워|삭제|없애)|로그인\s*풀어"):
            return {"type": "CLEAR_LOGIN"}
        mode = download_mode(text)
        if mode:
            return {"type": "READ_DOWNLOAD", "list": mode == "list"}
        if _LOGIN_ASK.search(text):
            return {"type": "LOGIN"}
        if _SUBMIT_ASK.search(text) and not _SUBMIT_NEGATED.search(text):
            return {"type": "PREPARE_SUBMIT"}
        if has(r"최종\s*확인"):
            return {"type": "PREPARE_SUBMIT"}
        if has(r"(사람|상담원|상담사).*(도움|연결|바꿔)|도움\s*요청"):
            return {"type": "HELP_HUMAN"}
        if _WHAT_CAN_I_SAY.search(text):
            return {"type": "WHAT_CAN_I_SAY", "more": bool(_HELP_MORE.search(text))}
        if is_site_name(text) and not ctx.awaitingFieldId:
            return {"type": "OPEN_SITE", "target": text}
        agency = public_service_site(text)
        if agency and not ctx.awaitingFieldId and not has(r"눌러|클릭|링크\s*목록"):
            has_task = any(term in rx(r"\s").sub("", text) for term in agency.services)
            if has_task or has(r"신청|발급|서류|방법|절차|자격|기한|기간|공지|검색|찾아|알려|확인|읽어|뭐가|문의|고객센터"):
                return {"type": "GOAL", "goal": text}
            if has(r"열어|접속|들어가|이동|가\s*줘|켜|띄워"):
                return {"type": "OPEN_SITE", "target": text}
        # "복지로 가서 첫 화면에 뭐가 있는지 알려줘"는 지금 화면이 아니라 그 사이트에 가서 볼 일(아래 목표 규칙)
        elsewhere = goes_to_another_site(text)
        # "국민연금공단 고객센터 전화번호 알려줘": 지사(지역) 찾기가 아니라 그 기관의 대표 연락처 → 그 기관 사이트에서 확인
        if mentions_known_site(text, fuzzy=False) and has(r"고객\s*센터|콜\s*센터|대표\s*(전화|번호)") and has(_GOAL_ASK) and not has(r"지사|가까운|동네"):
            return {"type": "GOAL", "goal": text}
        if not elsewhere and is_place_request(text):
            return {"type": "FIND_PLACE"}
        if not elsewhere and has(
            r"(이|여기|지금|이곳)\s*(사이트|홈페이지|누리집|웹사이트|곳)\S*\s*(뭐|무슨|어떤|뭘|뭐\s*하는)|(무슨|어떤|뭐\s*하는)\s*(사이트|홈페이지|누리집|곳)(이야|야|인가요|예요|이에요|인지)"
        ):
            return {"type": "ABOUT_SITE"}
        if not elsewhere and has(
            r"(화면|페이지).*(설명|읽어|뭐가|뭐\s*있|어떻게\s*생|전체|묘사)|뭐가\s*있어|화면에\s*뭐"
            r"|(?:(이|그|선택한|가리킨)\s*(부분|문구|표시|그림|차트|버튼)|(선택한|가리킨)\s*항목)"
            r".*(설명|무슨\s*뜻|뭐야|뭔가요|뭐예요)"
        ):
            return {"type": "DESCRIBE_SCREEN"}
        if not elsewhere and has(r"(지금|현재|어디).*(단계|화면|위치)|(화면|단계).*(설명|알려|어디)"):
            return {"type": "CURRENT_STEP"}
        # 사이트를 말하고 거기서 찾아 달라면 복지 제도 답(B)보다 그 사이트에서 찾는다:
        # "복지로에서 장애인연금 신청할 때 필요한 서류 확인해줘", "portal2.html에서 이의 신청 기한과 서류를 찾아줘"
        if elsewhere and has(_GOAL_ASK) and not has(r"(눌러|클릭)") and goes_to_another_site(text, fuzzy=False):
            return {"type": "GOAL", "goal": text}
        # 뺀 것("기초연금 말고")은 아래 제도·사이트 판단에 넣지 않는다
        kept = _NOT_THIS.sub("", text)
        # "공식 안내 열어줘": 방금 찾은 제도의 공식 상세(사이트 이름을 말했으면 그 사이트 열기)
        official = _OPEN_OFFICIAL.search(kept)
        if official and not elsewhere and not mentions_known_site(kept):
            ref = f"{official.group('num')}번" if official.group("num") else official.group("name")
            return {"type": "OPEN_OFFICIAL", **({"service": ref} if ref else {})}
        # ---- 맞춤 복지 찾기(Agent B) ----
        num_ref = rx(r"(\d{1,2})\s*번").search(kept)
        name_ref = _SERVICE_REF.search(rx(r"\s+").sub("", kept))
        service_ref = num_ref.group(0) if num_ref else (name_ref.group(1) if name_ref else None)

        def with_service(t: str) -> dict:
            return {"type": t, "service": service_ref} if service_ref is not None else {"type": t}

        if has(r"^(\d{1,2})\s*번\s*(자세히|설명|뭐야|알려|내용)"):
            return with_service("SERVICE_DETAIL")
        if (
            has(r"(자격|받을\s*수\s*있는지|해당(되는지|돼|될까)|대상인지|대상이야)")
            and has(r"(확인|봐|알려|점검|살펴|될까|돼|맞아|야\?|인지)")
            and not has(r"(뭐|어떤|무슨)\s*(복지|혜택|제도)")
        ):
            return with_service("PRECHECK")
        if has(r"신청") and has(r"(준비|서류|뭐가?\s*필요|필요한\s*(것|거|서류|게))"):
            return with_service("PREPARE_APPLY")
        if (
            not mentions_known_site(text)
            and not has(r"(눌러|클릭)")  # "맞춤형 급여 안내 눌러줘"는 화면 조작
            and (
                has(r"(받을\s*수\s*있는|해당\s*되는|나한테\s*맞는|나에게\s*맞는|맞춤|추천).*(복지|혜택|지원|제도|서비스)")
                or has(r"(복지|혜택|지원금?|제도)\s*(을|를|좀|가)?\s*(찾아|추천|뭐\s*있|있을까|알아봐)")
            )
        ):
            return {"type": "DISCOVER"}

        # "크롬 켜줘", "브라우저 열어줘": 사이트 없이 브라우저만
        if has(r"^(크롬|chrome|브라우저|인터넷)\s*(창\s*)?(좀\s*)?(켜|열어|띄워|실행|시작)", I) and not mentions_known_site(text):
            return {"type": "OPEN_BROWSER"}
        # 목표(사이트 + 찾기/알려줘)는 복지 질문 규칙보다 먼저: "네이버에서 오늘 뉴스 알려줘", "복지로 가서 기초연금 신청 방법 찾아줘" → 여러 단계를 알아서
        if mentions_known_site(text) and has(_GO_THERE) and has(_GOAL_ASK):
            return {"type": "GOAL", "goal": text}

        # "쉽게 말해줘", "무슨 말이야?" → 직전 안내를 쉬운 말로 다시(항목 이름이 없을 때만)
        if has(
            r"(쉽게\s*(다시\s*)?(말해|설명|얘기)|무슨\s*말(이야|인지|이에요)|이해가?\s*(안|잘\s*안)\s*(돼|가)|못\s*알아듣|다시\s*(한\s*번\s*)?말해\s*줘|천천히\s*(다시\s*)?말해)"
        ) and not self.mention(text):
            return {"type": "REPHRASE"}
        # "확인한 전화번호를 천천히 읽어줘": 입력 칸 이름이 섞여도 방금 들은 것을 가리키면 다시 말하기
        # 신청서에서 "방금 입력한 주소 천천히 읽어줘"는 그 칸 읽기
        if _SLOW_REPEAT.search(text) and _JUST_SAID.search(text) and not (state == "APPLICATION_OPEN" and self.mention(text)):
            return {"type": "REPHRASE"}
        if has(r"(무슨\s*뜻|뜻이|뜻은|의미|설명해|뭘\s*써야|뭐\s*쓰는)") and not _LISTED_SERVICE.search(text):
            m = self.mention(text)
            return {"type": "EXPLAIN", "fieldMention": m} if m else {"type": "EXPLAIN"}
        if has(
            r"(지원\s*대상|신청\s*(방법|절차)|선정\s*기준|소득인정액|자격|받을\s*수\s*있|누가\s*받|얼마\s*(받|나와|줘|지급)|지원\s*금액|지급액|필요한?\s*서류|서식|어디에?\s*문의)"
        ) and not has(r"(눌러|클릭)"):
            return {"type": "POLICY_QUESTION", "topic": text}
        # "지금 신청할 수 있어?"는 신청 시작이 아니라 기간 확인(START_APPLICATION보다 먼저).
        if has(r"(지금|현재).*(신청|접수).*(할\s*수|가능|돼|되나)|(신청|접수)\s*(기간|마감|기한)") and not has(r"(눌러|클릭|열어|시작|도와)"):
            return {"type": "POLICY_QUESTION", "topic": text}
        # "언제 신청을 시작할 수 있는지"는 신청을 시작하라는 말이 아니라 묻는 말
        asks_when = has(r"언제[^.?!]{0,10}신청|(시작|신청)\s*할\s*수\s*있")
        if (has(r"장애인\s*연금") and has(r"(신청|도와)") and not has(r"검색")) or (
            has(r"신청\s*(페이지|화면|서)?\s*(를|을)?\s*(열어|시작|도와)") and not asks_when
        ):
            return {"type": "START_APPLICATION"}

        # 제도 이름 + 질문 형태면 복지 질문(예: "기초연금은 몇 살부터 받아?", "주거급여 신청 방법 알려줘")
        if (
            has(r"(연금|수당|급여|바우처|지원금|장려금|복지|소득인정액|선정기준액)")
            and has(r"(\?|뭐|무엇|어떻게|어디|언제|얼마|몇|되나요|돼|가능|알려\s*줘|궁금)")
            and not has(r"(검색|열어|눌러)")
        ):
            return {"type": "POLICY_QUESTION", "topic": text}

        # ---- 웹 읽기 모드 명령 ----
        search = rx(r"""^(?:(.+?)에서\s*)?["'“‘]?(.+?)["'”’]?\s*(?:을|를)?\s*(?:검색|찾아\s*줘|찾아봐)""").search(text)
        if search and has(r"(검색|찾아)"):
            query = rx(r"^(에서|좀)\s*").sub("", clean_value(search.group(2)), count=1)
            if query:
                site = (search.group(1) or "").strip() or None
                return {"type": "SEARCH", "query": query[:100], **({"site": site} if site else {})}
        if has(r"(뒤로\s*가|이전\s*페이지|돌아가)"):
            return {"type": "PREV"}
        if has(r"(링크|메뉴)\s*(더|나머지|계속)?\s*(목록|뭐|뭐가|알려|읽어|있)"):
            return {"type": "LIST_LINKS", "more": has(r"(더|계속|나머지|다음)")}
        if (has(r"(링크|메뉴|탭|버튼)") and has(r"(눌러|클릭|열어|들어가|선택|가\s*줘)")) or has(r"(눌러|클릭해)"):
            name = rx(r"""["'“”‘’「」]""").sub("", text)
            name = rx(r"\s*(링크|메뉴|탭|버튼)?\s*(을|를|좀)?\s*(눌러|클릭|열어|들어가|선택|가\s*줘)\S*.*$").sub("", name, count=1).strip()
            if name:
                return {"type": "FOLLOW_LINK", "name": name}
        if has(r"(열어|접속|들어가|이동해|가\s*줘|켜\s*줘|띄워)") and (
            mentions_known_site(text) or has(r"(사이트|홈페이지|누리집|웹\s*페이지|모의\s*복지)")
        ):
            return {"type": "OPEN_SITE", "target": text}
        if has(r"(본문|내용|기사|글)\s*(을|를)?\s*(읽어|알려|들려)|(더|계속|이어서)\s*읽어|다음\s*내용") and not has(r"(지금까지|입력한|작성한|쓴)"):
            return {"type": "READ_MAIN", "more": has(r"(더|계속|이어서|다음\s*내용)")}
        if has(r"(지금까지|전체|모든|입력한|작성한|쓴)\s*(내용|것|거|항목)?.*(읽어|알려|요약|확인)") and not self.mention(text):
            return {"type": "REVIEW"}
        # 실제 사이트 입력란: "휴대전화번호 칸에 010… 써줘", "이메일란에 … 입력해줘"
        slot = rx(r"^(.+?)\s*(?:칸|란|입력란|입력\s*칸)\s*에\s*(.+?)\s*(?:을|를)?\s*(?:써|입력해|넣어|적어)\s*(?:줘|주세요|줄래)?$").search(text)
        if slot:
            value = clean_value(slot.group(2))
            if value:
                return {"type": "FILL", "fills": [{"fieldMention": slot.group(1).strip(), "value": value}]}
        if has(r"실거주지.*(달라|다름|다릅니다|따로)"):
            return {"type": "FILL", "fills": [{"fieldMention": "실거주지가 주민등록 주소와 다릅니다", "value": "예"}]}

        # "그 페이지 제목이 뭐야?": 지금 화면 이름. 결과·글의 제목처럼 화면 속 내용을 묻는 말은 아래로(입력 칸 읽기가 아님).
        if not elsewhere and has(r"(페이지|화면)\s*(의\s*)?제목") and not has(r"결과|글|기사"):
            return {"type": "CURRENT_STEP"}
        mention = None if _PAGE_NAME.search(text) and not has(_EDIT_WORD) else self.mention(text)
        if mention:
            edit = rx(r"(수정|고칠|고쳐|바꿀|바꿔|변경|틀렸|잘못)").search(text)
            if edit:
                rest = rx(r"^(수정|고칠|고쳐|바꿀|바꿔|변경|틀렸|잘못)\S*\s*").sub("", text[edit.start() :], count=1)
                rest = rx(r"^[:,]\s*").sub("", rest, count=1)
                value = clean_value(rest)
                if len(value) >= 2:
                    return {"type": "FILL", "fills": [{"fieldMention": mention, "value": value}]}
                return {"type": "EDIT_FIELD", "fieldMention": mention}
            if has(r"(읽어|다시\s*말해|뭐(야|였|라고|지)|뭐로|확인해\s*줘|알려\s*줘)"):
                return {"type": "READ_FIELD", "fieldMention": mention}
            segments = [s for s in rx(r"\s*[,，]\s*|\s+(?:그리고|또)\s+").split(text) if s]
            if len(segments) > 1:
                fills = [self._fill_segment(s) for s in segments]
                if all(fills):
                    return {"type": "FILL", "fills": fills}
            single = self._fill_segment(text)
            if single:
                return {"type": "FILL", "fills": [single]}

        if not ctx.awaitingFieldId or _short(text):
            if _short(text) and has(r"(다음|넘어가|넘겨)"):
                return {"type": "NEXT"}
            if _short(text) and has(r"(이전|뒤로|전\s*단계|앞\s*단계)"):
                return {"type": "PREV"}
        return {"type": "UNKNOWN", "text": text}
