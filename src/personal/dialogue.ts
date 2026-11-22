import type { DialogueState } from "../core/dialogue.ts";
import { agree, approval, wholeRejection } from "../core/lexicon.ts";
import { rstrip, rstripChars, strip } from "../core/text.ts";
import { draft, type Draft, type Lang, type SpeechPrefs } from "../core/turn.ts";
import { speakCallName, speakDate } from "../speech/phrasing.ts";
import { localDay, type ActionLog } from "./action_log.ts";
import { daysUntil, vaultKeyForLabel, type PersonalCommand } from "./commands.ts";
import { VAULT_LABELS, type Application, type PersonalStore, type Vault, type VaultKey } from "./store.ts";

type VaultField = VaultKey | "callName";
const VAULT_FIELD_LABELS: Readonly<Record<Lang, Readonly<Record<VaultField, string>>>> = {
  ko: { ...VAULT_LABELS, callName: "부르는 이름" },
  en: { name: "Name", address: "Address", phone: "Phone", email: "Email", birth: "Date of birth", callName: "Preferred name" },
  zh: { name: "姓名", address: "地址", phone: "电话", email: "电子邮箱", birth: "出生日期", callName: "称呼" },
  ja: { name: "氏名", address: "住所", phone: "電話番号", email: "メール", birth: "生年月日", callName: "呼び名" },
};
const SAVE_ON_DEVICE: Readonly<Record<Lang, string>> = {
  ko: "이렇게 이 컴퓨터에 저장할까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.",
  en: "Save these details on this computer? Say yes or no.",
  zh: "要把这些信息保存在这台电脑上吗？请回答是或不是。",
  ja: "この情報をこの端末に保存しますか。はい、またはいいえでお答えください。",
};
const SAVE_IN_SESSION: Readonly<Record<Lang, string>> = {
  ko: "이렇게 기억할까요? 맞으면 '응', 아니면 '아니'라고 해 주세요.",
  en: "Remember these details for this conversation? Say yes or no.",
  zh: "要在这次对话中记住这些信息吗？请回答是或不是。",
  ja: "この会話の間だけこの情報を覚えておきますか。はい、またはいいえでお答えください。",
};
const READ_VAULT: Readonly<Record<Lang, string>> = {
  ko: "저장된 정보는 {entries}이에요.",
  en: "Your saved details are {entries}.",
  zh: "您已保存的信息是：{entries}。",
  ja: "保存されている情報は、{entries}です。",
};
const ASK_VAULT_FIELDS: Readonly<Record<Lang, string>> = {
  ko: "무엇을 저장할까요? 예: '내 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10이라고 저장해줘'. 비밀번호·주민등록번호는 저장하지 않아요.",
  en: "Which detail should I remember? Please ask me to save it again, giving the field name first and then its value.",
  zh: "您想保存哪项信息？请重新说出保存请求，先说项目名称，再说相应的内容。",
  ja: "どの情報を保存しますか。項目名とその内容を順に指定して、もう一度保存を依頼してください。",
};
export type VaultQuestion = "vault-save" | "vault-clear";
export const dialoguePatterns = {
  saveVerb: /(?:저장해|기억해)\p{White_Space}*(?:줘요?|주세요)?/u,
  clearVerb: /(?:지워|삭제해)\p{White_Space}*(?:줘요?|주세요)?/u,
  hangul: /[가-힣]/u,
  yesPrefix: /^(?:응|네|예)[,\p{White_Space}]+/u,
  refusal: /(?:지우지|저장하지|기억하지|삭제하지|하지)\p{White_Space}*마(?:세요|요)?/u,
};
/** Python의 pattern.fullmatch(text): 위 식은 일치 구간을 기록한 그대로 두고 여기서만 앞뒤를 고정한다. */
function whole(pattern: RegExp): RegExp { return new RegExp(`^(?:${pattern.source})$`, pattern.flags); }
const VAULT_VERBS: Readonly<Record<VaultQuestion, RegExp>> = { "vault-save": whole(dialoguePatterns.saveVerb), "vault-clear": whole(dialoguePatterns.clearVerb) };
const REFUSAL = whole(dialoguePatterns.refusal);

/** 사용자가 들은 저장·삭제 질문에 대한 대답 전체를 번역 없이 맞춘다. 예·아니오가 아니면 undefined. */
export function vaultReply(text: string, kind: VaultQuestion, lang: string): boolean | undefined {
  const t = rstrip(rstripChars(strip(text), ".!。！~"));
  if (t.length === 0 || t.endsWith("?") || t.endsWith("？")) return undefined;
  if (lang !== "ko") {
    if (approval(t, lang) === "approve") return true;
    return wholeRejection(t, lang) ? false : undefined;
  }
  if (dialoguePatterns.hangul.test(t)) {
    const answer = agree(t);
    if (answer !== undefined) return answer === "yes";
  }
  const phrase = t.replace(dialoguePatterns.yesPrefix, "");
  if (VAULT_VERBS[kind].test(phrase) || (phrase.startsWith("승인") && approval(phrase) === "approve")) return true;
  if (phrase === "거절" || phrase === "취소" || phrase === "됐어" || REFUSAL.test(phrase)) return false;
  return undefined;
}

function speakSpeech(prefs: SpeechPrefs): string {
  const speed = prefs.rate <= 1.0 ? "천천히" : prefs.rate >= 1.4 ? "빨리" : "보통";
  const length = { short: "짧게", normal: "보통", detailed: "자세히" }[prefs.length];
  const voice = prefs.voice === undefined || prefs.voice === "" ? "기본" : prefs.voice;
  return "말하는 속도는 " + speed + ", 답 길이는 " + length + ", 목소리는 " + voice +
    ", 진행 상황 알림은 " + (prefs.progressSpoken ? "켭니다." : "끕니다.");
}
function listed(values: Vault, lang: Lang): string[] {
  // Preserve the order in which the user supplied the values.
  const labels: Readonly<Record<string, string>> = VAULT_FIELD_LABELS[lang];
  return Object.entries(values).map(([key, value]) => labels[key] + " " + value);
}
function statusLine(app: Application, i: number): string {
  let due = "";
  if (app.dueDate !== undefined && app.dueDate.length > 0) {
    const left = daysUntil(app.dueDate);
    const note = app.dueNote === undefined || app.dueNote === "" ? "기한" : app.dueNote;
    due = ", " + note + " " + speakDate(app.dueDate) + "까지(" + (left >= 0 ? left + "일 남음" : "기한 지남") + ")";
  }
  return (i + 1) + ". " + app.service + ", " + speakDate(app.appliedAt) + " 신청" + due;
}

export class PersonalDialogue {
  readonly #store: PersonalStore;
  readonly dialogue: DialogueState;
  readonly #onSpeech?: (prefs: SpeechPrefs) => void;
  readonly #actionLog?: ActionLog;

  constructor(store: PersonalStore, dialogue: DialogueState, onSpeech?: (prefs: SpeechPrefs) => void, actionLog?: ActionLog) {
    this.#store = store;
    this.dialogue = dialogue;
    this.#onSpeech = onSpeech;
    this.#actionLog = actionLog;
  }

  savedFor(label: string): string | undefined {
    const key = vaultKeyForLabel(label);
    return key === undefined ? undefined : this.#store.vault()[key];
  }

  /** 물어본 저장·삭제에 대한 결정(vaultReply)을 실행한다. 확인 대기는 늘 접는다. */
  confirm(approved: boolean): Draft {
    const pending = this.dialogue.takeVaultConfirm();
    if (!approved) return draft("IDLE", "none", "알겠어요. 그대로 둘게요.");
    if (pending?.kind === "vault-save") {
      this.#store.saveVault(pending.values);
      const where = this.#store.persistent ? "이 컴퓨터에만 저장했어요" : "이번 대화 동안 기억할게요";
      return draft("IDLE", "none", where + ". 입력 칸을 채울 때 먼저 여쭤보고 쓸게요.");
    }
    if (pending?.kind !== "vault-clear") throw new Error("Unexpected vault confirmation");
    this.#store.clearVault();
    return draft("IDLE", "none", "저장된 내 정보를 모두 지웠어요.");
  }

  run(cmd: PersonalCommand, { lang = "ko", direct = false }: { lang?: Lang; direct?: boolean } = {}): Draft | undefined {
    const store = this.#store, state = this.dialogue.state;
    switch (cmd.kind) {
      case "vault-guidance": {
        const effect = cmd.action === "clear" ? "내 정보를 지우면 저장한 이름과 주소 같은 정보, 부르는 이름, 보호자 연락처와 기억한 이동 경로가 함께 지워져요."
          : store.persistent ? "기억해 달라고 한 정보는 이 컴퓨터에 저장해요." : "기억해 달라고 한 정보는 이번 대화 동안만 보관해요.";
        const speech = cmd.reason === "question" ? effect : cmd.reason === "refusal" ? "알겠어요."
          : cmd.action === "save" ? "기억할 항목과 값을 다시 말씀해 주세요." : "어떤 정보를 지우려는지 말씀해 주세요.";
        return draft(state, "none", speech, {privateHistory: true});
      }
      case "vault-save": {
        const entries = listed(cmd.values, lang);
        if (entries.length === 0) return draft(state, "clarify", ASK_VAULT_FIELDS[lang], { lang });
        if (direct) {
          store.saveVault(cmd.values);
          return draft(state, "none", store.persistent ? "이 컴퓨터에 저장했어요." : "이번 대화 동안 기억할게요.", {privateHistory: true});
        }
        this.dialogue.askVaultConfirm(cmd);
        const question = store.persistent ? SAVE_ON_DEVICE : SAVE_IN_SESSION;
        return draft("WAITING_FOR_USER_CONFIRMATION", "clarify", entries.join(", ") + ". " + question[lang], { lang });
      }
      case "vault-read": {
        const entries = listed(store.vault(), lang);
        const name = store.callName();
        if (name !== undefined) entries.push(VAULT_FIELD_LABELS[lang].callName + " " + (lang === "ko" ? speakCallName(name) : name));
        if (entries.length > 0) return draft(state, "none", READ_VAULT[lang].replace("{entries}", () => entries.join(", ")), { lang });
        return draft(state, "none", "저장된 정보가 없어요. '내 이름은 …이라고 저장해줘'처럼 말씀해 주세요.");
      }
      case "vault-clear":
        if (Object.keys(store.vault()).length === 0 && store.guardian() === undefined && store.callName() === undefined) {
          return draft(state, "none", "저장된 정보가 없어요.");
        }
        if (direct) {
          store.clearVault();
          return draft(state, "none", "저장된 내 정보를 모두 지웠어요.", {privateHistory: true});
        }
        this.dialogue.askVaultConfirm(cmd);
        return draft("WAITING_FOR_USER_CONFIRMATION", "clarify", "저장된 내 정보를 모두 지울까요? 맞으면 '응'이라고 해 주세요.");
      case "app-record": {
        store.addApplication({ service: cmd.service, appliedAt: localDay(), ...(cmd.receiptNo === undefined ? {} : { receiptNo: cmd.receiptNo }) });
        const receipt = cmd.receiptNo === undefined || cmd.receiptNo === "" ? "" : ". 접수번호 " + cmd.receiptNo;
        return draft(state, "none", cmd.service + " 신청을 기록했어요" + receipt +
          ". 보완 서류 기한이 생기면 '보완 서류는 12월 3일까지'처럼 알려 주세요. 사흘 전부터 알려 드릴게요.");
      }
      case "app-due": {
        const apps = store.applications().filter(app => app.done !== true);
        const service = cmd.service;
        const match = service === undefined || service === "" ? undefined : apps.find(app => service.includes(app.service) || app.service.includes(service));
        const target = match ?? apps.at(-1);
        if (target === undefined) return draft(state, "clarify", "어떤 신청의 기한인지 몰라요. 먼저 '기초연금 신청했어'처럼 신청을 알려 주세요.");
        store.updateApplication(target.id, { dueDate: cmd.dueDate, dueNote: cmd.note });
        const left = daysUntil(cmd.dueDate);
        return draft(state, "none", target.service + " " + cmd.note + " 기한을 " + speakDate(cmd.dueDate) + "로 적었어요. " + left + "일 남았어요. " +
          (left <= 3 ? "기한까지 매일 알려 드릴게요." : "사흘 전부터 알려 드릴게요."));
      }
      case "app-status": {
        const apps = store.applications().filter(app => app.done !== true);
        if (apps.length === 0) return draft(state, "none", "기록된 신청이 없어요. 신청을 마치면 '기초연금 신청했어'라고 알려 주세요.");
        return draft(state, "none", "기록된 신청은 " + apps.length + "건이에요. " + apps.map(statusLine).join(". ") +
          ". 실제 처리 상태는 복지로에 로그인해서 신청 현황에서 볼 수 있어요. 로그인은 직접 하셔야 해요.");
      }
      case "app-done": {
        const apps = store.applications().filter(app => app.done !== true);
        const service = cmd.service;
        const match = service === undefined || service === "" ? undefined : apps.find(app => app.service.includes(service));
        const target = match ?? (apps.length === 1 ? apps[0] : undefined);
        if (target === undefined) return draft(state, "clarify", "어떤 신청이 끝났는지 제도 이름을 말씀해 주세요.");
        store.updateApplication(target.id, { done: true });
        return draft(state, "none", target.service + " 신청을 끝난 것으로 표시했어요. 수고하셨어요.");
      }
      case "speech-read":
        return draft(state, "none", speakSpeech(store.speech()));
      case "speech-clear":
      case "speech-set": {
        const prefs = cmd.kind === "speech-set" ? store.saveSpeech(cmd.values) : store.clearSpeech();
        this.#onSpeech?.(prefs);
        const lead = cmd.kind === "speech-set" ? "알겠어요. " : "말하기 설정을 기본값으로 돌렸어요. ";
        return draft(state, "none", lead + speakSpeech(prefs));
      }
      case "action-log-read":
        return draft(state, "none", this.#actionLog?.speakRecent(5) ?? "조작 기록을 이 세션에서는 쓰지 않아요.");
      case "site-allow-read": {
        const sites = store.allowedSites();
        return draft(state, "none", sites.length === 0 ? "저장된 정보를 쓰도록 허용한 사이트가 없어요." : "허용한 사이트는 " + sites.join(", ") + "이에요.");
      }
      case "site-allow-clear":
        store.revokeSite();
        return draft(state, "none", "사이트별 정보 공유 허용을 모두 지웠어요.");
    }
  }
}
