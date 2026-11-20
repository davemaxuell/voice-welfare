import { sessionRegexPorts77 } from "./session-regex-77.ts";
import { webAgentRegexPorts77 } from "./webagent-regex-77.ts";
import { recognizerRegexPorts } from "./recognizer-regex.ts";
import { sttRegexPorts } from "./stt-regex.ts";
import { evaluationRegexPorts } from "./evaluation-regex.ts";
import { formSkillRegexPorts } from "./form-skill-regex.ts";
import { browseSkillRegexPorts } from "./browse-skill-regex.ts";
import { personalRegexPorts } from "./personal-regex.ts";
import { welfareRegexPorts } from "./welfare-regex.ts";
import { documentPatterns } from "../../src/agents/web/docs.ts";
import { browserRegexPorts } from "./browser-regex.ts";
import { webAgentRegexPorts } from "./web-agent-regex.ts";
import { webViewRegexPorts } from "./web-view-regex.ts";
import { webPolicyRegexPorts } from "./web-policy-regex.ts";
import { privacyRegexPorts } from "./privacy-regex.ts";
import { policyRegexPorts } from "./policy-regex.ts";
import { speechRegexPorts } from "./speech-regex.ts";
import { plannerRegexPorts } from "./planner-regex.ts";
import { ruleRegexPorts } from "./understanding-rules-regex.ts";

// Python 파일별로 지문과 제품 코드에서 가져온 RegExp를 짝짓는다. 같은 식을 다른 파일이 따로 옮길 수 있다.
const sessionRegexPorts = new Map([["src/cheongeum/orchestrator/session.py", sessionRegexPorts77]]);
const documentRegexPorts = new Map([["src/cheongeum/agents/web/docs.py", new Map([
  ["ccb516f0c08a9a300999", documentPatterns.lineEnd], ["4e7d97ccd5d741ffc4a5", documentPatterns.spaces],
])]]);
const registry = new Map<string, Map<string, RegExp>>();
for (const group of [
  sttRegexPorts, evaluationRegexPorts, formSkillRegexPorts, sessionRegexPorts, browseSkillRegexPorts,
  ruleRegexPorts, plannerRegexPorts, privacyRegexPorts, policyRegexPorts, speechRegexPorts,
  webViewRegexPorts, webPolicyRegexPorts, browserRegexPorts, webAgentRegexPorts, documentRegexPorts,
  welfareRegexPorts, personalRegexPorts, recognizerRegexPorts, webAgentRegexPorts77,
]) {
  for (const [source, entries] of group) {
    const patterns = registry.get(source) ?? new Map<string, RegExp>();
    for (const [id, expression] of entries) {
      const existing = patterns.get(id);
      if (existing !== undefined && (existing.source !== expression.source || existing.flags !== expression.flags)) {
        throw new Error(`conflicting native regex for ${source} ${id}`);
      }
      patterns.set(id, expression);
    }
    registry.set(source, patterns);
  }
}
export const regexPorts: ReadonlyMap<string, ReadonlyMap<string, RegExp>> = registry;
