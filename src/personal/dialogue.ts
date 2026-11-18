import type { DialogueState } from "../core/dialogue.ts";
import { draft, type Draft, type SpeechPrefs } from "../core/turn.ts";
import { speakDate } from "../speech/phrasing.ts";
import { localDay, type ActionLog } from "./action_log.ts";
import { daysUntil, vaultKeyForLabel, type PersonalCommand } from "./commands.ts";
import { VAULT_LABELS, type Application, type PersonalStore, type Vault } from "./store.ts";

export const dialoguePatterns = {
  yes: /^(응|네|예|맞아|그래|좋아|저장해|지워)/u,
  no: /^(아니|아뇨|취소|됐어|하지\p{White_Space}*마)/u,
};

function speakSpeech(prefs: SpeechPrefs): string {
  const speed = prefs.rate <= 1.0 ? "천천히" : prefs.rate >= 1.4 ? "빨리" : "보통";
  const length = { short: "짧게", normal: "보통", detailed: "자세히" }[prefs.length];
  const voice = prefs.voice === undefined || prefs.voice === "" ? "기본" : prefs.voice;
  return "말하는 속도는 " + speed + ", 답 길이는 " + length + ", 목소리는 " + voice +
    ", 진행 상황 알림은 " + (prefs.progressSpoken ? "켭니다." : "끕니다.");
}
function listed(values: Vault): string {
  // Preserve the order in which the user supplied the values.
  const labels: Readonly<Record<string, string>> = VAULT_LABELS;
  return Object.entries(values).map(([key, value]) => labels[key] + " " + value).join(", ");
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

  confirm(text: string): Draft | undefined {
    const pending = this.dialogue.takeVaultConfirm();
    if (pending === undefined) return undefined;
    if (dialoguePatterns.yes.test(text)) {
      if (pending.kind === "vault-clear") {
        this.#store.clearVault();
        return draft("IDLE", "none", "저장된 내 정보를 모두 지웠어요.");
      }
      this.#store.saveVault(pending.values);
      const where = this.#store.persistent ? "이 컴퓨터에만 저장했어요" : "이번 대화 동안 기억할게요";
      return draft("IDLE", "none", where + ". 입력 칸을 채울 때 먼저 여쭤보고 쓸게요.");
    }
    if (dialoguePatterns.no.test(text)) return draft("IDLE", "none", "알겠어요. 그대로 둘게요.");
    return undefined;
  }

  run(cmd: PersonalCommand): Draft | undefined {
    const store = this.#store, state = this.dialogue.state;
    switch (cmd.kind) {
      case "vault-save": {
        const entries = listed(cmd.values);
        if (entries.length === 0) {
          return draft(state, "clarify", "무엇을 저장할까요? 예: '내 이름은 김하늘이고 주소는 부산광역시 예시구 예시로 10이라고 저장해줘'. 비밀번호·주민등록번호는 저장하지 않아요.");
        }
        this.dialogue.askVaultConfirm(cmd);
        const where = store.persistent ? "이 컴퓨터에 저장할까요" : "기억할까요";
        return draft("WAITING_FOR_USER_CONFIRMATION", "clarify", entries + ". 이렇게 " + where + "? 맞으면 '응', 아니면 '아니'라고 해 주세요.");
      }
      case "vault-read": {
        const entries = listed(store.vault());
        return draft(state, "none", entries.length > 0 ? "저장된 정보는 " + entries + "이에요."
          : "저장된 정보가 없어요. '내 이름은 …이라고 저장해줘'처럼 말씀해 주세요.");
      }
      case "vault-clear":
        if (Object.keys(store.vault()).length === 0) return draft(state, "none", "저장된 정보가 없어요.");
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
