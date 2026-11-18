import { sessionPatterns } from "../../src/orchestrator/session.ts";
import { sessionRepliesRegex } from "./session-replies-regex.ts";
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
const sessionRegexPorts = new Map([["src/cheongeum/orchestrator/session.py", new Map([
  ...sessionRepliesRegex, ["90feeb3c23410707885e", sessionPatterns.sentences], ["6214c2c6a88b8833b37e", sessionPatterns.phraseEnd],
  ["95c29df09a17be96aeb5", sessionPatterns.digit], ["4e7d97ccd5d741ffc4a5", sessionPatterns.spaces], ["564904d269acdc070e31", sessionPatterns.doneReply],
])]]);
const documentRegexPorts = new Map([["src/cheongeum/agents/web/docs.py", new Map([
  ["ccb516f0c08a9a300999", documentPatterns.lineEnd], ["4e7d97ccd5d741ffc4a5", documentPatterns.spaces],
])]]);
export const regexPorts: ReadonlyMap<string, ReadonlyMap<string, RegExp>> = new Map([...sessionRegexPorts, ...browseSkillRegexPorts, ...ruleRegexPorts, ...plannerRegexPorts, ...privacyRegexPorts, ...policyRegexPorts, ...speechRegexPorts, ...webViewRegexPorts, ...webPolicyRegexPorts, ...browserRegexPorts, ...webAgentRegexPorts, ...documentRegexPorts, ...welfareRegexPorts, ...personalRegexPorts]);
