import { expect, it } from "vitest";
import { CHOICE_KEYS, CHOICE_TURNS, ChoiceKeySchema, JOB_CHOICE_KEYS, choiceLabel, isJobChoice, offeredChoices, type ChoiceKey } from "../../src/core/choices.ts";
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

it("제안 하나는 키마다 그 언어의 이름을 붙인 목록이 되고 인증 종류에 맞는 이름을 쓴다", () => {
  expect(offeredChoices({ keys: ["auth-done", "auth-cancel"], authKind: "verification" }, "ko"))
    .toEqual([{ key: "auth-done", label: "인증 끝났어요" }, { key: "auth-cancel", label: "인증 취소" }]);
  expect(offeredChoices({ keys: ["read-main"] }, "en")).toEqual([{ key: "read-main", label: "Read the page" }]);
  expect(offeredChoices({ keys: [] }, "ko")).toEqual([]);
});

it("조사를 고르는 선택지는 셋이고, 네 언어 모두 이름에 순서만 있다", () => {
  expect(JOB_CHOICE_KEYS).toEqual(["job-1", "job-2", "job-3"]);
  expect(JOB_CHOICE_KEYS.map(key => ["ko", "en", "zh", "ja", "fr"].map(lang => choiceLabel(key, lang, "verification")))).toEqual([
    ["1번", "Option 1", "第1项", "1番", "1번"],
    ["2번", "Option 2", "第2项", "2番", "2번"],
    ["3번", "Option 3", "第3项", "3番", "3번"],
  ]);
  expect(offeredChoices({ keys: ["job-1", "job-2"] }, "en")).toEqual([{ key: "job-1", label: "Option 1" }, { key: "job-2", label: "Option 2" }]);
});

it("제안 키는 조사를 고르는 세 자리까지 받고, 조사를 고르는 키인지는 그 셋으로만 가린다", () => {
  for (const key of JOB_CHOICE_KEYS) expect(ChoiceKeySchema.safeParse(key).success, key).toBe(true);
  for (const key of ["job-0", "job-4", "job-", "pick-1"]) expect(ChoiceKeySchema.safeParse(key).success, key).toBe(false);
  expect([...CHOICE_KEYS, ...JOB_CHOICE_KEYS, "job-4"].filter(isJobChoice)).toEqual(["job-1", "job-2", "job-3"]);
});
