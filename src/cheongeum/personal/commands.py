"""
금고·신청 기록 명령 이해와 기한 알림 문장.
실제 접수 상태는 로그인해야 볼 수 있어 조회하지 않는다. 사용자가 알려 준 신청·기한을 기억했다가 알려 준다.
"""
from __future__ import annotations

from datetime import date, timedelta

from cheongeum.core.jsutil import I, rx
from cheongeum.personal.store import SECRET
from cheongeum.speech.phrasing import speak_date


def vault_key_for_label(label: str) -> str | None:
    """입력 칸 이름 → 금고 항목"""
    lb = rx(r"\s").sub("", label)
    if rx(r"(성명|이름|신청인명|성함)").search(lb):
        return "name"
    if rx(r"(주소|거주지|도로명)").search(lb):
        return "address"
    if rx(r"(연락처|전화|휴대폰|휴대전화|핸드폰|휴대번호)").search(lb):
        return "phone"
    if rx(r"(이메일|전자우편|email)", I).search(lb):
        return "email"
    if rx(r"(생년월일|생일)").search(lb):
        return "birth"
    return None


PART = {
    "name": rx(
        r"(?:이름|성명|성함)\s*(?:은|는|이|가)?\s*([가-힣a-zA-Z ]{2,20}?)(?=\s*(?:이라고|라고|이고|이며|이야|이에요|예요|야|고|,|\.|$|그리고|주소|연락처|전화|이메일|생년월일))"
    ),
    "address": rx(
        r"주소\s*(?:는|은|가)?\s*(.+?)(?=\s*(?:이라고|라고|이고|이며|이야|이에요|예요|고\s|,\s*(?:이름|연락처|전화|이메일|생년월일)|\.|$|그리고))"
    ),
    "phone": rx(r"(?:연락처|전화\s*번호|전화|휴대폰\s*번호|휴대폰)\s*(?:는|은|가)?\s*(0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})"),
    "email": rx(r"(?:이메일|메일)\s*(?:은|는)?\s*([A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.]+)", I),
    "birth": rx(r"(?:생년월일|생일)\s*(?:은|는)?\s*(\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일|\d{4}[-.]\d{1,2}[-.]\d{1,2})"),
}


def parse_vault_values(text: str) -> dict:
    """"내 정보 저장해줘. 이름은 김하늘이고 주소는 부산광역시 …" → 항목들"""
    out: dict = {}
    for key, pattern in PART.items():
        m = pattern.search(text)
        v = rx(r"[.,]$").sub("", m.group(1).strip()) if m and m.group(1) else ""
        if v and not SECRET.search(v):
            out[key] = v
    return out


# Only a direct request to remember labeled personal fields enters the vault.
# Keep the actual field values on this device in every supported language.
_SAVE_REQUEST = {
    "en": rx(r"(?:(?:(?:please|can you|could you|would you)\s+)*(?:save|remember|store|keep)\s+(?:that\s+)?(.+)"
             r"|(.+?)[,.;!]\s*(?:please\s+)?(?:save|remember|store|keep)\s+(?:it|them|this|that))", I),
    "zh": rx(r"(?:(?:请|請)?(?:帮我|幫我)?(?:记住|記住|保存|储存|儲存)(?:一下)?(.+)"
             r"|(?:请|請)?(?:把|将|將)?(.+?)[，。,\s]*(?:请|請)?(?:记住|記住|保存|储存|儲存)(?:下来|下來|一下)?)"),
    "ja": rx(r"(.+?)(?:です|として|と|を)?[。、,\s]*(?:覚えて|覚えといて|保存して|登録して|記憶して)"
             r"(?:おいて)?(?:ください|下さい|ほしい|欲しい)?"),
}
_VAULT_FIELDS = {
    "en": rx(r"(?:^my\s+|(?:,\s*(?:and\s+)?|\s+and\s+)(?:my\s+)?)"
             r"(?:(?P<name>(?:full |legal )?name)|(?P<address>(?:home |street |postal )?address)|"
             r"(?P<phone>phone(?: number)?)|(?P<email>e-?mail(?: address)?)|(?P<birth>date of birth|birthday))"
             r"\b\s*(?:(?:is at|is|as)\b\s*|[:：,]\s*)?", I),
    "zh": rx(r"(?:^我(?:的)?|[，、,和]\s*(?:我的?)?)"
             r"(?:(?P<name>名字|姓名)|(?P<address>地址|住址)|(?P<phone>手机号码?|手機號碼?|电话号码?|電話號碼?)|"
             r"(?P<email>电子邮箱|電子郵箱|邮箱|郵箱)|(?P<birth>出生日期|生日))\s*(?:是|叫|为|為|在|[:：])?\s*"),
    "ja": rx(r"(?:^|[、,と]\s*)(?:私の|わたしの)?"
             r"(?:(?P<name>名前|氏名)|(?P<address>住所)|(?P<phone>電話番号)|(?P<email>メールアドレス)|"
             r"(?P<birth>生年月日|誕生日))\s*(?:は|を|が|[:：])?\s*"),
}
_PRIVATE_FIELD_REFERENCE = {
    "en": rx(r"(?:^(?:the|my|a)\s+|\bas\s+(?:the|my)\s+)(?:(?:full|home|street|postal|legal)\s+)?"
             r"(?:name|address|phone|email|birthday|date of birth|personal (?:information|details))\b", I),
    "zh": rx(r"(?:我的?|作为|作為|当作|當作)(?:我的?)?(?:姓名|名字|住址|地址|生日|电话|電話|邮箱|郵箱|个人信息|個人資訊)"),
    "ja": rx(r"(?:私の|わたしの|を)(?:私の|わたしの)?(?:名前|氏名|住所|電話番号|メールアドレス|誕生日|生年月日|個人情報)"),
}


def foreign_vault_save(text: str) -> tuple[str, dict] | None:
    """Identify the language of the command itself; its name or address can be in another script."""
    text = text.strip().rstrip(".!?。！？").strip()
    for lang, pattern in _SAVE_REQUEST.items():
        if not (request := pattern.fullmatch(text)):
            continue
        fields = next(part.strip() for part in request.groups() if part)
        labels = list(_VAULT_FIELDS[lang].finditer(fields))
        if not labels or labels[0].start() != 0:
            if _PRIVATE_FIELD_REFERENCE[lang].search(fields):
                return lang, {}
            continue
        values = {}
        for index, label in enumerate(labels):
            end = labels[index + 1].start() if index + 1 < len(labels) else len(fields)
            value = fields[label.end():end].strip(" ,，、。")
            if lang == "ja":
                value = value.removesuffix("です")
            if not value or SECRET.search(value):
                return lang, {}
            values[label.lastgroup] = value
        return lang, values
    return None


def _fmt(d: date) -> str:
    return d.isoformat()


def parse_date(text: str, today: date | None = None) -> str | None:
    """"12월 3일", "3일 뒤", "다음 주 금요일"(일부) → YYYY-MM-DD. 지난 날짜면 다음 해."""
    today = today or date.today()
    md = rx(r"(\d{1,2})\s*월\s*(\d{1,2})\s*일").search(text)
    if md:
        d = _js_date(today.year, int(md.group(1)), int(md.group(2)))
        if d < today:
            d = _js_date(today.year + 1, int(md.group(1)), int(md.group(2)))
        return _fmt(d)
    after = rx(r"(\d{1,3})\s*일\s*(뒤|후)").search(text)
    if after:
        return _fmt(today + timedelta(days=int(after.group(1))))
    if rx(r"내일").search(text):
        return _fmt(today + timedelta(days=1))
    if rx(r"모레").search(text):
        return _fmt(today + timedelta(days=2))
    return None


def _js_date(year: int, month: int, day: int) -> date:
    """new Date(y, m-1, d)처럼 넘치는 월·일을 다음으로 넘긴다(예: 2월 30일 → 3월 2일)."""
    y = year + (month - 1) // 12
    m = (month - 1) % 12 + 1
    return date(y, m, 1) + timedelta(days=day - 1)


SERVICE = rx(r"([가-힣]{2,20}(?:연금|수당|급여|바우처|지원금|장려금|지원|사업|감면|할인|보험료))")


def parse_speech_pref(text: str) -> dict | None:
    """말하기 설정 명령 → {'kind': 'speech-…'} 또는 None. 확인 없이 바로 반영한다."""
    t = rx(r"\s+").sub(" ", text).strip()
    if rx(r"(말하기\s*)?(설정|음성\s*설정)\s*(알려|읽어|뭐|확인)").search(t) or rx(r"(말하는\s*속도|답\s*길이|목소리|진행\s*상황)\s*(알려|읽어)").search(t):
        return {"kind": "speech-read"}
    if rx(r"(말하기\s*)?(설정|음성\s*설정)\s*(지워|초기화|기본)").search(t):
        return {"kind": "speech-clear"}
    if rx(r"(진행\s*상황|중간\s*보고).*(말해|알려|켜)|진행\s*상황\s*말해").search(t):
        return {"kind": "speech-set", "values": {"progressSpoken": True}}
    if rx(r"(진행\s*상황|중간\s*보고).*(끄|조용|그만)|조용히\s*해").search(t):
        return {"kind": "speech-set", "values": {"progressSpoken": False}}
    # "그 번호를 다시 천천히 말해줘"는 방금 들은 것을 한 번만 다시 듣는 말: 설정을 바꾸지 않는다
    once = rx(r"다시|(?:번호|그거|그것|이거|부분|내용|그\s*말)\s*(?:을|를|만|도)?\s*(?:좀\s*)?(?:더\s*)?(?:천천히|느리게|빨리|빠르게)").search(t)
    if not once and (rx(r"(천천히|느리게)\s*(말해|말해줘|읽어)").search(t) or t in ("천천히", "천천히 말해줘")):
        return {"kind": "speech-set", "values": {"rate": 0.9}}
    if not once and (rx(r"(빨리|빠르게)\s*(말해|말해줘|읽어)").search(t) or t in ("빨리", "빨리 말해줘")):
        return {"kind": "speech-set", "values": {"rate": 1.5}}
    if rx(r"(보통\s*속도|원래\s*속도|속도\s*원래)").search(t):
        return {"kind": "speech-set", "values": {"rate": 1.25}}
    if rx(r"(짧게|간단히|짧게만)\s*(말해|말해줘|답)").search(t) or t in ("짧게", "짧게 말해줘"):
        return {"kind": "speech-set", "values": {"length": "short"}}
    if rx(r"(자세히|길게|자세히만)\s*(말해|말해줘|답)").search(t) or t in ("자세히", "자세히 말해줘"):
        return {"kind": "speech-set", "values": {"length": "detailed"}}
    if rx(r"(보통\s*길이|답\s*길이\s*원래)").search(t):
        return {"kind": "speech-set", "values": {"length": "normal"}}
    vm = rx(r"목소리\s*(?:는|을|를)?\s*(.+?)(?:으로|로)?\s*(?:해\s*줘|해줘|바꿔|변경)?$").search(t)
    if vm and not rx(r"(알려|읽어|뭐)").search(t):
        name = vm.group(1).strip()
        if name in ("기본", "원래", "기본값"):
            return {"kind": "speech-set", "values": {"voice": None}}
        if 1 < len(name) <= 40:
            return {"kind": "speech-set", "values": {"voice": name}}
    return None


def parse_personal_command(text: str) -> dict | None:
    """금고·신청 기록·말하기 설정·오늘 한 일 명령인지(규칙). 아니면 None. → {'kind': ...}"""
    t = rx(r"\s+").sub(" ", text).strip()
    speech = parse_speech_pref(t)
    if speech:
        return speech
    if rx(r"(오늘\s*)?(한\s*일|한\s*거|조작\s*기록|행동\s*기록)\s*(들려|알려|읽어)|오늘\s*(뭐\s*했|한\s*일)").search(t):
        return {"kind": "action-log-read"}
    if rx(r"(정보\s*공유|사이트\s*허용|허용한\s*사이트|공유\s*허용).*(알려|읽어|뭐|목록)").search(t) or rx(r"어느\s*사이트.*(정보|허용)").search(t):
        return {"kind": "site-allow-read"}
    if rx(r"(정보\s*공유|사이트\s*허용|허용한\s*사이트).*(지워|삭제|취소|초기화)").search(t):
        return {"kind": "site-allow-clear"}
    # 묻는 말("기초연금 12월 25일까지 신청해야 해?", "신청했어?")은 기록 명령이 아니다
    asking = bool(rx(r"\?$|(해야\s*(해|돼|하나|되나)|언제|되나요|했나|했어\?|했나요)").search(t))
    # 금고
    mine = rx(r"(내|제|저장된|저장한)\s*(개인\s*)?정보").search(t)
    if mine and rx(r"(지워|삭제|없애)").search(t):
        return {"kind": "vault-clear"}
    if mine and rx(r"(알려|읽어|뭐|확인)").search(t) and not rx(r"(저장해|기억해)").search(t):
        return {"kind": "vault-read"}
    if rx(r"(저장|기억|등록)\s*(해|해줘|해\s*줘|해\s*주세요|할래)").search(t) and rx(r"(정보|이름|성명|주소|연락처|전화|이메일|생년월일)").search(t):
        return {"kind": "vault-save", "values": parse_vault_values(t)}
    # 신청 기록
    if rx(r"(신청\s*(한|했던)\s*(거|것|제도|내역)|신청\s*(현황|내역|목록)|접수\s*(상태|현황)|어떻게\s*됐)").search(t):
        return {"kind": "app-status"}
    if asking:
        return None
    due = parse_date(t)
    if due and rx(r"(보완|서류|제출|마감|기한|까지)").search(t):
        sm = SERVICE.search(t)
        return {
            "kind": "app-due",
            "service": sm.group(1) if sm else None,
            "dueDate": due,
            "note": "보완 서류 제출" if rx(r"보완").search(t) else "제출 기한",
        }
    if rx(r"(결과\s*(나왔|받았)|지급\s*(됐|받았)|처리\s*(됐|끝났)|선정\s*됐)").search(t):
        sm = SERVICE.search(t)
        return {"kind": "app-done", "service": sm.group(1) if sm else None}
    applied = rx(r"(.+?)\s*(?:을|를)?\s*(?:신청|접수)\s*(?:했어|했어요|했다|했습니다|완료했|마쳤|끝냈)").search(t)
    if applied:
        sm = SERVICE.search(applied.group(1))
        service = sm.group(1) if sm else rx(r"^(나|저|방금|오늘|어제|드디어)\s*").sub("", applied.group(1)).strip()
        rm = rx(r"(?:접수|신청)\s*번호\s*(?:는|은|가)?\s*([0-9A-Za-z-]{4,30})").search(t)
        if 2 <= len(service) <= 30:
            return {"kind": "app-record", "service": service, "receiptNo": rm.group(1) if rm else None}
    return None


def days_until(date_str: str, today: date | None = None) -> int:
    """오늘 기준 남은 날"""
    today = today or date.today()
    y, m, d = (int(x) for x in date_str.split("-"))
    return (date(y, m, d) - today).days


def due_reminder(apps: list[dict], today: date | None = None) -> str | None:
    """기한이 3일 이내(지난 것 포함)인 신청 알림. 없으면 None."""
    soon = [a for a in apps if not a.get("done") and a.get("dueDate") and days_until(a["dueDate"], today) <= 3]
    if not soon:
        return None
    out = []
    for a in soon:
        left = days_until(a["dueDate"], today)
        when = f"{-left}일 지났어요" if left < 0 else "오늘까지예요" if left == 0 else f"{left}일 남았어요"
        out.append(f"{a['service']} {a.get('dueNote') or '기한'}이 {speak_date(a['dueDate'])}까지, {when}.")
    return " ".join(out)
