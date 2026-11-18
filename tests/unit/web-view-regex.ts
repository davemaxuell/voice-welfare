import { digestPatterns as d, needlePattern } from "../../src/agents/web/digest.ts";
import { effectPatterns as e } from "../../src/agents/web/effect.ts";

export const webViewRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/agents/web/effect.py", new Map([
    ["e260d231ea796e3d935a", e.loading], ["4326695dc9e137c7bb50", e.newlines],
  ])],
  ["src/cheongeum/agents/web/digest.py", new Map([
    ["546b511c621f2fc69562", d.sentenceEnd], ["87d384e3ecfb46b4cb77", d.blocked],
    ["95c29df09a17be96aeb5", d.digit], ["4326695dc9e137c7bb50", d.newlines],
    ["d313f6c20d60caa54ce1", d.selected], ["4e7d97ccd5d741ffc4a5", d.spaces],
    ["6384224380252f55eaa8", d.utilityButton], ["d2ec29aee520f4f8390d", d.trailer],
    ["2235032ec6d629d61414", d.utility], ["26e80e41be685fb293cf", d.uiLine],
    ["743456104ae25e056ff9", d.searchResults], ["e47389898565f9eedd6d", needlePattern("지금 신청")!],
  ])],
]);
