import { languagePatterns } from "../../src/language/i18n.ts";
import { phrasingPatterns } from "../../src/speech/phrasing.ts";

export const speechRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/language/i18n.py", new Map([
    ["4ab5adc72bd631271609", languagePatterns.addressLike],
    ["8ea23e09777916effa46", languagePatterns.englishWord],
    ["99d053cdf2c9a4d9a4a8", languagePatterns.figure],
    ["1be76c019cd4802cf8ca", languagePatterns.otherScript],
    ["4d7238de3aec37aabb4c", languagePatterns.koreanSwitch],
    ["9044590dec97eff570a7", languagePatterns.koreanRequest],
    ["86ad1c72ff02ae5ef67e", languagePatterns.englishSwitch],
    ["1f6fce40226be5bd1192", languagePatterns.chineseSwitch],
    ["52706b1425a7aef293c3", languagePatterns.japaneseSwitch],
    ["8ec620914e7203643d4e", languagePatterns.comma],
    ["4e7d97ccd5d741ffc4a5", languagePatterns.spaces],
    ["4e392fc0320071a73040", languagePatterns.nonLetters],
    ["658c1171617a234e6423", languagePatterns.latin],
    ["443f9d46ff052fd9d625", languagePatterns.kana],
    ["f199594c6ad5754ceccf", languagePatterns.han],
    ["f60256928012dbbf1737", languagePatterns.hangulOrJamo],
    ["42901bb7f77144881cd7", languagePatterns.quoted],
    ["0eeafd6cc65e098170f7", languagePatterns.hangul],
    ["7c1bb68c085b828249f3", languagePatterns.parenthetical],
    ["77ed7c88f602b1859841", languagePatterns.koreanRun],
  ])],
  ["src/cheongeum/speech/phrasing.py", new Map([
    ["dead1ec431691e872cc6", phrasingPatterns.barePhone],
    ["8f89ea13d544c5233ce0", phrasingPatterns.cueBefore],
    ["956c786e68a94a136d93", phrasingPatterns.digits],
    ["dc79114c8efa939b8f76", phrasingPatterns.fullPhone],
    ["d656efa2eb40db26ea5d", phrasingPatterns.wordTail],
    ["e9aab0ba3c16ef2730cf", phrasingPatterns.digit],
    ["6a6d92a2f1ad1bce7697", phrasingPatterns.letterWithBatchim],
    ["0934420e79e582b668e6", phrasingPatterns.optionalLabel],
    ["a0ed00c89b3fd75971bf", phrasingPatterns.sentenceEnd],
  ])],
]);
