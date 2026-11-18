import { sttPatterns } from "../../src/voice/stt.ts";

const entries = new Map<string, RegExp>([
  ["d0074d3b6b42c946f2ef", sttPatterns.promptBoundary], ["c86dd2df578a84d50967", sttPatterns.trailing],
  ["4e7d97ccd5d741ffc4a5", sttPatterns.spaces], ["6dee788888fab468ff94", sttPatterns.hallucination],
  ["19cdaae3ebb5982a3cc2", sttPatterns.leading],
]);
const terms = ["2c0736d5d24bea351478","f72ed3a2d003e5981796","edadba19a6394fb512cf","f4ea70c3299f13b6fd81",
  "aa2df0e5af176d4ad619","4340579c03fe773e6f14","72465c742100d2c4eed1"];
for (const [i,id] of terms.entries()) entries.set(id, sttPatterns.englishTerms[i]!);
export const sttRegexPorts = new Map([["src/cheongeum/voice/stt.py", entries]]);
