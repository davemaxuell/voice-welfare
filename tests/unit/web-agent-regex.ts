import { webAgentPatterns } from "../../src/agents/web/agent.ts";
import { autopilotPatterns } from "../../src/agents/web/autopilot.ts";

export const webAgentRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/agents/web/agent.py", new Map([
    ["d7eebff197234bbbd9fd", webAgentPatterns.assistSecret], ["3060819c2155e45416c0", webAgentPatterns.checked],
  ])],
  ["src/cheongeum/agents/web/autopilot.py", new Map([
    ["f199594c6ad5754ceccf", autopilotPatterns.han], ["0eeafd6cc65e098170f7", autopilotPatterns.hangul],
    ["cbc188bb11adef9dd8f3", autopilotPatterns.http], ["9326ee9ffb0b37e5be90", autopilotPatterns.needsVisit],
  ])],
]);
