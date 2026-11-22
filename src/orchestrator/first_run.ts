import type { DialogueState } from "../core/dialogue.ts";
import { agree, commandKey } from "../core/lexicon.ts";
import { strip } from "../core/text.ts";
import { draft, type Draft, type IntroLine } from "../core/turn.ts";
import { speakCallName } from "../speech/phrasing.ts";
import { INTRO, INTRO_NONAME, LINES } from "./first_run_text.ts";

export const firstRunPatterns = {
  filler: /^((음+|어+|아+|에+|그+|저기|그러니까|그니까|um+|uh+)[,.\p{White_Space}]+)+/u,
  skip: /^(건너\p{White_Space}*뛰|건너뛸|싫어|싫습니다|없어|없습니다|안\p{White_Space}*할래|말\p{White_Space}*안\p{White_Space}*할래|패스|skip|no thanks|跳过|不用|スキップ|いいえ)/u,
  prefix: /^(제\p{White_Space}*)?(이름은|성함은)\p{White_Space}*|^(call me|my name is|i'?m)\p{White_Space}+|^(我叫|叫我)|^(私は)/u,
  ending: /(이?라고\p{White_Space}*(불러\p{White_Space}*(줘|주세요|주면\p{White_Space}*돼요?)?|해\p{White_Space}*(줘|주세요))|입니다|이에요|예요|이요|요|님|と呼んでください|と呼んで|です|吧)$/u,
  punctuation: /[.!?。！？]+(?=\n?$)/u,
  digit: /\p{Nd}/u,
  spaces: /\p{White_Space}+/gu,
};

export function callNameFrom(text: string): string | undefined {
  let name = strip(text.replace(firstRunPatterns.spaces, " "));
  name = strip(name.replace(firstRunPatterns.filler, ""));
  name = strip(name.replace(firstRunPatterns.punctuation, ""));
  if (name === "" || firstRunPatterns.skip.test(name.toLowerCase())) return undefined;
  name = strip(name.replace(firstRunPatterns.prefix, ""));
  for (let i = 0; i < 3; i++) {
    const shortened = strip(name.replace(firstRunPatterns.ending, ""));
    if (shortened === name) break;
    name = shortened;
  }
  if (name === "" || Array.from(name).length > 20 || name.includes("[") || firstRunPatterns.digit.test(name)) return undefined;
  return name;
}

interface GuideOptions {
  step?: string;
  progress?: (step: string) => void;
  lang: () => string;
  callName: () => string | undefined;
  remember: (name: string) => boolean;
  isCommand: (text: string) => boolean;
}

type ResumeStep = "mic" | "name" | "stop" | "practice";
const resume = new Map<string, ResumeStep>([["stage2", "mic"], ["sound-complete", "mic"], ["mic", "mic"], ["name", "name"], ["stop", "stop"], ["intro", "stop"], ["practice", "practice"]]);
const prompts = { mic: "mic", name: "name", stop: "stop-practice", practice: "practice-offer" } as const;
const micGreetings = new Set(["안녕", "안녕하세요", "안녕하십니까", "hi", "hello", "你好", "您好", "こんにちは"]);
const micSkips = new Set(["건너뛰기", "건너뛰어", "패스", "skip", "跳过", "スキップ"]);
const changeName = new Set(["호칭바꿔줘", "호칭바꿔주세요", "부르는이름바꿔줘", "changemyname", "更改称呼", "呼び名を変えて"]);
const nameReadback = {
  ko: "{name}이라고 부를게요. 바꾸려면 ‘호칭 바꿔 줘’라고 말씀해 주세요.",
  en: "I'll call you {name}. To change it, say “change my name”.",
  zh: "我会称呼您为{name}。要修改，请说“更改称呼”。",
  ja: "{name}とお呼びします。変えるには「呼び名を変えて」と言ってください。",
} as const;
const nameIntroduction = /^(?:(?:(?:please\s+)?call me|my name is)\s+|(?:请\s*)?叫我|我叫|(?:(?:제|내)\s*)?(?:이름은|성함은)\s*)/iu;
const callMeEnding = /(?:이?라고\s*불러\s*(?:주세요|줘요?)|と呼んで(?:ください)?)\s*[.!。！]*$/u;
const nameSubject = /^(?:i['’]?m\s+|저[는를]\s*|나[는를]\s*|私[はを]\s*)/iu;
const nameWords = /^[\p{L}\p{M}]+(?:[ ’'·-][\p{L}\p{M}]+){0,4}$/u;
const notAName = /[?？]|\b(?:and|or|but|then|not|never|private|secret|don['’]t)\b|(?:지\s*(?:마|말|않)|비밀|말고|대신|그리고|不要|保密|秘密|呼ばない|言いたくない)/iu;
const requestWords = /^(?:open|show|read|find|go|click|help|tell|please|speak|switch|change|what|who|how|where|why|when|can|could|would|do|don['’]t)\b|^(?:打开|帮我|请|開いて)|(?:하지\s*마|지\s*말|말고|ください)$/iu;

function volunteeredName(text: string): string | undefined {
  if (notAName.test(text)) return undefined;
  const phrase = strip(text);
  const named = phrase.replace(nameIntroduction, "").replace(nameSubject, "");
  const name = callNameFrom(named);
  if (name === undefined || !nameWords.test(name)) return undefined;
  if (nameIntroduction.test(phrase) || callMeEnding.test(phrase)) return name;
  if (requestWords.test(named)) return undefined;
  if (!name.includes(" ") || /^[가-힣] [가-힣]{1,4}$/u.test(name) || name.split(" ").every(word => /^\p{Lu}/u.test(word))) return name;
  return undefined;
}

type LineKey = keyof typeof LINES;

export class FirstRunGuide {
  readonly #dialogue: DialogueState;
  readonly #options: GuideOptions;
  #start?: string;
  #resumed = false;
  #startupMode: "consent" | "direct" | "reviewed" = "consent";
  #name?: string;

  constructor(dialogue: DialogueState, options: GuideOptions) {
    this.#dialogue = dialogue;
    this.#options = options;
    this.#start = options.step;
  }

  get pendingName() { return this.#name; }

  #language() {
    const code = this.#options.lang();
    return code === "en" || code === "zh" || code === "ja" ? code : "ko";
  }

  #say(key: LineKey) { return LINES[key][this.#language()]; }
  #record(step: string) {
    if (!this.#resumed || step === "done") this.#options.progress?.(step);
  }

  #ask(step: string, speech: string, record = step): Draft {
    this.#dialogue.askFirstRun(step);
    this.#record(record);
    return draft(this.#dialogue.state, "help", speech);
  }

  #begin() {
    const step = resume.get(this.#start ?? "");
    if (step === undefined) return undefined;
    const resumed = this.#start !== "stage2" && this.#start !== "sound-complete";
    this.#start = undefined;
    this.#dialogue.askFirstRun(step);
    this.#record(resumed ? "done" : step);
    this.#resumed = resumed;
    return LINES[prompts[step]];
  }

  begin(): string | undefined {
    return this.#begin()?.[this.#language()];
  }

  offer({ reviewNames = false } = {}) {
    this.#startupMode = reviewNames ? "reviewed" : "direct";
    return this.#begin();
  }

  wantsNameChange(text: string) {
    return this.#startupMode === "direct" && changeName.has(commandKey(text)) && this.#options.callName() !== undefined;
  }

  afterStop(): string | undefined {
    return this.#dialogue.firstRun === "stop" ? this.#say("stop-praise") : undefined;
  }

  praised(): void {
    this.#dialogue.askFirstRun("intro");
    this.#record("intro");
  }

  #takeName(text: string): Draft {
    const name = callNameFrom(text);
    if (name === undefined) return this.#ask("stop", this.#say("stop-practice"));
    this.#name = name;
    return this.#ask("name-confirm", this.#say("name-confirm").replace("{name}", () => speakCallName(name)), "name");
  }

  #rememberName(name: string, correcting: boolean): Draft {
    this.#name = name;
    const lang = this.#language();
    const readback = nameReadback[lang].replace("{name}", () => lang === "ko" ? speakCallName(name) : name);
    const speech = this.#options.remember(name) ? readback : readback + " " + this.#say("name-shared");
    if (!correcting) return { ...this.#ask("stop", speech + " " + this.#say("stop-practice")), privateHistory: true };
    this.#dialogue.endFirstRun();
    return draft(this.#dialogue.state, "help", speech, { privateHistory: true });
  }

  #leaveForCommand(step: string): undefined {
    this.#dialogue.endFirstRun();
    if ((this.#startupMode !== "consent" && step !== "rename") || step === "practice") this.#record("done");
    return undefined;
  }

  answer(text: string): Draft | "practice" | undefined {
    const step = this.#dialogue.firstRun;
    if ((step === undefined || step === "stop") && this.wantsNameChange(text)) {
      if (step === "stop") return this.#ask("name", this.#say("name"));
      this.#dialogue.askFirstRun("rename");
      return draft(this.#dialogue.state, "help", this.#say("name"));
    }
    if (step === undefined) return undefined;
    const reply = agree(text);
    const phrase = strip(text);
    const skipped = firstRunPatterns.skip.test(phrase.toLowerCase());
    if (this.#startupMode !== "consent") {
      if (this.#startupMode === "direct" && (step === "mic" || step === "stop") &&
          (nameIntroduction.test(phrase) || callMeEnding.test(phrase))) {
        const name = volunteeredName(text);
        if (name !== undefined) return this.#rememberName(name, false);
      }
      const key = commandKey(text);
      const skipStep = micSkips.has(key);
      if (step === "mic") {
        if (skipStep) return this.#ask("name", this.#say("name"));
        if (!micGreetings.has(key)) return this.#leaveForCommand(step);
      }
      if (this.#startupMode === "direct" && (step === "name" || step === "rename")) {
        if (skipStep || reply === "no") {
          if (step === "name") return this.#ask("stop", this.#say("stop-practice"));
          this.#dialogue.endFirstRun();
          return draft(this.#dialogue.state, "help", this.#say("practice-no"));
        }
        const name = !skipped && reply === undefined && !this.#options.isCommand(text) ? volunteeredName(text) : undefined;
        return name === undefined ? this.#leaveForCommand(step) : this.#rememberName(name, step === "rename");
      }
    }
    if (!skipped && reply === undefined && this.#options.isCommand(text)) return this.#leaveForCommand(step);
    switch (step) {
      case "mic": {
        const heard = Array.from(text).slice(0, 30).join("");
        return this.#ask("name", this.#say("mic-heard").replace("{heard}", () => heard) + " " + this.#say("name"));
      }
      case "name":
        return this.#takeName(text);
      case "name-confirm":
        if (reply === "yes" && this.#name !== undefined) {
          const shared = this.#options.remember(this.#name) ? "" : this.#say("name-shared") + " ";
          return this.#ask("stop", shared + this.#say("stop-practice"));
        }
        if (reply === "no") return this.#ask("name", this.#say("name"));
        return this.#takeName(text);
      case "stop":
        return this.#ask("stop", this.#say("stop-practice"));
      case "intro":
        if (reply === "yes") return this.introDraft();
        return this.#ask("practice", this.#say("practice-offer"));
      case "practice":
        if (reply !== undefined || skipped) {
          this.#dialogue.endFirstRun();
          this.#record("done");
          if (reply === "yes") return "practice";
          return draft(this.#dialogue.state, "help", this.#say("practice-no"));
        }
        return this.#ask("practice", this.#say("practice-offer"));
      default:
        return undefined;
    }
  }

  introDraft({ replay = false }: { replay?: boolean } = {}): Draft {
    const lang = this.#language();
    const name = this.#options.callName();
    const lines: IntroLine[] = INTRO.map(([pose, texts], index) => {
      let text = texts[lang];
      if (index === 0) text = name === undefined || name === "" ? INTRO_NONAME[lang] : text.replace("{name}", () => speakCallName(name));
      return { pose, text };
    });
    if (!replay) {
      lines.push({ pose: "confirmation", text: this.#say("practice-offer"), ask: true });
      this.#dialogue.askFirstRun("practice");
      this.#record("practice");
    }
    return draft(this.#dialogue.state, "help", lines.map(line => line.text).join(" "), { introScript: lines });
  }
}
