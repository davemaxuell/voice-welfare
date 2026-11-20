"""
첫 실행 설정 3단계(동의 뒤, 음성): 마이크 확인 → 부르는 이름 → '멈춰' 연습 → 청음 소개 → 연습 신청서 제안.
문장은 모두 여기 고정(네 언어). 모델이 쓴 말이나 번역(translate_out)은 쓰지 않는다.
"""
from __future__ import annotations

from typing import Callable

from cheongeum.core.dialogue import DialogueState
from cheongeum.core.jsutil import rx
from cheongeum.core.lexicon import agree
from cheongeum.core.turn import draft
from cheongeum.speech.phrasing import speak_call_name

LINES: dict[str, dict[str, str]] = {
    # '청음아'는 부름말로 떼어지므로 마이크 확인은 '안녕하세요'로 한다
    "mic": {
        "ko": "이제 제가 들어 볼게요. 말하기 단축키 Ctrl, Shift, 스페이스를 누르고 '안녕하세요'라고 말해 보세요.",
        "en": "Now let me listen. Press the talk shortcut, Control, Shift and Space, and say “Hello”.",
        "zh": "现在我来听听。请按说话快捷键 Ctrl、Shift 和空格键，然后说“你好”。",
        "ja": "では聞いてみますね。話すショートカット Ctrl、Shift、スペースを押して「こんにちは」と言ってみてください。",
    },
    "mic-heard": {
        "ko": "'{heard}'라고 들었어요. 잘 들려요!",
        "en": "I heard “{heard}”. I can hear you well!",
        "zh": "我听到了“{heard}”。听得很清楚！",
        "ja": "「{heard}」と聞こえました。よく聞こえます！",
    },
    "mic-none": {
        "ko": "소리가 들어오지 않았어요. 마이크가 연결됐는지 확인해 주세요. 건너뛰려면 '건너뛰기'라고 해 주세요.",
        "en": "No sound came through. Please check that the microphone is connected. To skip, say “skip”.",
        "zh": "没有收到声音。请检查麦克风是否已连接。要跳过请说“跳过”。",
        "ja": "音が届きませんでした。マイクがつながっているか確認してください。飛ばすには「スキップ」と言ってください。",
    },
    "name": {
        "ko": "어떻게 불러 드릴까요? 이름을 말씀해 주시거나 '건너뛰기'라고 해 주세요.",
        "en": "What should I call you? Tell me a name, or say “skip”.",
        "zh": "我该怎么称呼您？请告诉我名字，或者说“跳过”。",
        "ja": "何とお呼びしましょうか？お名前を言うか、「スキップ」と言ってください。",
    },
    # {name}은 speak_call_name을 거쳐 늘 '님'으로 끝나므로 '이라고'가 맞다
    "name-confirm": {
        "ko": "{name}이라고 부를게요. 맞으면 '네'라고 해 주세요.",
        "en": "I will call you {name}. If that is right, say “yes”.",
        "zh": "我会称呼您{name}。如果对，请说“是”。",
        "ja": "{name}とお呼びしますね。よろしければ「はい」と言ってください。",
    },
    "name-shared": {
        "ko": "이 컴퓨터는 여럿이 쓰셔서 이름은 이번에만 기억할게요.",
        "en": "Several people use this computer, so I will only remember the name for this time.",
        "zh": "这台电脑是多人共用的，所以名字只在这次记住。",
        "ja": "このパソコンは複数の人が使うので、お名前は今回だけ覚えておきます。",
    },
    "stop-practice": {
        "ko": "제가 말하는 도중에도 '멈춰'라고 하면 바로 멈춰요. 지금 한번 '멈춰'라고 해 보세요.",
        "en": "Even while I am talking, say “stop” and I will stop right away. Try saying “stop” now.",
        "zh": "即使我正在说话，只要说“停止”我就会马上停下。现在试着说一次“停止”。",
        "ja": "私が話している途中でも「止まって」と言えばすぐに止まります。いま一度「止まって」と言ってみてください。",
    },
    "stop-praise": {
        "ko": "잘하셨어요! 이렇게 멈춰요. 이제 제 소개를 들어 보실래요? 말하기 단축키를 누르고 '네'라고 해 주세요.",
        "en": "Well done! That is how I stop. Would you like to hear about me now? Press the talk shortcut and say “yes”.",
        "zh": "做得很好！我就是这样停下的。现在想听听我的介绍吗？请按说话快捷键说“是”。",
        "ja": "よくできました！こうして止まります。では私の紹介を聞いてみますか？話すショートカットを押して「はい」と言ってください。",
    },
    "practice-offer": {
        "ko": "연습용 신청서로 한 번 해 볼까요? 진짜로 제출되지는 않아요.",
        "en": "Shall we try a practice application form? Nothing is really submitted.",
        "zh": "要用练习用的申请表试一次吗？不会真的提交。",
        "ja": "練習用の申請書で一度やってみましょうか？本当に提出されることはありません。",
    },
    "practice-no": {
        "ko": "언제든 '청음아'하고 불러 주세요.",
        "en": "Call me any time by saying “Cheongeum”.",
        "zh": "随时叫我“青音”就可以。",
        "ja": "いつでも「チョンウム」と呼んでください。",
    },
}

# 청음 소개: (아바타 동작, 문장). 동작 이름은 cheongeum-avatar.glb의 클립이다.
INTRO: list[tuple[str, dict[str, str]]] = [
    ("welcome", {
        "ko": "{name}, 반가워요! 저는 청음이에요.",
        "en": "{name}, nice to meet you! I am Cheongeum.",
        "zh": "{name}，很高兴见到您！我是青音。",
        "ja": "{name}、はじめまして！私はチョンウムです。",
    }),
    ("listening", {
        "ko": "복지, 민원, 장학금처럼 궁금한 걸 말로 물어보세요.",
        "en": "Ask me out loud about welfare, civil services, scholarships and more.",
        "zh": "福利、政务、奖学金，有什么想知道的就用说的问我。",
        "ja": "福祉、行政手続き、奨学金など、知りたいことを声で聞いてください。",
    }),
    ("screen-reading", {
        "ko": "복지로나 정부24 같은 사이트를 열어서 읽어 드려요.",
        "en": "I open sites like Bokjiro and Government24 and read them to you.",
        "zh": "我会打开福利路、政府24这样的网站读给您听。",
        "ja": "福祉路や政府24のようなサイトを開いて読み上げます。",
    }),
    ("confirmation", {
        "ko": "신청서 입력도 도와드려요. 누르기 전에는 꼭 여쭤볼게요.",
        "en": "I help fill in application forms too, and I always ask before I press anything.",
        "zh": "我也会帮您填写申请表，按下之前一定会先问您。",
        "ja": "申請書の入力もお手伝いします。押す前には必ずお聞きします。",
    }),
    ("auth-handoff", {
        "ko": "본인인증과 진짜 제출은 직접 하시도록 넘겨 드려요.",
        "en": "Identity checks and real submissions are yours to do, so I hand those over to you.",
        "zh": "身份验证和正式提交由您亲自完成，我会交给您。",
        "ja": "本人確認と本当の提出はご自身でできるようにお渡しします。",
    }),
    ("stopped", {
        "ko": "언제든 '멈춰'라고 하면 멈춰요.",
        "en": "Say “stop” any time and I will stop.",
        "zh": "随时说“停止”，我就会停下。",
        "ja": "いつでも「止まって」と言えば止まります。",
    }),
    ("complete", {
        "ko": "그럼 같이 시작해 볼까요?",
        "en": "Shall we get started together?",
        "zh": "那我们一起开始吧？",
        "ja": "では、一緒に始めましょうか？",
    }),
]

# 부르는 이름이 없을 때 소개 첫 문장
INTRO_NONAME: dict[str, str] = {
    "ko": "반가워요! 저는 청음이에요.",
    "en": "Nice to meet you! I am Cheongeum.",
    "zh": "很高兴见到您！我是青音。",
    "ja": "はじめまして！私はチョンウムです。",
}

_FILLER = rx(r"^((음+|어+|아+|에+|그+|저기|그러니까|그니까|um+|uh+)[,.\s]+)+")
_SKIP = rx(r"^(건너\s*뛰|건너뛸|싫어|싫습니다|없어|없습니다|안\s*할래|말\s*안\s*할래|패스|skip|no thanks|跳过|不用|スキップ|いいえ)")
_PREFIX = rx(r"^(제\s*)?(이름은|성함은)\s*|^(call me|my name is|i'?m)\s+|^(我叫|叫我)|^(私は)")
_ENDING = rx(
    r"(이?라고\s*(불러\s*(줘|주세요|주면\s*돼요?)?|해\s*(줘|주세요))|입니다|이에요|예요|이요|요|님|と呼んでください|と呼んで|です|吧)$",
)


def call_name_from(text: str) -> str | None:
    """'홍길동이라고 불러 줘' → '홍길동'. 건너뛰겠다는 말이거나 이름으로 보기 어려우면 None."""
    t = rx(r"\s+").sub(" ", text or "").strip()
    t = _FILLER.sub("", t, count=1).strip()
    t = rx(r"[.!?。！？]+$").sub("", t).strip()
    if not t or _SKIP.search(t.lower()):
        return None
    t = _PREFIX.sub("", t, count=1).strip()
    for _ in range(3):
        cut = _ENDING.sub("", t).strip()
        if cut == t:
            break
        t = cut
    if not t or len(t) > 20 or "[" in t or rx(r"\d").search(t):
        return None
    return t


# 이어 갈 단계 → 물을 단계(소개 앞에서 끊겼으면 '멈춰' 연습부터 다시)
_RESUME = {"stage2": "mic", "mic": "mic", "name": "name", "stop": "stop", "intro": "stop", "practice": "practice"}
_ASK = {"mic": "mic", "name": "name", "stop": "stop-practice", "practice": "practice-offer"}


class FirstRunGuide:
    """
    첫 실행 3단계 대화. 상태는 DialogueState.first_run 하나(이름 붙은 동작으로만 바꾼다).
    진행은 progress(step)로 설정 파일에 적어 앱을 다시 열면 그 단계부터 한 번 이어 간다.
    answer()가 None이면 설정 대화가 아닌 다른 명령이라 오케스트레이터가 평소처럼 처리한다.
    """

    def __init__(
        self,
        dialogue: DialogueState,
        *,
        step: str | None,
        progress: Callable[[str], None] | None,
        lang: Callable[[], str],
        call_name: Callable[[], str | None],
        remember: Callable[[str], bool],
        is_command: Callable[[str], bool],
    ) -> None:
        self.dialogue = dialogue
        self._start = step if step in _RESUME else None
        self._progress = progress
        self._lang = lang
        self._call_name = call_name
        self._remember = remember
        self._is_command = is_command
        self._name: str | None = None
        # 끊긴 단계를 이어 가는 중이면 진행을 다시 적지 않는다(이어 가기는 한 번만)
        self._resumed = False

    @property
    def pending_name(self) -> str | None:
        """맞는지 묻고 있는 부르는 이름(기록에서 가린다)."""
        return self._name

    def _say(self, key: str, **values: str) -> str:
        texts = LINES[key]
        return texts.get(self._lang(), texts["ko"]).format(**values)

    def _record(self, step: str) -> None:
        if self._progress and (not self._resumed or step == "done"):
            self._progress(step)

    def _ask(self, step: str, speech: str, record: str | None = None) -> dict:
        self.dialogue.ask_first_run(step)
        self._record(record or step)
        return draft(self.dialogue.state, "help", speech)

    def _leave(self) -> None:
        """다른 명령이 와서 설정 대화를 접는다. 진행 기록은 남겨 다음 실행에서 한 번 이어 간다."""
        self.dialogue.end_first_run()

    def _done(self) -> None:
        self.dialogue.end_first_run()
        self._record("done")

    def begin(self) -> str | None:
        """동의 직후: 이어 갈 단계가 있으면 그 단계의 질문(동의 답 뒤에 붙인다). 없으면 None."""
        if self._start is None:
            return None
        resumed = self._start != "stage2"
        step, self._start = _RESUME[self._start], None
        self.dialogue.ask_first_run(step)
        if resumed:
            # 앱을 닫았다 연 뒤 한 번만 이어 간다: 이번에 끝내지 않아도 다음 실행에는 묻지 않는다
            self._record("done")
            self._resumed = True
        else:
            self._record(step)
        return self._say(_ASK[step])

    def after_stop(self) -> str | None:
        """'멈춰' 연습 중에 멈췄으면 칭찬과 소개 제안. 아니면 None(설정 대화는 멈춤과 함께 접힌다)."""
        return self._say("stop-praise") if self.dialogue.first_run == "stop" else None

    def praised(self) -> None:
        """칭찬한 뒤 소개를 들을지 묻는 중이다. (SessionOrchestrator._stop, dialogue.stop() 뒤)"""
        self.dialogue.ask_first_run("intro")
        self._record("intro")

    def answer(self, text: str) -> dict | str | None:
        """지금 단계의 대답. 'practice'면 연습 신청서를 열 차례, None이면 다른 명령."""
        step = self.dialogue.first_run
        yes_no = agree(text)
        skip = bool(_SKIP.search(text.strip().lower()))
        command = not skip and yes_no is None and self._is_command(text)
        if step == "mic":
            if command:
                self._leave()
                return None
            return self._ask("name", f"{self._say('mic-heard', heard=text[:30])} {self._say('name')}")
        if step == "name":
            if command:
                self._leave()
                return None
            return self._take_name(call_name_from(text))
        if step == "name-confirm":
            if yes_no == "yes" and self._name:
                saved = self._remember(self._name)
                shared = "" if saved else f"{self._say('name-shared')} "
                return self._ask("stop", shared + self._say("stop-practice"))
            if yes_no == "no":
                return self._ask("name", self._say("name"))
            if command:
                self._leave()
                return None
            return self._take_name(call_name_from(text))
        if step == "stop":
            if command:
                self._leave()
                return None
            return self._ask("stop", self._say("stop-practice"))
        if step == "intro":
            if yes_no == "yes":
                return self.intro_draft()
            if command:
                self._leave()
                return None
            return self._ask("practice", self._say("practice-offer"))
        if step == "practice":
            if yes_no == "yes":
                self._done()
                return "practice"
            if yes_no == "no" or skip:
                self._done()
                return draft(self.dialogue.state, "help", self._say("practice-no"))
            if command:
                self._done()
                return None
            return self._ask("practice", self._say("practice-offer"))
        return None

    def _take_name(self, name: str | None) -> dict:
        if name is None:
            return self._ask("stop", self._say("stop-practice"))
        self._name = name
        return self._ask("name-confirm", self._say("name-confirm", name=speak_call_name(name)), "name")

    def intro_draft(self, *, replay: bool = False) -> dict:
        """청음 소개. 처음 설정이면 끝에 연습 신청서를 묻고(건너뛰어도 묻는다), 다시 듣기면 소개만."""
        lang = self._lang()
        name = self._call_name()
        lines = []
        for i, (pose, texts) in enumerate(INTRO):
            text = texts.get(lang, texts["ko"])
            if i == 0:
                text = text.format(name=speak_call_name(name)) if name else INTRO_NONAME.get(lang, INTRO_NONAME["ko"])
            lines.append({"text": text, "pose": pose})
        if not replay:
            lines.append({"text": self._say("practice-offer"), "pose": "confirmation", "ask": True})
            self.dialogue.ask_first_run("practice")
            self._record("practice")
        return draft(self.dialogue.state, "help", " ".join(line["text"] for line in lines), introScript=lines)
