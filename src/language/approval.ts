import type { Approval, VaultCommand } from "../core/dialogue.ts";
import { hasText } from "../core/text.ts";
import type { Draft, DraftAction, Lang, PendingConfirmation } from "../core/turn.ts";
import { FIXED } from "./i18n.ts";

type Waiting = Approval | VaultCommand;
type CopyKey = keyof typeof FIXED;
type Row = PendingConfirmation["values"][number];

const fields = new Map<string, CopyKey>([
  ["이름", "name"], ["성명", "name"], ["주소", "address"], ["주민등록 주소", "registered"],
  ["실거주지 주소", "residence"], ["전화번호", "phone"], ["연락처", "phone"], ["연락처 (선택)", "phone"],
  ["소득·재산 신고", "income"], ["소득·재산 신고 (선택)", "income"], ["가구원 수", "household"],
  ["가구원 수 (선택)", "household"], ["이메일", "email"], ["생년월일", "birth"],
]);

/** 원래 승인과 지문은 세션에 둔다. 화면과 로컬 낭독에는 별도의 사본을 준다. */
export function approvalPresentation(waiting: Waiting | undefined, lang: Lang, persistent: boolean) {
  const original = waiting?.confirmation;
  if (waiting === undefined || original === undefined || lang === "ko") return undefined;
  const t = (key: CopyKey) => FIXED[key][lang];
  let purpose: CopyKey, question: CopyKey;
  let values: Row[] = [];
  const row = (key: CopyKey, value: string): Row => ({ label: t(key), value });
  switch (waiting.kind) {
    case "assist":
    case "submit":
    case undefined: {
      const input = waiting.kind === "assist";
      purpose = input ? "fieldPurpose" : "submitPurpose";
      question = input ? "fieldQuestion" : "submitQuestion";
      values = original.values.flatMap(field => {
        const key = fields.get(field.label) ?? "field";
        return [row(key, field.value), row("pageField", field.label)];
      });
      break;
    }
    case "click": {
      const target = waiting.action.target;
      const link = target?.role === "link" || target?.role === "scriptlink";
      [purpose, question] = waiting.then === "login-open" ? ["loginOpen", "loginOpenQuestion"]
        : waiting.then === "login-submit" ? ["loginSubmit", "loginSubmitQuestion"]
        : [link ? "linkPurpose" : "clickPurpose", "clickQuestion"];
      if (hasText(waiting.pageTitle)) values.push(row("pageTitle", waiting.pageTitle));
      if (hasText(target?.name)) values.push(row("control", target.name));
      break;
    }
    case "file":
      purpose = "filePurpose";
      question = original.values[0]?.value.toLowerCase().endsWith(".hwpx") === true ? "fileTextQuestion" : "fileQuestion";
      values = original.values.map(item => row("file", item.value));
      break;
    case "visual":
      purpose = waiting.imagePurpose ?? "visualPurpose";
      question = "visualQuestion";
      values = original.values.map(item => row("recipient", item.value));
      break;
    case "research":
      purpose = "researchPurpose"; question = "researchQuestion";
      values = [row("question", waiting.goal)];
      break;
    case "vault-save":
      purpose = "savePurpose"; question = persistent ? "saveDevice" : "saveSession";
      break;
    case "vault-clear":
      purpose = "clearPurpose"; question = "clearQuestion";
      break;
    default:
      return undefined;
  }
  const card: PendingConfirmation = { ...original, purpose: t(purpose), description: t(question), values };
  const readback = [row("destination", card.site), ...values].map(item => item.label + ": " + item.value).join(". ");
  return { card, speech: [card.purpose, readback, card.description].join(". ") };
}

/** 일반 답변은 그대로 두고, 승인 요청 또는 재확인으로 만든 응답만 읽는다. */
export function approvalNarration(kind: Draft["approvalSpeech"], lang: Lang, speech: string, summary?: string) {
  if (lang === "ko" || kind === undefined) return undefined;
  if (kind === "changed") return FIXED.changed[lang];
  if (summary === undefined) return undefined;
  if (kind === "expired" || kind === "unverified") return FIXED[kind][lang] + " " + summary;
  return kind === "switch" ? speech + " " + summary : summary;
}

export function approvalAction<T extends Pick<DraftAction, "action" | "policy">>(event: T, lang: Lang) {
  const { action, policy } = event;
  const target = action.target?.name ?? action.target?.label;
  return {
    ...event,
    action: { ...action, reason: [FIXED[action.type][lang], target].filter(Boolean).join(" — ") },
    policy: policy.code === "NEEDS_CONFIRMATION" ? { ...policy, reason: FIXED.policyPending[lang] } : policy,
  };
}
