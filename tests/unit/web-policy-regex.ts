import { authPatterns } from "../../src/agents/web/auth_page.ts";
import { profilePatterns } from "../../src/agents/web/profile.ts";
import { playbookPatterns } from "../../src/agents/web/playbook.ts";

export const webPolicyRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/agents/web/profile.py", new Map([
    ["2878bb5d562d65695b5b", profilePatterns.term],
    ["75c1cbdb59bc0f7a215c", profilePatterns.nameFiller],
    ["4e7d97ccd5d741ffc4a5", profilePatterns.spaces],
    ["893cf82482c048eaef60", profilePatterns.koreanName],
    ["4e0add375e3259f13e61", profilePatterns.englishName],
    ["76cc06db3a464f43c1ed", profilePatterns.road],
    ["95c29df09a17be96aeb5", profilePatterns.digit],
    ["c4cd9d0cd103e7dd2b63", profilePatterns.nonDigit],
    ["e632f552c6c38b89a575", profilePatterns.phone],
    ["956c786e68a94a136d93", profilePatterns.digits],
    ["eb3b470d3cb7758b90cf", profilePatterns.no],
    ["d24be1e0b5cb9ff4de97", profilePatterns.yes],
    ["bba4203b771c4a1e0b23", profilePatterns.unsure],
    ["9ec0e8ec361d822dda9b", profilePatterns.absent],
    ["ec64f16496e0cdc889ab", profilePatterns.present],
    ["680883c2068e76ca17a8", profilePatterns.absentOption],
    ["e67d2d51d1e3bd4bcd66", profilePatterns.presentOption],
    ["5983daea0175589ad046", profilePatterns.receipt],
  ])],
  ["src/cheongeum/agents/web/auth_page.py", new Map([
    ["938ece3aec8318056539", authPatterns.login],
    ["2d8595216fcfd4d6ce74", authPatterns.pass],
    ["cf54a072da200c803478", authPatterns.kakao],
    ["48945fc50c56ec8f9d32", authPatterns.naver],
    ["82d7c3d9f53163534e8e", authPatterns.toss],
    ["20571991b7395b5a4da1", authPatterns.certificate],
  ])],
  ["src/cheongeum/agents/web/playbook.py", new Map([
    ["9a31e22043def8a9a829", playbookPatterns.www],
    ["95c29df09a17be96aeb5", playbookPatterns.digit],
  ])],
]);
