import { languagePatterns } from "../../src/language/i18n.ts";
import { phrasingPatterns } from "../../src/speech/phrasing.ts";

export const speechRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/language/i18n.py", new Map([
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
    ["c02b043e16886019d2a8", languagePatterns.approveEn],
    ["2e1b9d5bcee6c843b5d2", languagePatterns.approveZh],
    ["afa04dd3f20d44c474a9", languagePatterns.approveJa],
    ["95d23453a68b3ecdcc0d", languagePatterns.rejectEn],
    ["6d25b92ddf14c94ae15a", languagePatterns.rejectZh],
    ["0b24de18fa175f48f61a", languagePatterns.rejectJa],
    ["42901bb7f77144881cd7", languagePatterns.quoted],
    ["0eeafd6cc65e098170f7", languagePatterns.hangul],
    ["7c1bb68c085b828249f3", languagePatterns.parenthetical],
    ["77ed7c88f602b1859841", languagePatterns.koreanRun],
  ])],
  ["src/cheongeum/speech/phrasing.py", new Map([
    ["d656efa2eb40db26ea5d", phrasingPatterns.wordTail],
    ["e9aab0ba3c16ef2730cf", phrasingPatterns.digit],
    ["6a6d92a2f1ad1bce7697", phrasingPatterns.letterWithBatchim],
    ["0934420e79e582b668e6", phrasingPatterns.optionalLabel],
    ["a0ed00c89b3fd75971bf", phrasingPatterns.sentenceEnd],
  ])],
]);
