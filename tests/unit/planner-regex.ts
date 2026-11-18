import { LOCAL_LLM_URL } from "../../src/core/llm.ts";
import { ORDINAL_REPLY } from "../../src/understanding/understand.ts";

export const plannerRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/core/llm.py", new Map([["d6c33c765b6c52323c93", LOCAL_LLM_URL]])],
  ["src/cheongeum/understanding/understand.py", new Map([["7d92dbdf2031dfb3b6fa", ORDINAL_REPLY]])],
]);
