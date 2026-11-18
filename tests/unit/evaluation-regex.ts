import { evaluationPatterns } from "../../src/evaluation/index.ts";
import { asrPatterns } from "../../src/evaluation/asr.ts";

export const evaluationRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/evaluation/asr.py", new Map([
    ["c187f8f807176ab5a848", asrPatterns.separators],
    ["b77aaf93eca569c02b13", asrPatterns.runs],
  ])],
  ["src/cheongeum/evaluation/__init__.py", new Map([
    ["a850f59abb7f4e070060", evaluationPatterns.phone],
    ["92c7383cf082644a0c3c", evaluationPatterns.secret],
    ["d45e12b4d28d0dca034a", evaluationPatterns.password],
  ])],
]);
