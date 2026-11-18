import { replyPatterns } from "../../src/orchestrator/replies.ts";

export const sessionRepliesRegex = new Map<string, RegExp>([
  ["47b281f3ae3997d983b4", replyPatterns.phone],
  ["15fad4a625d2109778d2", replyPatterns.moreServices],
  ["d3b9e76bd0aaadba1f81", replyPatterns.ordinal],
  ["8a1ba202ce0b7b2e4e2e", replyPatterns.thisField],
]);
