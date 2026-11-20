import type { DialogueState } from "../core/dialogue.ts";
import { agree } from "../core/lexicon.ts";
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
const resume = new Map<string, ResumeStep>([["stage2", "mic"], ["mic", "mic"], ["name", "name"], ["stop", "stop"], ["intro", "stop"], ["practice", "practice"]]);
const prompts = { mic: "mic", name: "name", stop: "stop-practice", practice: "practice-offer" } as const;
type LineKey = keyof typeof LINES;

export class FirstRunGuide {
  readonly #dialogue: DialogueState;
  readonly #options: GuideOptions;
  #start?: string;
  #resumed = false;
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

  begin(): string | undefined {
    const step = resume.get(this.#start ?? "");
    if (step === undefined) return undefined;
    const resumed = this.#start !== "stage2";
    this.#start = undefined;
    this.#dialogue.askFirstRun(step);
    this.#record(resumed ? "done" : step);
    this.#resumed = resumed;
    return this.#say(prompts[step]);
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

  answer(text: string): Draft | "practice" | undefined {
    const step = this.#dialogue.firstRun;
    const reply = agree(text);
    const skipped = firstRunPatterns.skip.test(strip(text).toLowerCase());
    const command = !skipped && reply === undefined && this.#options.isCommand(text);
    if (step === undefined) return undefined;
    if (command) {
      this.#dialogue.endFirstRun();
      if (step === "practice") this.#record("done");
      return undefined;
    }
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
