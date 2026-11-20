import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { foreignVaultSave, parsePersonalCommand, parseSpeechPref } from "../../src/personal/commands.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.personal.commands를 같은 말에 돌린 결과다. 만드는 법은 tests/fixtures/personal/generate.py.
const saved = z.tuple([z.enum(["en", "zh", "ja"]), z.record(z.string(), z.string())]);
const fixture = z.object({
  foreignVaultSave: z.array(z.tuple([z.string(), saved.nullable()])),
  foreignVaultSaveCorpus: z.array(z.tuple([z.string(), saved])),
  speechPrefs: z.array(z.tuple([z.string(), z.json(), z.json()])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/personal/commands.json", import.meta.url), "utf8")));
const corpus = z.array(z.string()).parse(JSON.parse(readFileSync(new URL("../fixtures/regex/corpus.json", import.meta.url), "utf8")));

it("다른 언어의 저장 요청을 기록한 Python 답과 같게 알아본다", () => {
  expect(fixture.foreignVaultSave.length).toBeGreaterThan(1500);
  const different = fixture.foreignVaultSave.flatMap(([text, expected]) => {
    const actual = foreignVaultSave(text) ?? null;
    return isDeepStrictEqual(actual, expected) ? [] : [{ text, expected, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it("말뭉치에서는 Python이 답한 문장에만 답한다", () => {
  const recorded = new Map(fixture.foreignVaultSaveCorpus);
  const different = corpus.flatMap(text => {
    const actual = foreignVaultSave(text) ?? null;
    const expected = recorded.get(text) ?? null;
    return isDeepStrictEqual(actual, expected) ? [] : [{ text, expected, actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});

it.each([
  ["Please save my name is Kim Haneul", "en", { name: "Kim Haneul" }],
  ["my name is Kim Haneul, please save it", "en", { name: "Kim Haneul" }],
  ["save my name is Kim Haneul, and my phone number: 01012345678, and my email address is a@b.co", "en",
    { name: "Kim Haneul", phone: "01012345678", email: "a@b.co" }],
  ["save my name is 김하늘", "en", { name: "김하늘" }],
  ["请记住我的名字是金夏兰", "zh", { name: "金夏兰" }],
  ["私の名前は金ハヌルです。覚えてください", "ja", { name: "金ハヌル" }],
  ["save the name", "en", {}],
  ["save my name is 비밀번호 1234", "en", {}],
] as const)("저장 요청 %s", (text, lang, values) => {
  expect(foreignVaultSave(text)).toEqual([lang, values]);
});

it.each(["내 이름은 김하늘이라고 저장해줘", "save my password is 1234", "what is my name", "save", ""])("저장 요청이 아닌 말 %j", text => {
  expect(foreignVaultSave(text)).toBeUndefined();
});

it("말 끝에 영문자가 붙으면 낱말 경계가 아니라서 칸 이름으로 읽지 않는다", () => {
  expect(foreignVaultSave("save my name김하늘")).toBeUndefined();
  expect(foreignVaultSave("save my name is atKim")).toEqual(["en", { name: "atKim" }]);
});

it("방금 들은 말을 다시 천천히·빨리 들려 달라는 부탁은 말하기 설정을 바꾸지 않는다", () => {
  for (const text of ["그 번호를 다시 천천히 말해줘", "이거 좀 더 천천히 말해줘", "번호만 천천히 읽어줘", "다시 빨리 말해줘"]) {
    expect(parseSpeechPref(text), text).toBeUndefined();
    expect(parsePersonalCommand(text), text).toBeUndefined();
  }
  expect(parseSpeechPref("천천히 말해줘")).toEqual({ kind: "speech-set", values: { rate: 0.9 } });
  expect(parseSpeechPref("빨리")).toEqual({ kind: "speech-set", values: { rate: 1.5 } });
});

it("말하기 설정 명령이 기록한 Python 답과 같다", () => {
  const different = fixture.speechPrefs.flatMap(([text, pref, command]) => {
    const actual = [parseSpeechPref(text) ?? null, parsePersonalCommand(text, "2026-11-18") ?? null];
    return isDeepStrictEqual(actual, [pref, command]) ? [] : [{ text, expected: [pref, command], actual }];
  });
  expect(different.slice(0, 10)).toEqual([]);
});
