import type { IntroLine } from "../core/turn.ts";

type Translation = Readonly<Record<"ko" | "en" | "zh" | "ja", string>>;

export const LINES = {
  "mic": {
    "ko": "이제 제가 들어 볼게요. 말하기 단축키 Ctrl, Shift, 스페이스를 누르고 '안녕하세요'라고 말해 보세요.",
    "en": "Now let me listen. Press the talk shortcut, Control, Shift and Space, and say “Hello”.",
    "zh": "现在我来听听。请按说话快捷键 Ctrl、Shift 和空格键，然后说“你好”。",
    "ja": "では聞いてみますね。話すショートカット Ctrl、Shift、スペースを押して「こんにちは」と言ってみてください。"
  },
  "mic-heard": {
    "ko": "'{heard}'라고 들었어요. 잘 들려요!",
    "en": "I heard “{heard}”. I can hear you well!",
    "zh": "我听到了“{heard}”。听得很清楚！",
    "ja": "「{heard}」と聞こえました。よく聞こえます！"
  },
  "mic-none": {
    "ko": "소리가 들어오지 않았어요. 마이크가 연결됐는지 확인해 주세요. 건너뛰려면 '건너뛰기'라고 해 주세요.",
    "en": "No sound came through. Please check that the microphone is connected. To skip, say “skip”.",
    "zh": "没有收到声音。请检查麦克风是否已连接。要跳过请说“跳过”。",
    "ja": "音が届きませんでした。マイクがつながっているか確認してください。飛ばすには「スキップ」と言ってください。"
  },
  "name": {
    "ko": "어떻게 불러 드릴까요? 이름을 말씀해 주시거나 '건너뛰기'라고 해 주세요.",
    "en": "What should I call you? Tell me a name, or say “skip”.",
    "zh": "我该怎么称呼您？请告诉我名字，或者说“跳过”。",
    "ja": "何とお呼びしましょうか？お名前を言うか、「スキップ」と言ってください。"
  },
  "name-confirm": {
    "ko": "{name}이라고 부를게요. 맞으면 '네'라고 해 주세요.",
    "en": "I will call you {name}. If that is right, say “yes”.",
    "zh": "我会称呼您{name}。如果对，请说“是”。",
    "ja": "{name}とお呼びしますね。よろしければ「はい」と言ってください。"
  },
  "name-shared": {
    "ko": "이 컴퓨터는 여럿이 쓰셔서 이름은 이번에만 기억할게요.",
    "en": "Several people use this computer, so I will only remember the name for this time.",
    "zh": "这台电脑是多人共用的，所以名字只在这次记住。",
    "ja": "このパソコンは複数の人が使うので、お名前は今回だけ覚えておきます。"
  },
  "stop-practice": {
    "ko": "제가 말하는 도중에도 '멈춰'라고 하면 바로 멈춰요. 지금 한번 '멈춰'라고 해 보세요.",
    "en": "Even while I am talking, say “stop” and I will stop right away. Try saying “stop” now.",
    "zh": "即使我正在说话，只要说“停止”我就会马上停下。现在试着说一次“停止”。",
    "ja": "私が話している途中でも「止まって」と言えばすぐに止まります。いま一度「止まって」と言ってみてください。"
  },
  "stop-praise": {
    "ko": "잘하셨어요! 이렇게 멈춰요. 이제 제 소개를 들어 보실래요? 말하기 단축키를 누르고 '네'라고 해 주세요.",
    "en": "Well done! That is how I stop. Would you like to hear about me now? Press the talk shortcut and say “yes”.",
    "zh": "做得很好！我就是这样停下的。现在想听听我的介绍吗？请按说话快捷键说“是”。",
    "ja": "よくできました！こうして止まります。では私の紹介を聞いてみますか？話すショートカットを押して「はい」と言ってください。"
  },
  "practice-offer": {
    "ko": "연습용 신청서로 한 번 해 볼까요? 진짜로 제출되지는 않아요.",
    "en": "Shall we try a practice application form? Nothing is really submitted.",
    "zh": "要用练习用的申请表试一次吗？不会真的提交。",
    "ja": "練習用の申請書で一度やってみましょうか？本当に提出されることはありません。"
  },
  "practice-no": {
    "ko": "언제든 '청음아'하고 불러 주세요.",
    "en": "Call me any time by saying “Cheongeum”.",
    "zh": "随时叫我“青音”就可以。",
    "ja": "いつでも「チョンウム」と呼んでください。"
  }
} satisfies Readonly<Record<string, Translation>>;

export const INTRO = [
  [
    "welcome",
    {
      "ko": "{name}, 반가워요! 저는 청음이에요.",
      "en": "{name}, nice to meet you! I am Cheongeum.",
      "zh": "{name}，很高兴见到您！我是青音。",
      "ja": "{name}、はじめまして！私はチョンウムです。"
    }
  ],
  [
    "listening",
    {
      "ko": "복지, 민원, 장학금처럼 궁금한 걸 말로 물어보세요.",
      "en": "Ask me out loud about welfare, civil services, scholarships and more.",
      "zh": "福利、政务、奖学金，有什么想知道的就用说的问我。",
      "ja": "福祉、行政手続き、奨学金など、知りたいことを声で聞いてください。"
    }
  ],
  [
    "screen-reading",
    {
      "ko": "복지로나 정부24 같은 사이트를 열어서 읽어 드려요.",
      "en": "I open sites like Bokjiro and Government24 and read them to you.",
      "zh": "我会打开福利路、政府24这样的网站读给您听。",
      "ja": "福祉路や政府24のようなサイトを開いて読み上げます。"
    }
  ],
  [
    "confirmation",
    {
      "ko": "신청서 입력도 도와드려요. 누르기 전에는 꼭 여쭤볼게요.",
      "en": "I help fill in application forms too, and I always ask before I press anything.",
      "zh": "我也会帮您填写申请表，按下之前一定会先问您。",
      "ja": "申請書の入力もお手伝いします。押す前には必ずお聞きします。"
    }
  ],
  [
    "auth-handoff",
    {
      "ko": "본인인증과 진짜 제출은 직접 하시도록 넘겨 드려요.",
      "en": "Identity checks and real submissions are yours to do, so I hand those over to you.",
      "zh": "身份验证和正式提交由您亲自完成，我会交给您。",
      "ja": "本人確認と本当の提出はご自身でできるようにお渡しします。"
    }
  ],
  [
    "stopped",
    {
      "ko": "언제든 '멈춰'라고 하면 멈춰요.",
      "en": "Say “stop” any time and I will stop.",
      "zh": "随时说“停止”，我就会停下。",
      "ja": "いつでも「止まって」と言えば止まります。"
    }
  ],
  [
    "complete",
    {
      "ko": "그럼 같이 시작해 볼까요?",
      "en": "Shall we get started together?",
      "zh": "那我们一起开始吧？",
      "ja": "では、一緒に始めましょうか？"
    }
  ]
] satisfies ReadonlyArray<readonly [IntroLine["pose"], Translation]>;

export const INTRO_NONAME = {
  "ko": "반가워요! 저는 청음이에요.",
  "en": "Nice to meet you! I am Cheongeum.",
  "zh": "很高兴见到您！我是青音。",
  "ja": "はじめまして！私はチョンウムです。"
} satisfies Translation;
