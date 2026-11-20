import { firstRunPatterns } from "../../src/orchestrator/first_run.ts";
import { fullMatchExpression, requiredPattern } from "./regex-match-mode.ts";
import { lexiconPatterns } from "../../src/core/lexicon.ts";

export const recognizerRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/core/lexicon.py", new Map([
    ["a3b0287976668a14a7a1", fullMatchExpression(lexiconPatterns.authInputDone)],
    ["cda0a6121e172cc9efda", fullMatchExpression(lexiconPatterns.explicitApproveKo)],
    ["2d7fc2999251b3275b2f", fullMatchExpression(lexiconPatterns.plainYesKo)],
    ["42bc5696ad8ee4368da0", fullMatchExpression(lexiconPatterns.cancel[0])],
    ["c92509e514618abe4769", fullMatchExpression(lexiconPatterns.cancel[1])],
    ["9b4326d5c8d56de57187", fullMatchExpression(lexiconPatterns.cancel[2])],
    ["0c2e4dbc8238bb4742ee", fullMatchExpression(lexiconPatterns.cancel[3])],
    ["7730f4e91f1c96bffda5", fullMatchExpression(lexiconPatterns.done[1])],
    ["61c2d11dc5739305b469", fullMatchExpression(lexiconPatterns.done[2])],
    ["ca3cf6ce0d3530eed6fc", fullMatchExpression(lexiconPatterns.done[3])],
    ["9d811534a7dd7263c9e3", fullMatchExpression(lexiconPatterns.done[4])],
    ["a84ae7c5f833c7b52be5", lexiconPatterns.ack],
    ["ad8c1a1b6018217cb4b0", lexiconPatterns.ackTail],
    ["61d11861041f9e4f57cf", lexiconPatterns.authAck],
    ["025c634691524a52695d", lexiconPatterns.no],
    ["578391a93f9c0d8a2f84", lexiconPatterns.rejectKo],
    ["c02b043e16886019d2a8", requiredPattern(lexiconPatterns.approve.get("en"))],
    ["afa04dd3f20d44c474a9", requiredPattern(lexiconPatterns.approve.get("ja"))],
    ["2e1b9d5bcee6c843b5d2", requiredPattern(lexiconPatterns.approve.get("zh"))],
    ["95d23453a68b3ecdcc0d", requiredPattern(lexiconPatterns.reject.get("en"))],
    ["0b24de18fa175f48f61a", requiredPattern(lexiconPatterns.reject.get("ja"))],
    ["6d25b92ddf14c94ae15a", requiredPattern(lexiconPatterns.reject.get("zh"))],
  ])],
  ["src/cheongeum/orchestrator/first_run.py", new Map([
    ["95c29df09a17be96aeb5", firstRunPatterns.digit],
    ["2c0d815d3f7615a7a474", firstRunPatterns.ending],
    ["b1ab6584f2f6eb289ce4", firstRunPatterns.filler],
    ["22ce0f8053d11a7ba22c", firstRunPatterns.prefix],
    ["23d98c0c9213e0049219", firstRunPatterns.punctuation],
    ["100a0d6fc572d3cdff82", firstRunPatterns.skip],
    ["4e7d97ccd5d741ffc4a5", firstRunPatterns.spaces],
  ])],
]);
