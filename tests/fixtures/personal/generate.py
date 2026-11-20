"""
Writes the expected values for the personal package's table-driven tests by running the Python reference (77aad3e).

Run it with the Python reference environment, never with the owner's checkout. Point the data folders at a scratch
folder first so nothing touches a real profile or the Windows credential store:
  cd <pyref worktree> && uv run --frozen python -I <this file>
It writes one JSON file per module next to this script. The Vitest files under tests/unit read them.
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

import httpx

from cheongeum.core.dialogue import DialogueState
from cheongeum.personal import commands
from cheongeum.personal import dialogue as personal_dialogue
from cheongeum.personal import guardian as guardian_module
from cheongeum.personal.store import PersonalStore

OUT = Path(__file__).resolve().parent
CORPUS = json.loads((OUT.parent / "regex" / "corpus.json").read_text(encoding="utf-8"))
sys.stdout.reconfigure(encoding="utf-8")

# letters Python's IGNORECASE folds in ways JavaScript's does not (İ and ı for i, the long s, the Kelvin sign)
LATIN_SPECIALS = {"i": "\u0130\u0131", "I": "\u0130\u0131", "k": "\u212a", "K": "\u212a", "s": "\u017f", "S": "\u017f"}
SPACES = ["\u3000", "\n", "\x1f", "\x1c", "\u00a0", "\u0085"]
TAILS = [".", "。", "？", "?!"]


def unique(items):
    return list(dict.fromkeys(items))


def write(name, data):
    """One row per line so a changed expectation shows up as a one-line diff."""
    lines = []
    for key, value in data.items():
        if isinstance(value, list):
            rows = ",\n".join("  " + json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in value)
            lines.append(f"{json.dumps(key)}:[\n{rows}\n]")
        else:
            lines.append(f"{json.dumps(key)}:{json.dumps(value, ensure_ascii=False, separators=(',', ':'))}")
    (OUT / name).write_text("{\n" + ",\n".join(lines) + "\n}\n", encoding="utf-8", newline="\n")
    print(name, {k: len(v) for k, v in data.items() if isinstance(v, list)})


def latin(text):
    """Case variants, the letters Python folds specially, and fullwidth Latin."""
    out = [text, text.upper(), text.capitalize(), text.title()]
    for position, char in enumerate(text):
        for special in LATIN_SPECIALS.get(char, ""):
            out.append(text[:position] + special + text[position + 1:])
    out.append("".join(chr(ord(c) + 0xFEE0) if "a" <= c <= "z" else c for c in text))
    return out


def spaced(text):
    out = [text, " " + text + " "]
    if " " in text:
        out += [text.replace(" ", space) for space in SPACES[:2] + SPACES[4:5]]
    return out


def tailed(text):
    return [text] + [text + tail for tail in TAILS]


def variants(text, heavy=False):
    """The seed, punctuation tails and spacing; Latin letter folds only for seeds that have Latin letters."""
    out = tailed(text) + spaced(text)
    if heavy and any("a" <= c.lower() <= "z" for c in text):
        out += latin(text)
    return out


# ------------------------------------------------------------------ commands

SAVE_EN = [
    "Please save my name is Kim Haneul", "save my name is Kim Haneul and my phone is 010-1234-5678",
    "my name is Kim Haneul, please save it", "Remember my address is 10 Yesi-ro, Busan", "can you please remember that my email is a@b.co",
    "could you would you save my phone number is 010 1234 5678", "keep my date of birth as 1950-01-01", "store my full name: Kim Haneul",
    "save my birthday is 1950-01-01", "save my home address at 10 Yesi-ro", "save my legal name is Kim Haneul, and my e-mail is a@b.co",
    "save my name is Kim Haneul, and my phone number: 01012345678, and my email address is a@b.co", "save my name Kim Haneul",
    "save my name is 김하늘", "save my name김하늘", "save my name is", "save my name is ,", "save my name is . ", "save my email is x@y.z.",
    "my name is Kim Haneul. Please save this", "my name is Kim Haneul; save them", "my name is Kim Haneul!please keep it",
    "save the name", "save the address please", "keep my personal information", "remember the personal details",
    "remember this as my name", "store that as my address", "save it as the phone", "save as my email",
    "save my password is 1234", "save my name is 비밀번호 1234", "save my address is [비공개]", "save my phone is 주민번호 900101-1234567",
    "save my name is 인증 번호 123456", "save my address is 카드 번호 1234", "save my name is Kim Haneul 계좌 123",
    "save password", "save my", "save my name and", "save it", "remember", "keep that my name is Kim", "please please save my name is Kim",
    "Save my EMA\u0130L is a@b.co", "SAVE MY NAME IS KIM", "save my ema\u0131l is a@b.co", "save my \u017ftreet address is 10 Yesi-ro",
    "\u212aeep my name is Kim", "keep my name is Kim", "save my name is Kim\u212a", "kee\u212a my name", "save my ph\u0131one is 010",
    "save my phone number is 010 1234 5678 and also my email is a@b.co", "save, my name is Kim", "save my name is Kim Haneul please",
    "remember my name is Kim Haneul as my name", "I want you to save my name is Kim", "what is my name",
    "save　my name is Kim", "save my name is Kim", "save\x1fmy name is Kim", "save\x1cmy name is Kim", "save\tmy\tname\tis\tKim",
    "save my name\nis Kim", "save my name is Kim\r\nHaneul", "save my name is Kim Haneul", "save my name is Kim Haneul",
    "save my name is Kim\rHaneul", "save my phone is ０１０１２３４５６７８", "save my phone is 010１２３４5678", "save my phone is ٠١٠١٢٣٤٥٦٧٨",
    "save my phone is 𝟎𝟏𝟎", "save my name is 😀", "😀save my name is Kim", "save my name is Kim😀", "save my name is café",
    "save my name isn't Kim", "save my name is-Kim", "save my name:Kim", "save my name : Kim", "save my name,Kim", "save my address as 10 Yesi-ro",
    "save my address is at 10 Yesi-ro", "save my address is at", "save my name is atKim", "save my name isat Kim",
    "save my email is a@b.co and my name is Kim", "save my phone and my name", "save my name, my address, my phone", "", " ", "save", "save ",
]
SAVE_ZH = [
    "请记住我的名字是金夏兰", "请保存我的地址是釜山", "把我的电话号码是01012345678记住", "我的邮箱是a@b.co，请记住", "请帮我记住我的生日是1950年1月1日",
    "記住我的名字是金夏蘭", "請幫我保存我的手機號碼是01012345678", "把我的姓名是金夏兰，我的地址是釜山保存下来", "将我的名字叫金夏兰请记住一下",
    "请记住一下我的名字是金夏兰", "我的名字是金夏兰，请保存", "我的名字是金夏兰，和我的电话是01012345678，请记住", "请记住我的名字", "请记住",
    "记住我的名字是 金夏兰 ", "请储存我的住址在釜山", "請儲存我的電話號碼為01012345678", "保存我的电子邮箱是a@b.co", "请保存名字", "请保存我的名字是密码",
    "请记住作为我的姓名", "请记住当作我的地址", "把我的个人信息记住", "我的名字是金夏兰", "请记住我的名字是金夏兰。", "请记住我的名字是金夏兰！",
    "请记住我的名字是 ０１０", "请记住我的电话是０１０１２３４５６７８", "请记住我的名字是😀", "请记住我的名字是金夏兰、我的地址是釜山",
    "请记住我的名字是金夏兰和我的地址是釜山", "请记住我的名字是金夏兰,我的电话是010", "请记住我的名字是金夏兰 请记住", "请 记住 我的名字是金夏兰",
    "请记住我的名字是[비공개]", "请记住我的名字是주민번호", "请记住我的邮箱是", "请记住我的名字是，", "请记住我的名字叫金夏兰", "请记住我的名字为金夏兰",
    "请记住我的名字在釜山", "请记住我的名字：金夏兰", "请记住我的名字:金夏兰", "请记住我的生日 1950", "请记住我的出生日期是1950年1月1日",
]
SAVE_JA = [
    "私の名前は金ハヌルです。覚えてください", "住所は釜山です、保存して", "私の電話番号は01012345678です。登録してください", "メールアドレスは a@b.co です、覚えておいて",
    "私の名前は金ハヌル、住所は釜山、覚えて", "名前を覚えて", "私の名前は金ハヌルとして保存して", "わたしの氏名は金ハヌルを記憶して", "私の生年月日は1950年1月1日です。保存してほしい",
    "私の誕生日は1月1日です、覚えて欲しい", "覚えて", "私の名前は金ハヌルです 覚えといて", "私の名前は金ハヌルと覚えてください", "私の名前は金ハヌルを登録して下さい",
    "私の名前は金ハヌルです、私の住所は釜山です、覚えて", "私の名前は金ハヌルですです、覚えて", "私の名前は です、覚えて", "私の名前は、覚えて", "私のパスワードは1234です、覚えて",
    "私の名前は住民番号です、覚えて", "私の名前は[비공개]です、覚えて", "名前は金ハヌルです。覚えてください。", "名前は金ハヌルです。覚えてください！", "名前は金ハヌルです。覚えてください？",
    "私の電話番号は０１０１２３４５６７８です、覚えて", "私の名前は😀です、覚えて", "私の名前は金ハヌルです　覚えて", "私の名前は金ハヌル　覚えて", "私の名前を覚えて",
    "を覚えて", "私の名前は金ハヌルです、覚えておいてください", "私の名前は金ハヌルです、覚えておいてほしい", "私の名前は金ハヌルです、覚えてもらえますか", "今日の天気は？",
    "私のメールアドレスは a@b.co を保存して", "私の住所は釜山、電話番号は01012345678、登録して", "私の住所は釜山と私の電話番号は01012345678、登録して",
]
SAVE_EXTRA = [
    "save my name is Kim Haneul. , my phone is 010", "save my name is Kim , and my phone is 01012345678", "save my name is Kim,, my phone is 010",
    "save my name is , Kim", "save my name is ，Kim", "save my name is 、Kim。 ", "save my name is Kim 。, and my email is a@b.co",
    "请记住我的名字是金夏兰。，我的电话是01012345678", "请记住我的名字是金夏兰 ，我的电话是01012345678", "请记住我的名字是金夏兰，、我的地址是釜山",
    "请记住我的名字是，金夏兰", "请记住我的名字是 、金夏兰。 ，我的地址是釜山", "请记住我的名字是金夏兰。我的地址是釜山",
    "私の名前は金ハヌル。、住所は釜山、覚えて", "私の名前は、金ハヌルです、住所は釜山です。、覚えて", "私の名前は金ハヌルです、、住所は釜山",
    "私の名前は金ハヌルです。 、私の電話番号は01012345678、覚えて",
    "\u0085save my name is Kim", "save my name is Kim\u0085", "save\u0085my name is Kim", "﻿save my name is Kim", "save my name is Kim﻿",
    "save﻿my name is Kim", "save my name is\u0085Kim", "save my name is Kim\u0085, my phone is 010", "请记住\u0085我的名字是金夏兰", "请记住我的名字是金夏兰\u0085",
    "﻿请记住我的名字是金夏兰", "私の名前は金ハヌルです\u0085覚えて", "save my name is Kim", "save my name is Kim Haneul", "save my name is Kim Haneul",
]
SAVE_KO = [
    "내 이름은 김하늘이라고 저장해줘", "내 정보 저장해줘", "이름 기억해", "save 내 이름은 김하늘", "기억해 줘", "저장", "보호자 김하늘 전화번호 공일공 일이삼사 오육칠팔 등록해줘",
    "내 이름은 Kim 이야 save it", "remember 김하늘", "覚えて 김하늘", "请记住 김하늘",
]
SPEECH = [
    "천천히 말해줘", "천천히 말해 줘", "천천히", "천천히 읽어줘", "느리게 말해줘", "느리게 읽어", "빨리 말해줘", "빨리", "빠르게 읽어줘", "빠르게 말해",
    "그 번호를 다시 천천히 말해줘", "다시 천천히 말해줘", "다시 빨리 말해줘", "다시 한번 천천히 읽어줘", "번호 천천히 말해줘", "번호를 천천히 말해줘", "번호만 천천히 읽어줘",
    "번호도 빨리 말해줘", "그거 천천히 말해줘", "그것 좀 천천히 말해줘", "이거 좀 더 천천히 말해줘", "이거를 좀더 천천히 읽어줘", "부분을 천천히 말해줘", "부분 좀 더 빠르게 말해줘",
    "내용 천천히 말해줘", "내용을 좀 더 느리게 읽어줘", "그 말 천천히 읽어줘", "그말 천천히 읽어줘", "그 말을 빨리 말해줘", "그 말을　천천히 읽어줘", "그\x1f말을 천천히 읽어줘",
    "앞으로 천천히 말해줘", "앞으로는 천천히 말해줘", "이제부터 천천히 말해줘", "목소리 천천히 말해줘", "번호는 천천히", "번호를 다시", "다시", "다시 읽어줘",
    "속도는 보통 속도", "보통 속도로", "원래 속도로 말해줘", "속도 원래", "짧게 말해줘", "짧게", "간단히 답해", "자세히 말해줘", "자세히", "길게 답해줘", "보통 길이", "답 길이 원래",
    "진행 상황 말해줘", "진행 상황 알려줘", "진행 상황 켜줘", "중간 보고 꺼줘", "진행 상황 그만", "조용히 해", "조용히 해줘", "말하기 설정 알려줘", "말하기 설정 초기화", "음성 설정 지워줘",
    "목소리는 기본으로 해줘", "목소리는 차분한 목소리로 바꿔", "목소리 알려줘", "목소리를 원래로", "목소리는 기본값", "목소리 가", "목소리는 아주아주아주아주아주아주아주아주아주아주아주아주아주아주아주 긴 이름 목소리로",
    "말하는 속도 알려줘", "답 길이 읽어줘", "빨리 오세요", "느리게 걸어", "천천히 해줘", "빨리 해줘", "천천히  말해줘", "  천천히   말해줘  ", "천천히\n말해줘", "천천히\r\n말해줘",
]


# one character from each member of Python's \w (letter, digit, mark, connector, join control) and a few that are not
GLUE = ["1", "１", "_", "‿", "́", "‍", "‌", "가", "x", "-", ".", "·", "☃", "　", "٠"]


def boundary_seeds():
    """A character glued to the end of a field word decides the unicode word boundary \\b."""
    out = []
    for glue in GLUE:
        out += [f"save my name{glue} is Kim", f"save my name is{glue} Kim", f"save my name as{glue} Kim", f"save my name is at{glue} Kim",
                f"save the name{glue}", f"save the personal details{glue}", f"save the phone number{glue}", f"save {glue}as my name",
                f"save it{glue}as my name", f"save my e-mail{glue} is a@b.co", f"save my date of birth{glue} is 1950-01-01"]
    return out


def commands_fixture():
    seeds = boundary_seeds()
    for index, text in enumerate(SAVE_EN):
        seeds += variants(text, heavy=index % 3 == 0)
    for index, text in enumerate(SAVE_ZH + SAVE_JA + SAVE_KO + SAVE_EXTRA):
        seeds += variants(text, heavy=False)
    texts = unique(seeds)
    foreign = []
    for text in texts:
        found = commands.foreign_vault_save(text)
        foreign.append([text, None if found is None else [found[0], found[1]]])
    # the corpus is only recorded where Python answers; the test replays it all and expects None elsewhere
    foreign_corpus = [[text, list(found)] for text in CORPUS if (found := commands.foreign_vault_save(text)) is not None]
    speech = []
    for text in unique(sum((variants(text) for text in SPEECH), [])):
        speech.append([text, commands.parse_speech_pref(text), commands.parse_personal_command(text)])
    return {"foreignVaultSave": foreign, "foreignVaultSaveCorpus": foreign_corpus, "speechPrefs": speech}


# ------------------------------------------------------------------ dialogue

LANGS = ("ko", "en", "zh", "ja")
KINDS = ("vault-save", "vault-clear")
REPLIES = [
    "응", "네", "예", "어", "맞아", "맞아요", "그래", "그래요", "좋아", "응 저장해줘", "저장해", "저장해줘", "저장해 줘", "저장해주세요", "저장해 주세요", "기억해줘", "기억해",
    "지워", "지워줘", "지워 줘", "지워주세요", "삭제해", "삭제해줘", "삭제해 줘", "네, 저장해줘", "응, 지워줘", "응 지워", "응,저장해", "네 삭제해줘", "예 기억해 주세요",
    "승인", "승인합니다", "네 승인", "예, 승인할게요", "모의접수 승인", "눌러줘", "진행해", "아니", "아니요", "아뇨", "아니야", "싫어", "거절", "취소", "됐어", "하지 마", "하지마",
    "하지 마세요", "하지마요", "지우지 마", "지우지마세요", "저장하지 마", "기억하지 마요", "삭제하지 마", "저장하지 않아", "응 그런데 이름이 뭐야?", "저장해도 돼?", "네?", "응？",
    "글쎄", "잘 모르겠어", "저장해줘 그리고 지워줘", "응 맞아 저장해줘", "네 그래 저장해줘", "yes", "no", "예스", "넵", "ㅇㅇ", "ok", "그래 저장해", "그만", "아니 저장하지 마",
    "승인 안 해", "승인 안해", "맞아 저장해줘", "응 응", "네네", "네 네", "저장해줘요", "지워줘요", "저장", "지워", "응~", "네~~", "네!", "응.", "응！", "예。", "",
    "Yes", "yes please", "Yes, go ahead", "ok", "okay", "sure", "approve", "I approve", "confirm", "do it", "proceed", "no", "nope", "cancel", "reject", "don't", "dont",
    "not now", "no thanks", "save it", "yes save it", "yes?", "what?", "maybe", "Yes.", "yes!", "YES", "no.", "Cancel!", "yeah", "yep",
    "是", "是的", "好", "好的", "对", "确认", "同意", "批准", "继续", "不", "不要", "取消", "拒绝", "算了", "保存吧", "是吗？", "好的。", "不要取消",
    "はい", "ええ", "うん", "承認します", "お願いします", "いいえ", "いや", "やめて", "キャンセル", "結構です", "保存して", "はい。", "いいえ！", "進めてください",
]
CONTACT = {"name": "홍길동", "phone": "01011223344"}
FULL = {"name": "김하늘", "address": "부산광역시 예시구 예시로 10", "phone": "010-1234-5678"}


def vault_reply_fixture():
    rows = []
    for index, text in enumerate(REPLIES):
        for variant in unique(variants(text, heavy=index % 2 == 0)):
            answers = {f"{kind[6:]}.{lang}": result for kind in KINDS for lang in LANGS
                       if (result := personal_dialogue.vault_reply(variant, kind, lang)) is not None}
            rows.append([variant, answers])
    return rows


def scenario_list():
    out = []

    def add(name, lang, steps, persistent=False, setup=None):
        out.append({"name": name, "persistent": persistent, "lang": lang, "setup": setup or {}, "steps": steps})

    for lang in LANGS:
        for persistent in (False, True):
            add("save, confirm yes, read", lang, [{"run": {"kind": "vault-save", "values": FULL}}, {"confirm": True}, {"run": {"kind": "vault-read"}}], persistent)
        add("save, confirm no", lang, [{"run": {"kind": "vault-save", "values": {"email": "a@b.co", "birth": "1950-01-01"}}}, {"confirm": False}, {"run": {"kind": "vault-read"}}])
        add("save with nothing to save", lang, [{"run": {"kind": "vault-save", "values": {}}}])
        add("read empty", lang, [{"run": {"kind": "vault-read"}}])
        add("read call name only", lang, [{"run": {"kind": "vault-read"}}], setup={"callName": "홍길동"})
        add("read call name with nim", lang, [{"run": {"kind": "vault-read"}}], setup={"callName": "길동님"})
        add("read vault and call name", lang, [{"run": {"kind": "vault-read"}}], setup={"vault": FULL, "callName": "홍길동"})
        add("braces and dollar signs in values", lang, [{"run": {"kind": "vault-save", "values": {"name": "{entries}", "address": "{0} {} $& $1"}}},
                                                        {"confirm": True}, {"run": {"kind": "vault-read"}}])
        add("clear empty", lang, [{"run": {"kind": "vault-clear"}}])
        for label, setup in (("vault", {"vault": FULL}), ("guardian only", {"guardian": CONTACT}), ("call name only", {"callName": "홍길동"})):
            add(f"clear {label}, confirm yes", lang, [{"run": {"kind": "vault-clear"}}, {"confirm": True}, {"run": {"kind": "vault-read"}}], persistent=True, setup=setup)
            add(f"clear {label}, confirm no", lang, [{"run": {"kind": "vault-clear"}}, {"confirm": False}], persistent=True, setup=setup)
    add("confirm no without anything pending", "ko", [{"confirm": False}])
    add("confirm yes without anything pending", "ko", [{"confirm": True}])
    pending = {"kind": "guardian-clear", "contact": CONTACT, "at": 1, "resume": "IDLE"}
    add("confirm yes on a guardian question", "ko", [{"ask": pending}, {"confirm": True}])
    add("confirm no on a guardian question", "ko", [{"ask": pending}, {"confirm": False}])
    return out


def describe_pending(pending):
    if pending is None:
        return None
    confirmation = pending.get("confirmation")
    return {**{k: v for k, v in pending.items() if k != "confirmation"},
            "confirmation": None if confirmation is None else {k: v for k, v in confirmation.items() if k != "actionId"}}


def snapshot(store):
    return {"vault": store.vault(), "guardian": store.guardian(), "callName": store.call_name()}


def run_scenario(scenario):
    with tempfile.TemporaryDirectory() as folder:
        path = str(Path(folder) / "personal.json") if scenario["persistent"] else None
        store = PersonalStore(path)
        setup = scenario["setup"]
        if setup.get("vault"):
            store.save_vault(setup["vault"])
        if setup.get("callName"):
            store.set_call_name(setup["callName"])
        if setup.get("guardian"):
            store.set_guardian(setup["guardian"])
        state = DialogueState("IDLE")
        talk = personal_dialogue.PersonalDialogue(store, state)
        steps = []
        for step in scenario["steps"]:
            record = {}
            try:
                if "run" in step:
                    record["draft"] = talk.run(step["run"], lang=scenario["lang"])
                elif "confirm" in step:
                    record["draft"] = talk.confirm(step["confirm"])
                else:
                    state.ask_vault_confirm(step["ask"])
            except Exception:
                record["error"] = True
            record["state"] = state.state
            record["pending"] = describe_pending(state.vault_confirm)
            record["store"] = snapshot(store)
            if path:
                record["reloaded"] = snapshot(PersonalStore(path))
            steps.append(record)
    return {**scenario, "steps": [{**scenario_step, **record} for scenario_step, record in zip(scenario["steps"], steps)]}


def dialogue_fixture():
    return {"vaultReply": vault_reply_fixture(), "scenarios": [run_scenario(scenario) for scenario in scenario_list()]}


# ------------------------------------------------------------------ guardian

GUARDIAN_PHRASES = [
    "보호자한테 연락해줘", "보호자에게 연락해 줘", "보호자께 연락해주세요", "내 보호자한테 도움 요청해줘", "보호자 도움 요청", "보호자 도움요청해", "보호자한테 문자 보내줘",
    "보호자에게 문자메시지를 보내 줘", "보호자 문자 보내줘", "보호자 문자메시지 해줘", "보호자 연락", "보호자한테 연락", "내 보호자 연락해줘", "보호자한테 연락해 주세요",
    "보호자한테 연락 줘", "보호자한테 연락 보내 줘", "보호자 도움 요청 보내 줘", "보호자한테 문자를 보내", "보호자한테 문자를 해", "보호자한테 연락하지 마", "보호자한테 연락하지마",
    "보호자 한테 연락해줘", "내보호자에게 연락해줘", "내　보호자에게　연락해줘", "보호자한테 연락해줘요", "보호자한테 문자 해주세요", "보호자한테 도움 요청 해",
    "보호자 삭제해", "보호자 지워줘", "보호자 정보 삭제해줘", "보호자 연락처를 지워", "내 보호자 번호 삭제해 주세요", "보호자 정보를 지워 줘", "보호자 지워", "보호자 삭제하지 마",
    "보호자 번호 지워주세요", "보호자 연락처 삭제해줘요", "내 보호자 정보 지워줘", "보호자정보삭제해",
    "보호자 김하늘 전화번호 공일공 일이삼사 오육칠팔 등록해줘", "보호자 이름은 이진희이고 전화번호는 010-1122-3344 등록해줘", "보호자 김하늘 전화번호 010 1234 5678 저장해줘",
    "내 보호자 홍길동님 연락처 01011223344 등록해줘", "보호자 홍길동 휴대폰 010-1234-5678 기억해줘", "보호자 이름 홍길동 전화번호 01012345678",
    "보호자 홍길동 전화번호 영일영 일이삼사 오륙칠팔 등록", "보호자 홍길동 전화번호 공일공 일이삼사 오육칠팔이라고 등록해 주세요", "보호자 홍길동의 전화번호는 010 1234 5678로 저장해줘",
    "보호자 홍길동님의 연락처는 01012345678으로 등록해줘", "보호자 홍길동 전화번호 ０１０１２３４５６７８ 등록해줘",
    "보호자 홍길동 전화번호 ٠١٠١٢٣٤٥٦٧٨ 등록해줘", "보호자 홍길동 전화번호 010123456789 등록해줘", "보호자 홍길동 전화번호 0101234567 등록해줘",
    "보호자 홍길동 전화번호 016-123-4567 저장", "보호자 홍길동 전화번호 공일육 일이삼 사오육칠 등록", "보호자 홍길동 전화번호 공일일 일이삼사오육칠팔 등록", "보호자 홍길동 전화번호 영일구 일이삼사오륙칠 등록",
    "보호자 Kim 전화번호 01011223344 등록", "보호자 가나다라마바사아자차카타파하거너 전화번호 01011223344 등록", "보호자 가나다라마바사아자차카타파하거 전화번호 01011223344 등록",
    "보호자 전화번호 01011223344 등록해줘", "보호자 홍길동 전화번호 01011223344", "보호자 홍길동 전화번호 01011223344 등록 해줘", "보호자 홍길동 전화번호 01011223344 등록해 줘",
    "보호자 홍길동 전화번호 01011223344 저장해주세요", "보호자 홍길동 전화번호 01011223344 기억해 주세요", "보호자 홍길동 연락처 010-1122-3344 등록해줘.",
    "보호자 홍길동 연락처 010 1122 3344 등록해줘", "보호자 홍길동 연락처 010　1122　3344 등록해줘", "보호자 홍길동 연락처 010\x1c1122\x1f3344 등록해줘",
    "보호자 홍길동 연락처 010--1122--3344 등록해줘", "보호자 홍길동 연락처 -01011223344- 등록해줘", "보호자 홍길동 전화번호 01011223344라고 등록해줘", "보호자 홍길동 전화번호 01011223344으로 저장해줘",
    "보호자 홍길동 전화 번호 01011223344 등록", "보호자홍길동전화번호01011223344등록", "보호자 홍길동, 전화번호 01011223344 등록", "보호자 홍길동 , 연락처 01011223344 등록",
    "보호자 등록해줘", "보호자 저장해줘", "내 보호자 기억해", "보호자 이름은 홍길동", "보호자 번호는 0101", "보호자 정보 등록", "보호자 연락처 등록해줘", "보호자 홍길동 등록해줘",
    "보호자 번호 123", "보호자 이름 철수 번호 1", "보호자 홍길동 전화번호 등록해줘", "보호자 홍길동 전화번호 오육 등록", "보호자 이름 홍길동 연락처 0",
    "보호자", "보호자는 누구야", "내 보호자가 누구지", "보호자 정보 알려줘", "보호자에게 알려줘", "보호자 이름", "보호자에 대해", "내 정보 알려줘", "", "보호자님", "그 보호자 연락해줘",
    "내 보호자한테 연락해줘 그리고 삭제해줘", "보호자한테 연락해줘 지금 바로", "보호자 한테 연락", "연락해줘 보호자한테", "보호자 연락처 홍길동", "보호자에게 연락처를 알려줘",
]
ENVIRONMENTS = [
    {}, {"GUARDIAN_SMS_PROVIDER": "mock"}, {"GUARDIAN_SMS_PROVIDER": " MOCK "}, {"GUARDIAN_SMS_PROVIDER": ""}, {"GUARDIAN_SMS_PROVIDER": "   "}, {"SOLAPI_API_KEY": "key"},
    {"GUARDIAN_SMS_PROVIDER": "solapi"}, {"GUARDIAN_SMS_PROVIDER": "twilio", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "0212345678"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "02-1234-5678"},
    {"GUARDIAN_SMS_PROVIDER": " Solapi ", "SOLAPI_API_KEY": " key ", "SOLAPI_API_SECRET": "\tsecret\n", "SOLAPI_SENDER_NUMBER": " 02-1234-5678 "},
    {"GUARDIAN_SMS_PROVIDER": "SOLAPI", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "021234567"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "01012345678"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "1234567"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "123456789012"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "０２１２３４５６７８"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "02 1234 5678"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "02-1234-5678\n"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "", "SOLAPI_API_SECRET": "secret", "SOLAPI_SENDER_NUMBER": "0212345678"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "  ", "SOLAPI_SENDER_NUMBER": "0212345678"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "key", "SOLAPI_API_SECRET": "secret"},
    {"GUARDIAN_SMS_PROVIDER": "solapi", "SOLAPI_API_KEY": "한글키", "SOLAPI_API_SECRET": "비밀", "SOLAPI_SENDER_NUMBER": "0212345678"},
]
VIEW_A = {"url": "https://example.kr/a", "title": "신청서", "step": {"index": 1, "total": 3}, "fields": [{"fieldId": "name", "label": "이름", "value": "김하늘"}], "status": "ready"}
VIEW_B = {**VIEW_A, "url": "https://example.kr/b"}
DIGEST_VIEWS = [
    {}, VIEW_A, VIEW_B, {**VIEW_A, "ignored": "not part of the digest", "pageId": "x"}, {"url": None}, {"url": "https://example.kr/한글", "title": "제목 ☃ \U0001f600"},
    {"fields": [], "dialogs": [], "errors": [], "outline": {"items": [], "mainText": "본문"}}, {"step": 0, "status": "", "errors": [""]}, {"outline": {"a": 1.5, "b": [1, 2, {"c": None}]}},
    {"title": "quote \" and backslash \\ and \x1f control and   separator"}, {"url": "a", "title": "b", "step": "c", "fields": "d", "dialogs": "e", "status": "f", "outline": "g", "errors": "h"},
]
HONG = {"name": "홍길동", "phone": "01011223344"}
KIM = {"name": "김하늘", "phone": "01099887766"}


class RecordingSender:
    def __init__(self, preview, result):
        self.preview = preview
        self.result = result
        self.calls = []

    async def send(self, phone, message):
        self.calls.append([phone, message])
        return self.result


def probe_send(sender):
    """Send once through a mock transport that accepts everything, as tests/conftest.py's http_mock does."""
    calls = []

    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"failedMessageList": [], "groupInfo": {"count": {"registeredSuccess": 1}}})

    original = httpx.AsyncClient.__init__

    def init(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handle)
        original(self, *args, **kwargs)

    httpx.AsyncClient.__init__ = init
    try:
        result = asyncio.run(sender.send("01012345678", "m"))
    finally:
        httpx.AsyncClient.__init__ = original
    return {"result": result, "calls": len(calls)}


def sender_summary(sender):
    if sender is None:
        return None
    if isinstance(sender, guardian_module.PreviewSender):
        return {"kind": "preview"}
    return {"kind": "solapi", "key": sender.key, "secret": sender.secret, "number": sender.sender_number, "send": probe_send(sender)}


def guardian_scenarios():
    out = []

    def add(name, steps, guardian=None, sender="preview", result="preview"):
        out.append({"name": name, "guardian": guardian, "sender": sender, "result": result, "steps": steps})

    def ask(cmd, view=VIEW_A, now=10, resume="BROWSING"):
        return {"ask": cmd, "view": view, "now": now, "resume": resume}

    def approve(view=VIEW_A, now=20, ttl=120):
        return {"approve": {"view": view, "now": now, "ttl": ttl}}

    take = {"take": True}
    save = {"kind": "guardian-save", "contact": HONG}
    add("save, take, approve", [ask(save), take, approve()])
    add("save, take, approve after the time limit", [ask(save), take, approve(now=200)])
    add("save, take, approve exactly at the time limit", [ask(save), take, approve(now=130)])
    add("save replaces an older contact", [ask(save), take, approve()], guardian=KIM)
    add("clear, take, approve", [ask({"kind": "guardian-clear"}), take, approve()], guardian=HONG)
    add("clear, but the contact changed meanwhile", [ask({"kind": "guardian-clear"}), take, {"setGuardian": KIM}, approve()], guardian=HONG)
    add("clear with nothing stored", [ask({"kind": "guardian-clear"})])
    add("help", [ask({"kind": "guardian-help"})])
    add("send with nothing stored", [ask({"kind": "guardian-send"})])
    add("send with no sender configured", [ask({"kind": "guardian-send"})], guardian=HONG, sender="none")
    for kind, result in (("preview", "preview"), ("live", "accepted"), ("live", "failed"), ("live", "unknown")):
        add(f"send, take, approve ({kind} sender answers {result})", [ask({"kind": "guardian-send"}), take, approve()], guardian=HONG, sender=kind, result=result)
    add("send, but the screen changed", [ask({"kind": "guardian-send"}), take, approve(view=VIEW_B)], guardian=HONG, sender="live", result="accepted")
    add("send, approved exactly at the time limit", [ask({"kind": "guardian-send"}), take, approve(now=130)], guardian=HONG, sender="live", result="accepted")
    add("send, approved just before the time limit", [ask({"kind": "guardian-send"}), take, approve(now=129)], guardian=HONG, sender="live", result="accepted")
    add("send, approved after the time limit", [ask({"kind": "guardian-send"}), take, approve(now=500)], guardian=HONG, sender="live", result="accepted")
    add("send, the stored contact changed meanwhile", [ask({"kind": "guardian-send"}), take, {"setGuardian": KIM}, approve()], guardian=HONG, sender="live", result="accepted")
    add("send, the stored contact was cleared meanwhile", [ask({"kind": "guardian-send"}), take, {"setGuardian": None}, approve()], guardian=HONG, sender="live", result="accepted")
    add("send with a contact given in the question", [ask({"kind": "guardian-send", "contact": KIM}), take, approve()], guardian=HONG, sender="live", result="accepted")
    add("take with nothing pending", [take])
    add("take leaves another kind of question alone", [{"askVault": {"kind": "vault-clear"}}, take])
    add("take puts the state back to where the question was asked", [ask(save, resume="AUTH_HANDOFF"), take])
    return out


def copy_pending(pending):
    """A vault question carries a random action id, which is dropped so the fixture is the same on every run."""
    if pending is None:
        return None
    copy = dict(pending)
    if copy.get("confirmation"):
        copy["confirmation"] = {k: v for k, v in copy["confirmation"].items() if k != "actionId"}
    return copy


def run_guardian_scenario(scenario):
    with tempfile.TemporaryDirectory() as folder:
        store = PersonalStore(str(Path(folder) / "personal.json"))
        if scenario["guardian"]:
            store.set_guardian(scenario["guardian"])
        sender = {"none": None, "preview": RecordingSender(True, "preview"), "live": RecordingSender(False, scenario["result"])}[scenario["sender"]]
        state = DialogueState("IDLE")
        talk = guardian_module.GuardianDialogue(store, state, sender)
        taken = None
        steps = []
        for step in scenario["steps"]:
            record = {}
            if "ask" in step:
                record["draft"] = talk.ask(step["ask"], step["view"], step["now"], step["resume"])
            elif "take" in step:
                taken = talk.take_pending()
                record["taken"] = copy_pending(taken)
            elif "approve" in step:
                options = step["approve"]
                record["draft"] = asyncio.run(talk.approved(taken, options["view"], options["now"], options["ttl"]))
            elif "setGuardian" in step:
                store.set_guardian(step["setGuardian"])
            else:
                state.ask_vault_confirm(step["askVault"])
            record["state"] = state.state
            record["pending"] = copy_pending(state.vault_confirm)
            record["guardian"] = store.guardian()
            record["calls"] = None if sender is None else list(sender.calls)
            steps.append({**step, **record})
    return {**scenario, "steps": steps}


# every spoken digit word inside a registration that ends properly, so each word's value shows up in the phone number
SPOKEN_SEEDS = [f"보호자 홍길동 전화번호 공일공 {word * 4} {word * 4} 등록해줘" for word in "영공일이삼사오육륙칠팔구"]
SPOKEN_SEEDS += [f"보호자 홍길동 전화번호 {word}일{word}-{word}{word}{word}{word}-{word}{word}{word}{word}으로 저장해줘" for word in "영공일이삼사오육륙칠팔구"]


# a digit that is not ASCII, with no registration verb, is what decides whether a request counts as an attempt to register
SPOKEN_SEEDS += ["보호자 번호 ０１０１２３４５６７８", "보호자 연락처 ٠١", "보호자 이름 홍길동 번호 １",
                 "보호자 연락처 १२३", "보호자 번호 ๑๒๓", "보호자 이름은 홍길동 이름 ①", "보호자 번호 abc", "보호자 번호 ²"]


def guardian_fixture():
    rows = []
    for index, text in enumerate(GUARDIAN_PHRASES + SPOKEN_SEEDS):
        for variant in unique(variants(text, heavy=False) + ([text.replace(" ", "\x1f")] if " " in text else [])):
            rows.append([variant, guardian_module.guardian_command(variant)])
    corpus = [[text, found] for text in CORPUS if (found := guardian_module.guardian_command(text)) is not None]
    senders = [[env, sender_summary(guardian_module.guardian_sender(env))] for env in ENVIRONMENTS]
    digests = [[view, guardian_module.screen_digest(view)] for view in DIGEST_VIEWS]
    return {"commands": rows, "commandsCorpus": corpus, "senders": senders, "digests": digests,
            "scenarios": [run_guardian_scenario(scenario) for scenario in guardian_scenarios()]}


def first_run_fixture():
    from cheongeum.orchestrator.first_run import FirstRunGuide, INTRO, INTRO_NONAME, LINES, call_name_from

    phrases = ["홍길동", "홍길동이라고 불러 줘", "홍길동이라고 불러주세요", "길동님", "음 김하늘이에요",
               "김하늘입니다", "하늘이라고 해 줘", "건너뛰기", "건너뛸게", "싫어", "없어", "안 할래", "", "가" * 25,
               "제 이름은 봄님", "my name is Orchid", "我是春", "叫我春吧", "私は春です", "星" * 19 + "🌠",
               "봄１", "봄५", "봄[비공개]", "그\u0085봄님", "um\u00a0June?!", "\ufeff봄\ufeff"]
    names = unique(phrases + [text for text in CORPUS if len(text) <= 24])
    scenarios = []
    for lang in ["ko", "en", "zh", "ja", "unknown"]:
        for start, replies, persistent in [
            ("stage2", ["안녕하세요", "홍길동", "네", "@stop", "네", "네"], True),
            ("stage2", ["🌠" * 31, "$&님", "네", "@stop", "아니요", "건너뛸게"], False),
            ("name", ["길동님", "아니요", "건너뛰기", "다른 명령"], False),
            ("mic", ["다른 명령"], True), ("intro", ["@stop", "다른 명령"], True),
            ("practice", ["다른 명령"], True), ("done", [], True),
        ]:
            dialogue, progress, remembered, events = DialogueState("IDLE"), [], [], []
            def remember(value):
                remembered.append(value)
                return persistent
            guide = FirstRunGuide(dialogue, step=start, progress=progress.append, lang=lambda: lang,
                                  call_name=lambda: remembered[-1] if remembered else None,
                                  remember=remember, is_command=lambda text: text == "다른 명령")
            def record(result):
                events.append({"result": result, "slot": dialogue.first_run, "name": guide.pending_name,
                               "progress": list(progress), "remembered": list(remembered)})
            record(guide.begin())
            record(guide.begin())
            for reply in replies:
                if reply == "@stop":
                    praise = guide.after_stop()
                    dialogue.stop()
                    if praise is not None:
                        guide.praised()
                    record(praise)
                else:
                    record(guide.answer(reply))
            scenarios.append(dict(lang=lang, start=start, replies=replies, persistent=persistent, events=events))
    return {"lines": LINES, "intro": INTRO, "noName": INTRO_NONAME, "names": [[t, call_name_from(t)] for t in names],
            "scenarios": scenarios}


def speech_repair_fixture():
    from dataclasses import asdict
    from cheongeum.orchestrator.speech_repair import word_suggestions, VOCAB
    phrases = ["주민등록 등봉 발급 방법 알려줘", "주민등록본 발급 방법 알려줘", "장학제단에서 국가장학금 신청 방법 찾아줘",
               "🌠주민등록 등봉 발급 방법 알려줘", "등본", "뉘엿 뭉개", "공공\u001c서비스", "등본 １２３", "가a나"]
    for word in VOCAB:
        if len(word) >= 3:
            phrases.extend([word, word[:-1] + "흐", word[:-1] + "흐에서", word[:1] + " " + word[1:-1] + "흐"])
    rows = []
    for text in unique(phrases):
        options, clear = word_suggestions(text)
        rows.append([text, [asdict(s) for s in options], clear])
    return {"words": rows}


def main():
    write("commands.json", commands_fixture())
    write("dialogue.json", dialogue_fixture())
    write("guardian.json", guardian_fixture())
    write("first-run.json", first_run_fixture())
    write("speech-repair.json", speech_repair_fixture())


if __name__ == "__main__":
    main()
