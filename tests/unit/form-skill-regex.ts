import { guidedPatterns as g } from "../../src/agents/web/skills/guided.ts";

export const formSkillRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/agents/web/skills/guided.py", new Map([
    ["41179248a7e6be5ce77d", g.secret], ["e67ffdce8f59db3daa71", g.start], ["7c0ce9902660251be76c", g.skip],
    ["ec73a5df604c40ef54ec", g.stop], ["f79e77c56293e4d8deef", g.no], ["c8d533d36add9e5ae22a", g.yesPrefix],
    ["755371e8c19b6336f4c2", g.yes], ["3ed0712384e594bafff7", g.onlyYes],
  ])],
]);
