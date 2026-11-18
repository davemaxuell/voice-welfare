"""결정적 한국어 규칙 파서(mock LLM). 의도는 IntentSchema 모양의 dict."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

import regex

from cheongeum.core.jsutil import B, I, rx
from cheongeum.understanding.sites import mentions_known_site


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
    r"(멈춰|멈추|멈춤|중지|중단|그만|정지|스톱|잠깐|취소|" + B + r"(stop|halt)" + B + r"|停止|停下|停一下|别动|暂停|請停|请停|別動|暫停|止めて|止まって|ストップ|やめて|中止)",
    I,
)


def is_stop_utterance(text: str) -> bool:
    """LLM과 무관하게 항상 규칙으로 즉시 판정하는 중단 명령."""
    return bool(STOP_RE.search(text)) and not rx(r"(취소\s*(하지|안)|멈추지\s*마)").search(text)


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
        marked = rx(r"(이)?고\s+(?=(" + field_words + r"|다음|이전|그리고|모의|제출|화면|본문|링크|검색|뒤로))").sub(" ␟ ", marked)
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
        if has(r"(다시\s*시작|재개|계속\s*(해|하자|진행))"):
            return {"type": "RESUME"}
        if has(r"(거절|승인\s*안|하지\s*마|안\s*할래)") or (
            state == "WAITING_FOR_USER_CONFIRMATION" and has(r"^(아니|아뇨|아니요|아니야|틀렸어|취소)")
        ):
            return {"type": "REJECT"}
        if has(r"승인") or (state == "WAITING_FOR_USER_CONFIRMATION" and has(r"^(네|예|응)[,\s]*(접수해|진행해|좋아)?")):
            return {"type": "APPROVE"}
        if has(r"(인증|로그인).*(끝났|완료|했어)"):
            return {"type": "AUTH_DONE"}
        if has(r"(로그인|본인\s*인증|간편\s*인증)"):
            return {"type": "LOGIN"}
        if has(r"(접수|제출)") and has(r"(확인했|확인할게|최종|해\s*줘|해$|할게|하자|진행)"):
            return {"type": "PREPARE_SUBMIT"}
        if has(r"최종\s*확인"):
            return {"type": "PREPARE_SUBMIT"}
        if has(r"(사람|상담원|상담사).*(도움|연결|바꿔)|도움\s*요청"):
            return {"type": "HELP_HUMAN"}
        if has(
            r"(이|여기|지금|이곳)\s*(사이트|홈페이지|누리집|웹사이트|곳)\S*\s*(뭐|무슨|어떤|뭘|뭐\s*하는)|(무슨|어떤|뭐\s*하는)\s*(사이트|홈페이지|누리집|곳)(이야|야|인가요|예요|이에요|인지)"
        ):
            return {"type": "ABOUT_SITE"}
        if has(r"(화면|페이지).*(설명|읽어|뭐가|뭐\s*있|어떻게\s*생|전체|묘사)|뭐가\s*있어|화면에\s*뭐"):
            return {"type": "DESCRIBE_SCREEN"}
        if has(r"(지금|현재|어디).*(단계|화면|위치)|(화면|단계).*(설명|알려|어디)"):
            return {"type": "CURRENT_STEP"}
        # ---- 맞춤 복지 찾기(Agent B) ----
        num_ref = rx(r"(\d{1,2})\s*번").search(text)
        name_ref = _SERVICE_REF.search(rx(r"\s+").sub("", text))
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
        if (
            mentions_known_site(text)
            and has(r"(에서|가서|들어가서|열고|열어서|접속해서)")
            and has(r"(알려|찾아|읽어|확인|보여|있는지|뭐\s*있|정리)")
        ):
            return {"type": "GOAL", "goal": text}

        # "쉽게 말해줘", "무슨 말이야?" → 직전 안내를 쉬운 말로 다시(항목 이름이 없을 때만)
        if has(
            r"(쉽게\s*(다시\s*)?(말해|설명|얘기)|무슨\s*말(이야|인지|이에요)|이해가?\s*(안|잘\s*안)\s*(돼|가)|못\s*알아듣|다시\s*(한\s*번\s*)?말해\s*줘|천천히\s*(다시\s*)?말해)"
        ) and not self.mention(text):
            return {"type": "REPHRASE"}
        if has(r"(무슨\s*뜻|뜻이|뜻은|의미|설명해|뭘\s*써야|뭐\s*쓰는)"):
            m = self.mention(text)
            return {"type": "EXPLAIN", "fieldMention": m} if m else {"type": "EXPLAIN"}
        if has(
            r"(지원\s*대상|신청\s*(방법|절차)|선정\s*기준|소득인정액|자격|받을\s*수\s*있|누가\s*받|얼마\s*(받|나와|줘|지급)|지원\s*금액|지급액|필요한?\s*서류|서식|어디에?\s*문의)"
        ):
            return {"type": "POLICY_QUESTION", "topic": text}
        if (has(r"장애인\s*연금") and has(r"(신청|도와)") and not has(r"검색")) or has(r"신청\s*(페이지|화면|서)?\s*(를|을)?\s*(열어|시작|도와)"):
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

        mention = self.mention(text)
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
