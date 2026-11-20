import { INTENTS, type Intent, type IntentType } from "../core/intents.ts";
import { approval, commandKey, doneReply } from "../core/lexicon.ts";
import { PUBLIC_AGENCIES } from "../core/sites.ts";
import { rstripChars } from "../core/text.ts";
import { isPictureRequest, isProgressQuestion, isStopUtterance, type IntentContext, type RuleBasedIntentProvider } from "./rules.ts";
import { isSiteName } from "./sites.ts";

/** 안전 명령과 등록된 예문은 모델을 거치지 않고 사용자가 한 말에서 바로 판정한다. */
const COMMANDS = new Map<IntentType, ReadonlySet<string>>(INTENTS.filter(spec => spec.type !== "UNKNOWN")
  .map(spec => [spec.type, new Set(spec.examples.map(example => commandKey(example.text)))]));
const REGISTERED: ReadonlySet<string> = new Set([...COMMANDS.values()].flatMap(words => [...words]));
const PLANNED: ReadonlySet<IntentType> = new Set(["GOAL", "POLICY_QUESTION", "FIND_PLACE"]);
const DIRECT: ReadonlySet<string> = new Set([...COMMANDS].filter(([kind]) => !PLANNED.has(kind)).flatMap(([, words]) => [...words]));
const AGENCY_OPENS: ReadonlySet<string> = new Set([...PUBLIC_AGENCIES.values()].flatMap(site => site.names
  .flatMap(alias => ["", "열어줘", "열어주세요", "로 가줘", "으로 가줘"].map(suffix => commandKey(alias + suffix)))));

/** 등록된 조작 명령과 기관 열기는 공공업무 계획을 건너뛴다. */
export function isExactCommand(text: string): boolean {
  const key = commandKey(text);
  return DIRECT.has(key) || AGENCY_OPENS.has(key);
}

/** 복합 명령에서 사용자가 화면 사진을 직접 요청한 절이 있는지 확인한다. */
export function pictureCommandParts(text: string, rules: RuleBasedIntentProvider): string[] {
  if (!["사진", "캡처", "캡쳐", "스크린"].some(word => text.includes(word))) return [];
  const parts = rules.splitCommands(text);
  if (parts.length > 1 && parts.some(part => isPictureRequest(rstripChars(part, ".!。"), { utterance: text }))) return parts;
  return [];
}

export function fastIntent(text: string, ctx: IntentContext, rules: RuleBasedIntentProvider): Intent | undefined {
  if (isStopUtterance(text)) return { type: "STOP" };
  if (isProgressQuestion(text)) return { type: "PROGRESS" };
  if (isPictureRequest(rstripChars(text, ".!。"))) return { type: "DESCRIBE_PICTURE", question: text };
  if (ctx.state === "WAITING_FOR_USER_CONFIRMATION") {
    const answer = approval(text);
    if (answer !== undefined) return { type: answer === "approve" ? "APPROVE" : "REJECT" };
  }
  if (ctx.state === "AUTH_HANDOFF" && doneReply(text)) return rules.parseSync(text, ctx);
  if (REGISTERED.has(commandKey(text)) || isSiteName(text)) {
    const intent = rules.parseSync(text, ctx);
    if (intent.type !== "UNKNOWN") return intent;
  }
  return undefined;
}
