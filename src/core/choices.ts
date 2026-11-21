import { z } from "zod";
import type { Intent } from "./intents.ts";
import type { Lang } from "./turn.ts";

// 서버가 제안하는 선택지(아바타·대화 창 버튼). 무엇을 제안할지도, 고른 뒤 무엇을 할지도 서버가 정한다.
// 버튼 이름은 그대로 말해도 같은 뜻이 되게 정한다(로그인했어요 → AUTH_DONE, 인증 취소 → 인계 취소).
export const CHOICE_KEYS = ["auth-done", "auth-cancel", "read-main", "resume-navigation"] as const;
export const ChoiceKeySchema = z.enum(CHOICE_KEYS);
export type ChoiceKey = z.infer<typeof ChoiceKeySchema>;

const LABELS = {
  "auth-done": { ko: "로그인했어요", en: "I'm done", zh: "完成了", ja: "終わりました" },
  "auth-done-check": { ko: "인증 끝났어요", en: "I'm done", zh: "完成了", ja: "終わりました" },
  "auth-cancel": { ko: "인증 취소", en: "Cancel", zh: "取消", ja: "キャンセル" },
  "read-main": { ko: "본문 읽기", en: "Read the page", zh: "朗读正文", ja: "本文を読む" },
  "resume-navigation": { ko: "계속해 줘", en: "Continue navigation", zh: "继续浏览", ja: "案内を再開" },
} satisfies Record<string, Record<Lang, string>>;

// 고르면 이 말과 의도로 한 턴을 처리한다(기록에도 이 말로 남는다). 말이 없으면 버튼 이름(한국어) 그대로.
// 인계 취소는 말 규칙으로 알아듣으므로 '인증 취소'여야 한다.
export const CHOICE_TURNS: Record<ChoiceKey, { text: string | undefined; intent: Intent }> = {
  "auth-done": { text: undefined, intent: { type: "AUTH_DONE" } },
  "auth-cancel": { text: "인증 취소", intent: { type: "REJECT" } },
  "read-main": { text: "본문 읽어줘", intent: { type: "READ_MAIN", more: false } },
  "resume-navigation": { text: "계속해 줘", intent: { type: "RESUME" } },
};

export function choiceLabel(key: ChoiceKey, lang: string, authKind?: string | null): string {
  const row = LABELS[key === "auth-done" && authKind != null && authKind !== "login" ? "auth-done-check" : key];
  return new Map<string, string>(Object.entries(row)).get(lang) ?? row.ko;
}
