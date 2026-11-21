import { expect, it } from "vitest";
import { CHOICE_KEYS, CHOICE_TURNS, ChoiceKeySchema, choiceLabel, type ChoiceKey } from "../../src/core/choices.ts";
import { parseIntent } from "../../src/core/intents.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.choices.choice_label 출력이다.
const labels: [key: ChoiceKey, lang: string, authKind: string | null, label: string][] = [
  ["auth-done", "ko", null, "로그인했어요"],
  ["auth-done", "ko", "login", "로그인했어요"],
  ["auth-done", "ko", "verification", "인증 끝났어요"],
  ["auth-done", "ko", "captcha", "인증 끝났어요"],
  ["auth-done", "en", null, "I'm done"],
  ["auth-done", "en", "login", "I'm done"],
  ["auth-done", "en", "verification", "I'm done"],
  ["auth-done", "en", "captcha", "I'm done"],
  ["auth-done", "zh", null, "完成了"],
  ["auth-done", "zh", "login", "完成了"],
  ["auth-done", "zh", "verification", "完成了"],
  ["auth-done", "zh", "captcha", "完成了"],
  ["auth-done", "ja", null, "終わりました"],
  ["auth-done", "ja", "login", "終わりました"],
  ["auth-done", "ja", "verification", "終わりました"],
  ["auth-done", "ja", "captcha", "終わりました"],
  ["auth-done", "fr", null, "로그인했어요"],
  ["auth-done", "fr", "login", "로그인했어요"],
  ["auth-done", "fr", "verification", "인증 끝났어요"],
  ["auth-done", "fr", "captcha", "인증 끝났어요"],
  ["auth-done", "", null, "로그인했어요"],
  ["auth-done", "", "login", "로그인했어요"],
  ["auth-done", "", "verification", "인증 끝났어요"],
  ["auth-done", "", "captcha", "인증 끝났어요"],
  ["auth-cancel", "ko", null, "인증 취소"],
  ["auth-cancel", "ko", "login", "인증 취소"],
  ["auth-cancel", "ko", "verification", "인증 취소"],
  ["auth-cancel", "ko", "captcha", "인증 취소"],
  ["auth-cancel", "en", null, "Cancel"],
  ["auth-cancel", "en", "login", "Cancel"],
  ["auth-cancel", "en", "verification", "Cancel"],
  ["auth-cancel", "en", "captcha", "Cancel"],
  ["auth-cancel", "zh", null, "取消"],
  ["auth-cancel", "zh", "login", "取消"],
  ["auth-cancel", "zh", "verification", "取消"],
  ["auth-cancel", "zh", "captcha", "取消"],
  ["auth-cancel", "ja", null, "キャンセル"],
  ["auth-cancel", "ja", "login", "キャンセル"],
  ["auth-cancel", "ja", "verification", "キャンセル"],
  ["auth-cancel", "ja", "captcha", "キャンセル"],
  ["auth-cancel", "fr", null, "인증 취소"],
  ["auth-cancel", "fr", "login", "인증 취소"],
  ["auth-cancel", "fr", "verification", "인증 취소"],
  ["auth-cancel", "fr", "captcha", "인증 취소"],
  ["auth-cancel", "", null, "인증 취소"],
  ["auth-cancel", "", "login", "인증 취소"],
  ["auth-cancel", "", "verification", "인증 취소"],
  ["auth-cancel", "", "captcha", "인증 취소"],
  ["read-main", "ko", null, "본문 읽기"],
  ["read-main", "ko", "login", "본문 읽기"],
  ["read-main", "ko", "verification", "본문 읽기"],
  ["read-main", "ko", "captcha", "본문 읽기"],
  ["read-main", "en", null, "Read the page"],
  ["read-main", "en", "login", "Read the page"],
  ["read-main", "en", "verification", "Read the page"],
  ["read-main", "en", "captcha", "Read the page"],
  ["read-main", "zh", null, "朗读正文"],
  ["read-main", "zh", "login", "朗读正文"],
  ["read-main", "zh", "verification", "朗读正文"],
  ["read-main", "zh", "captcha", "朗读正文"],
  ["read-main", "ja", null, "本文を読む"],
  ["read-main", "ja", "login", "本文を読む"],
  ["read-main", "ja", "verification", "本文を読む"],
  ["read-main", "ja", "captcha", "本文を読む"],
  ["read-main", "fr", null, "본문 읽기"],
  ["read-main", "fr", "login", "본문 읽기"],
  ["read-main", "fr", "verification", "본문 읽기"],
  ["read-main", "fr", "captcha", "본문 읽기"],
  ["read-main", "", null, "본문 읽기"],
  ["read-main", "", "login", "본문 읽기"],
  ["read-main", "", "verification", "본문 읽기"],
  ["read-main", "", "captcha", "본문 읽기"],
];

it.each(labels)("선택지 이름 %s %j %s", (key, lang, authKind, label) => {
  expect(choiceLabel(key, lang, authKind)).toBe(label);
});

it("인증 종류를 모르면 로그인 이름을 쓴다", () => {
  expect(choiceLabel("auth-done", "ko")).toBe("로그인했어요");
  expect(choiceLabel("auth-done", "ko", undefined)).toBe("로그인했어요");
});

it("고른 뒤 처리할 말과 의도가 표와 같다", () => {
  expect(CHOICE_KEYS).toEqual(["auth-done", "auth-cancel", "read-main", "resume-navigation"]);
  expect(CHOICE_TURNS).toStrictEqual({
    "auth-done": { text: undefined, intent: { type: "AUTH_DONE" } },
    "auth-cancel": { text: "인증 취소", intent: { type: "REJECT" } },
    "read-main": { text: "본문 읽어줘", intent: { type: "READ_MAIN", more: false } },
    "resume-navigation": { text: "계속해 줘", intent: { type: "RESUME" } },
  });
  for (const key of CHOICE_KEYS) expect(parseIntent(CHOICE_TURNS[key].intent)).toEqual(CHOICE_TURNS[key].intent);
});

it("제안 키는 정해진 선택지만 받는다", () => {
  expect(ChoiceKeySchema.safeParse("auth-done").success).toBe(true);
  expect(ChoiceKeySchema.safeParse("approve").success).toBe(false);
});
