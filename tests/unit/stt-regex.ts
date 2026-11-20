import { requiredPattern } from "./regex-match-mode.ts";
import { sttPatterns } from "../../src/voice/stt.ts";

const entries = new Map<string, RegExp>([
  ["a30e782a7e868073c171", requiredPattern(sttPatterns.englishTerms[0])],
  ["f72ed3a2d003e5981796", requiredPattern(sttPatterns.englishTerms[1])],
  ["0b79573c97e446948138", requiredPattern(sttPatterns.englishTerms[2])],
  ["da8ec77a0cecff09a6a8", requiredPattern(sttPatterns.englishTerms[3])],
  ["d8c798c553d6f5d0c0ed", requiredPattern(sttPatterns.englishTerms[4])],
  ["56cac813edeffdb3677e", requiredPattern(sttPatterns.englishTerms[5])],
  ["0eeee51b7d871c868171", requiredPattern(sttPatterns.englishTerms[6])],
  ["da0c874b6e3de043ecdc", requiredPattern(sttPatterns.englishTerms[7])],
  ["c86dd2df578a84d50967", sttPatterns.trailing], ["4e7d97ccd5d741ffc4a5", sttPatterns.spaces],
  ["6dee788888fab468ff94", sttPatterns.hallucination], ["19cdaae3ebb5982a3cc2", sttPatterns.leading],
]);
export const sttRegexPorts = new Map([["src/cheongeum/voice/stt.py", entries]]);
