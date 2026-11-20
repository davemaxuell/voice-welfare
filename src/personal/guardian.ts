import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DialogueState, GuardianContact, GuardianPending, VaultCommand } from "../core/dialogue.ts";
import { rstripChars, strip } from "../core/text.ts";
import { draft, type Draft, type SessionState } from "../core/turn.ts";
import { isMobile, type PersonalStore } from "./store.ts";

export const MESSAGE = "청음 사용자가 도움을 요청하니 연락해 주세요.";
export const SETUP_HINT = "보호자의 동의를 받은 뒤 '보호자 김하늘 전화번호 공일공 일이삼사 오육칠팔 등록해줘'처럼 말씀해 주세요.";
const SOLAPI_URL = "https://api.solapi.com/messages/v4/send-many/detail";
const SPOKEN_DIGITS: Readonly<Record<string, string>> = { 영: "0", 공: "0", 일: "1", 이: "2", 삼: "3", 사: "4", 오: "5", 육: "6", 륙: "6", 칠: "7", 팔: "8", 구: "9" };
const READ_DIGITS: readonly string[] = [..."공일이삼사오육칠팔구"];

// 원본은 re 모듈이다. re의 \s는 White_Space에 U+001C~U+001F를 더한 것이고, \d는 유니코드 십진 숫자다(Python 3.13은 유니코드 16에서 생긴 숫자를 모른다).
const WS = String.raw`\p{White_Space}\u001c-\u001f`;
const S = `[${WS}]`;
export const guardianPatterns = {
  contact: new RegExp(String.raw`^(?:내${S}*)?보호자(?:한테|에게|께)?${S}*(?:도움${S}*요청|연락|문자(?:${S}*메시지)?(?:를)?${S}*(?:보내)?)` +
    String.raw`(?:해|해줘|해${S}*주세요|줘|주세요|${S}*보내${S}*줘)?$`, "u"),
  clear: new RegExp(String.raw`^(?:내${S}*)?보호자(?:${S}*(?:정보|연락처|번호))?(?:를)?${S}*(?:삭제해|지워)(?:${S}*줘|주세요)?$`, "u"),
  start: new RegExp(String.raw`^(?:내${S}*)?보호자`, "u"),
  registerWords: /등록|저장|기억|(?:이름|번호|연락처)[^\n]*\p{Nd}/u,
  register: new RegExp(String.raw`^(?:내${S}*)?보호자${S}*(?:이름(?:은|이)?${S}*)?(?<name>[가-힣a-zA-Z]{1,15}?)` +
    String.raw`(?:이고|님의|의|님)?[ ,]*(?:전화${S}*번호|연락처|휴대폰)(?:는|은)?${S}*` +
    String.raw`(?<phone>[\p{Nd}영공일이삼사오육륙칠팔구${WS}\-]+?)(?:(?:이?라고|으로|로)?${S}*(?:등록|저장|기억)${S}*해(?:${S}*줘|주세요)?)?$`, "u"),
  spoken: /[영공일이삼사오육륙칠팔구]/gu,
  separators: new RegExp(`[${WS}\\-]`, "gu"),
};

export type GuardianCommand =
  | { kind: "guardian-send" | "guardian-clear" | "guardian-help" }
  | { kind: "guardian-save"; contact: GuardianContact };

export function guardianCommand(text: string): GuardianCommand | undefined {
  const spoken = rstripChars(strip(text), ".!。");
  if (!spoken.includes("보호자")) return undefined;
  if (guardianPatterns.contact.test(spoken)) return { kind: "guardian-send" };
  if (guardianPatterns.clear.test(spoken)) return { kind: "guardian-clear" };
  if (guardianPatterns.start.test(spoken) && guardianPatterns.registerWords.test(spoken)) {
    const { name, phone: said } = guardianPatterns.register.exec(spoken)?.groups ?? {};
    if (name !== undefined && said !== undefined) {
      const phone = said.replace(guardianPatterns.spoken, digit => SPOKEN_DIGITS[digit] ?? digit).replace(guardianPatterns.separators, "");
      if (isMobile(phone)) return { kind: "guardian-save", contact: { name, phone } };
    }
    return { kind: "guardian-help" };
  }
  return undefined;
}

export type Delivery = "preview" | "accepted" | "failed" | "unknown";

export interface GuardianSender {
  readonly preview: boolean;
  send(phone: string, message: string): Promise<Delivery>;
}

export class PreviewSender implements GuardianSender {
  readonly preview = true;
  async send(): Promise<Delivery> { return "preview"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Python의 bool(value): JSON 값이 비어 있으면 거짓이다. */
function isFilled(value: unknown): boolean {
  if (typeof value === "string" || Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== null && value !== undefined && value !== false && value !== 0;
}
function nested(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** 솔라피 접수 결과. 접수가 확인되지 않으면 보낸 것으로 보지 않고 unknown으로 둔다. */
function solapiDelivery(result: unknown): Delivery {
  if (nested(result, "failedMessageList") === undefined) return "unknown";
  if (isFilled(nested(result, "failedMessageList"))) return "failed";
  const registered = nested(result, "groupInfo", "count", "registeredSuccess");
  // Python에서는 True == 1이다.
  return registered === 1 || registered === true ? "accepted" : "unknown";
}

export class SolapiSender implements GuardianSender {
  readonly preview = false;
  readonly #key: string;
  readonly #secret: string;
  readonly #senderNumber: string;

  constructor(key: string, secret: string, senderNumber: string) {
    this.#key = key;
    this.#secret = secret;
    this.#senderNumber = senderNumber;
  }

  async send(phone: string, message: string): Promise<Delivery> {
    const stamp = new Date().toISOString();
    const salt = randomBytes(16).toString("hex");
    const signature = createHmac("sha256", this.#secret).update(stamp + salt).digest("hex");
    const auth = `HMAC-SHA256 apiKey=${this.#key}, date=${stamp}, salt=${salt}, signature=${signature}`;
    const body = { messages: [{ to: phone, from: this.#senderNumber, text: message, type: "SMS" }] };
    let response: Response;
    try {
      // 리디렉션을 따라가면 같은 문자가 두 번 갈 수 있어 따라가지 않는다(httpx도 기본이 그렇다).
      response = await fetch(SOLAPI_URL, {
        method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
        redirect: "manual", signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return "unknown";
    }
    if (response.status >= 400 && response.status < 500) return "failed";
    if (!response.ok) return "unknown";
    try {
      return solapiDelivery(await response.json());
    } catch {
      return "unknown";
    }
  }
}

export function guardianSender(env: Readonly<Record<string, string | undefined>>): GuardianSender | undefined {
  const provider = strip(env.GUARDIAN_SMS_PROVIDER ?? "mock").toLowerCase();
  if (provider === "mock") return new PreviewSender();
  const key = strip(env.SOLAPI_API_KEY ?? ""), secret = strip(env.SOLAPI_API_SECRET ?? "");
  const number = strip(env.SOLAPI_SENDER_NUMBER ?? "").replaceAll("-", "");
  if (provider === "solapi" && key.length > 0 && secret.length > 0 && /^[0-9]{8,11}$/u.test(number)) return new SolapiSender(key, secret, number);
  return undefined;
}

const DIGEST_KEYS = ["url", "title", "step", "fields", "dialogs", "status", "outline", "errors"] as const;
/** 문자를 물을 때 본 화면의 지문. 승인할 때 화면이 달라졌는지 비교한다. */
export function screenDigest(view: Readonly<Record<string, unknown>> | undefined): string {
  const relevant = Object.fromEntries(DIGEST_KEYS.map(key => [key, view?.[key] ?? null]));
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

type GuardianQuestion = { kind: "guardian-help" } | { kind: GuardianPending["kind"]; contact?: GuardianContact };

function isGuardianPending(command: VaultCommand): command is GuardianPending {
  return command.kind === "guardian-save" || command.kind === "guardian-clear" || command.kind === "guardian-send";
}
function sameContact(a: GuardianContact | undefined, b: GuardianContact): boolean {
  return a !== undefined && a.name === b.name && a.phone === b.phone;
}

export class GuardianDialogue {
  readonly #store: PersonalStore;
  readonly #dialogue: DialogueState;
  readonly #sender: GuardianSender | undefined;

  constructor(store: PersonalStore, dialogue: DialogueState, sender: GuardianSender | undefined) {
    this.#store = store;
    this.#dialogue = dialogue;
    this.#sender = sender;
  }

  /** 보호자 확인 대기를 꺼낸다(대기는 접고 상태는 묻기 전으로 돌린다). 다른 대기나 없으면 undefined. */
  takePending(): GuardianPending | undefined {
    const pending = this.#dialogue.vaultConfirm;
    if (pending === undefined || !isGuardianPending(pending)) return undefined;
    this.#dialogue.takeVaultConfirm();
    this.#dialogue.commit(pending.resume);
    return pending;
  }

  ask(cmd: GuardianQuestion, view: Readonly<Record<string, unknown>> | undefined, now: number, resume: SessionState): Draft {
    if (cmd.kind === "guardian-help") return draft(resume, "clarify", SETUP_HINT);
    const contact = cmd.contact ?? this.#store.guardian();
    if (contact === undefined) return draft(resume, "clarify", "저장한 보호자가 없어요. " + SETUP_HINT);
    const { name, phone } = contact;
    const phoneRead = Array.from(phone, digit => READ_DIGITS[Number(digit)] ?? digit).join(" ");
    let speech: string;
    if (cmd.kind === "guardian-save") {
      this.#dialogue.askVaultConfirm({ kind: cmd.kind, contact, at: now, resume });
      speech = `보호자 ${name}님의 번호는 ${phoneRead}예요. 이분이 도움 요청 문자를 받는 데 동의했고 이 번호를 저장해도 되면 '네'라고 해 주세요.`;
    } else if (cmd.kind === "guardian-clear") {
      this.#dialogue.askVaultConfirm({ kind: cmd.kind, contact, at: now, resume });
      speech = `보호자 ${name}님의 연락처를 지울까요?`;
    } else {
      if (this.#sender === undefined) return draft(resume, "none", "보호자 문자 발송 설정을 확인해 주세요.");
      this.#dialogue.askVaultConfirm({ kind: cmd.kind, contact, at: now, resume, message: MESSAGE, screen: screenDigest(view) });
      const action = this.#sender.preview ? "모의 문자로 미리 볼까요" : "문자로 보낼까요";
      speech = `${name}님, 끝번호 ${phone.slice(-4)}에게 “${MESSAGE}” ${action}? 원하시면 '네'라고 말씀해 주세요.`;
    }
    return draft("WAITING_FOR_USER_CONFIRMATION", "clarify", speech);
  }

  async approved(pending: GuardianPending, view: Readonly<Record<string, unknown>> | undefined, now: number, ttl: number): Promise<Draft> {
    const { contact, resume } = pending;
    if (pending.kind !== "guardian-save" && !sameContact(this.#store.guardian(), contact)) return this.ask({ kind: pending.kind }, view, now, resume);
    if (now - pending.at >= ttl || (pending.kind === "guardian-send" && screenDigest(view) !== pending.screen)) return this.ask(pending, view, now, resume);
    if (pending.kind !== "guardian-send") {
      const saving = pending.kind === "guardian-save";
      this.#store.setGuardian(saving ? contact : undefined);
      return draft(resume, "none", saving ? "보호자 연락처를 저장했어요." : "보호자 연락처를 지웠어요.");
    }
    if (this.#sender === undefined) return this.ask({ kind: pending.kind }, view, now, resume);
    const delivery = await this.#sender.send(contact.phone, pending.message);
    const speech: Record<Delivery, string> = {
      preview: `모의 문자 내용은 “${pending.message}”입니다. 실제 발송은 하지 않았어요.`,
      accepted: "보호자에게 보낼 문자가 발송 서비스에 접수됐어요.",
      failed: "발송 서비스가 문자를 접수하지 못했어요. 다시 시도하려면 '보호자한테 연락해줘'라고 해 주세요.",
      unknown: "문자 접수 여부를 확인하지 못했어요. 중복 발송을 피하려면 먼저 보호자에게 확인해 주세요.",
    };
    return draft(resume, "none", speech[delivery]);
  }
}
