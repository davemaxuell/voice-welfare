import { fullMatchExpression } from "./regex-match-mode.ts";
import { ORDINAL_REPLY } from "../../src/understanding/understand.ts";
import { LOCAL_LLM_URL } from "../../src/core/llm.ts";

export const plannerRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/core/llm.py", new Map([["d6c33c765b6c52323c93", LOCAL_LLM_URL]])],
  ["src/cheongeum/understanding/understand.py", new Map([
    ["900a8b5978211c790f86", fullMatchExpression(ORDINAL_REPLY)],
  ])],
]);
