import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  EXPLICIT_APPROVE_KO, ackKind, agree, approval, authInputDone, cancelReply, commandKey, doneReply, foreignApproval,
  lexiconPatterns, wholeRejection,
} from "../../src/core/lexicon.ts";

it.each([
  ["승인", "ko", "approve"], ["모의접수 승인", "ko", "approve"], ["응", "ko", "approve"],
  ["눌러줘", "ko", "approve"], ["보내줘", "ko", "approve"],
  ["아니", "ko", "reject"], ["보내지 마", "ko", "reject"],
  ["이 버튼 눌러도 돼?", "ko", undefined], ["응 근데 이거 뭐야", "ko", undefined], ["Yes, go ahead", "en", "approve"],
  ["no", "en", "reject"], ["승인", "en", undefined], ["はい", "ja", "approve"], ["取消", "zh", "reject"],
] as const)("test_approval", (text, lang, want) => {
  expect(approval(text, lang)).toBe(want);
});

it("test_foreign_approval_ignores_korean_sessions", () => {
  expect(foreignApproval("응", "ko")).toBeUndefined();
});

it.each([
  ["어", "yes"], ["맞아요", "yes"], ["yes", "yes"], ["はい", "yes"], ["아냐", "no"], ["不对", "no"], ["글쎄", undefined],
] as const)("test_agree", (text, want) => {
  expect(agree(text)).toBe(want);
});

it.each([["알았어요.", "ack"], ["괜찮아", "no"], ["알았어 다음", undefined]] as const)("test_ack_kind", (text, want) => {
  expect(ackKind(text)).toBe(want);
});

it.each([["다 했어요", true], ["I'm done", true], ["다음으로", false]] as const)("test_done_reply", (text, want) => {
  expect(doneReply(text)).toBe(want);
});

it("test_login_secret_exemption_requires_the_whole_reply", () => {
  expect(doneReply("I'm done", { whole: true })).toBe(true);
  expect(doneReply("apple done tree", { whole: true })).toBe(false);
});

it.each([["인증 취소", true], ["cancel", true], ["취소 수수료 얼마야", false]] as const)("test_cancel_reply", (text, want) => {
  expect(cancelReply(text)).toBe(want);
});

it.each([
  "Please don't cancel", "What happens if I cancel?", "인증 취소하지 마세요", "不要取消", "キャンセルしないでください",
])("test_sign_in_cancellation_respects_the_whole_reply", text => {
  expect(cancelReply(text)).toBe(false);
});

it.each([
  "I'm not done yet", "I'll let you know when I'm done", "로그인 완료했어?",
  "인증을 다 했어요, 아니 아직이에요", "别以为我已经完成了", "「終わりました」とは言っていません",
])("test_sign_in_completion_requires_an_affirmative_statement", text => {
  expect(doneReply(text)).toBe(false);
});

it.each(["인증이 끝났어요.", "로그인했어요", "I’m done.", "完成了。", "終わりました！"])("test_sign_in_accepts_complete_spoken_statements", text => {
  expect(doneReply(text)).toBe(true);
});

// 아래는 pyref(77aad3e)의 cheongeum.core.lexicon을 같은 말에 돌린 결과와 맞춘다. 만드는 법은 tests/fixtures/core/generate.py.
const outcome = z.enum(["approve", "reject"]);
const row = z.strictObject({
  a: z.record(z.string(), outcome).optional(), w: z.array(z.string()).optional(), g: z.enum(["yes", "no"]).optional(),
  k: z.enum(["ack", "no"]).optional(), i: z.literal(true).optional(), d: z.literal(true).optional(),
  dw: z.literal(true).optional(), c: z.literal(true).optional(), x: z.literal(true).optional(),
});
const fixture = z.object({
  cases: z.array(z.tuple([z.string(), row])),
  keys: z.array(z.tuple([z.string(), z.string()])),
  sets: z.object({ yes: z.array(z.string()), no: z.array(z.string()) }),
  sources: z.object({
    approve: z.record(z.string(), z.string()), reject: z.record(z.string(), z.string()),
    explicitApproveKo: z.string(), plainYesKo: z.string(), rejectKo: z.string(), authAck: z.string(), authInputDone: z.string(),
    done: z.array(z.string()), cancel: z.array(z.string()), ack: z.array(z.string()),
  }),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/lexicon.json", import.meta.url), "utf8")));

const LANGS = ["ko", "en", "zh", "ja"] as const;

function summarize(text: string) {
  const summary: Record<string, unknown> = {};
  const approvals = Object.fromEntries(LANGS.flatMap(lang => {
    const answer = approval(text, lang);
    return answer === undefined ? [] : [[lang, answer]];
  }));
  if (Object.keys(approvals).length > 0) summary.a = approvals;
  const whole = LANGS.filter(lang => wholeRejection(text, lang));
  if (whole.length > 0) summary.w = whole;
  const agreed = agree(text);
  if (agreed !== undefined) summary.g = agreed;
  const acknowledged = ackKind(text);
  if (acknowledged !== undefined) summary.k = acknowledged;
  if (authInputDone(text)) summary.i = true;
  if (doneReply(text)) summary.d = true;
  if (doneReply(text, { whole: true })) summary.dw = true;
  if (cancelReply(text)) summary.c = true;
  if (EXPLICIT_APPROVE_KO.test(text)) summary.x = true;
  return summary;
}

it("승인·거절·동의·끝남·취소·맞장구 판정이 기록한 말마다 Python과 같다", () => {
  expect(fixture.cases.length).toBeGreaterThan(4000);
  const different = fixture.cases.flatMap(([text, expected]) => {
    const actual = summarize(text);
    return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ text, expected, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it("İ와 ı, 켈빈 기호, 긴 s는 Python I 표지와 같게 맞는다", () => {
  expect(approval("İ approve", "en")).toBe("approve");
  expect(approval("ı approve", "en")).toBeUndefined();
  expect(approval("confİrm", "en")).toBe("approve");
  expect(approval("yeſ", "en")).toBe("approve");
  expect(approval("oK", "en")).toBe("approve");
  expect(approval("yesı", "en")).toBeUndefined();
  expect(approval("yesİ", "en")).toBeUndefined();
  expect(doneReply("fİnİshed")).toBe(true);
});

it("명령 키는 casefold한 말에서 끝 문장부호와 모든 공백을 뺀다", () => {
  const different = fixture.keys.flatMap(([text, expected]) => commandKey(text) === expected ? [] : [{ text, expected, actual: commandKey(text) }]);
  expect(different).toEqual([]);
});

it("동의·부정 낱말 목록이 Python과 같다", () => {
  for (const word of fixture.sets.yes) expect(agree(word), word).toBe("yes");
  for (const word of fixture.sets.no) expect(agree(word), word).toBe("no");
  expect(agree("")).toBeUndefined();
});

it("모르는 언어 이름이나 객체 속성 이름은 승인·거절로 읽지 않는다", () => {
  for (const lang of ["", "fr", "constructor", "__proto__", "toString"]) {
    expect(approval("yes", lang)).toBeUndefined();
    expect(wholeRejection("no", lang)).toBe(false);
    expect(foreignApproval("yes", lang)).toBeUndefined();
  }
  expect(foreignApproval("yes", "en")).toBe("approve");
});

function nonAscii(source: string): string {
  return [...source].filter(char => (char.codePointAt(0) ?? 0) > 127 && char !== "İ" && char !== "ı").sort((a, b) => a.localeCompare(b, "en")).join("");
}

it("정규식 속 한글·한자·가나는 Python 원문과 한 글자도 다르지 않다", () => {
  const { sources } = fixture;
  const pairs: [string, string | undefined, string][] = [
    ["approve en", lexiconPatterns.approve.get("en")?.source, sources.approve.en ?? ""],
    ["approve zh", lexiconPatterns.approve.get("zh")?.source, sources.approve.zh ?? ""],
    ["approve ja", lexiconPatterns.approve.get("ja")?.source, sources.approve.ja ?? ""],
    ["reject en", lexiconPatterns.reject.get("en")?.source, sources.reject.en ?? ""],
    ["reject zh", lexiconPatterns.reject.get("zh")?.source, sources.reject.zh ?? ""],
    ["reject ja", lexiconPatterns.reject.get("ja")?.source, sources.reject.ja ?? ""],
    ["explicit approve", lexiconPatterns.explicitApproveKo.source, sources.explicitApproveKo],
    ["plain yes", lexiconPatterns.plainYesKo.source, sources.plainYesKo],
    ["reject ko", lexiconPatterns.rejectKo.source, sources.rejectKo],
    ["auth ack", lexiconPatterns.authAck.source, sources.authAck],
    ["auth input done", lexiconPatterns.authInputDone.source, sources.authInputDone],
    ["ack", lexiconPatterns.ack.source, sources.ack[0] ?? ""],
    ["no", lexiconPatterns.no.source, sources.ack[1] ?? ""],
    ...sources.done.map((source, index): [string, string | undefined, string] => [`done ${index}`, lexiconPatterns.done[index]?.source, source]),
    ...sources.cancel.map((source, index): [string, string | undefined, string] => [`cancel ${index}`, lexiconPatterns.cancel[index]?.source, source]),
  ];
  expect(sources.done).toHaveLength(lexiconPatterns.done.length);
  expect(sources.cancel).toHaveLength(lexiconPatterns.cancel.length);
  for (const [name, ported, python] of pairs) expect(nonAscii(ported ?? ""), name).toBe(nonAscii(python));
});
