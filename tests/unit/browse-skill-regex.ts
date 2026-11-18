import { browsePatterns as b } from "../../src/agents/web/skills/browse.ts";
import { screenPatterns as s } from "../../src/speech/screen.ts";

export const browseSkillRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/agents/web/skills/browse.py", new Map([
    ["bb33b018381093bfb443", b.home], ["eed0412a8ca339965bb4", b.submit], ["a2eebd0c607469d2cbf4", b.detailed],
    ["4326695dc9e137c7bb50", b.newlines], ["4e7d97ccd5d741ffc4a5", b.spaces], ["d3b9e76bd0aaadba1f81", b.numbered],
    ["707b490467f38ef23218", b.sitePrefix], ["9a31e22043def8a9a829", b.www], ["1f44fa11852be6a21ef7", b.next],
    ["6579b77d3e132c3a7fd7", b.prev],
  ])],
  ["src/cheongeum/speech/screen.py", new Map([
    ["fbccf56fa5f6d2ac9566", s.instructions], ["4326695dc9e137c7bb50", s.newlines], ["2422a527f0956a894ea9", s.stepPrefix],
  ])],
]);
