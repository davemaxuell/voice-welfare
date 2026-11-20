import { browserPatterns } from "../../src/agents/web/browser/index.ts";

export const browserRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/agents/web/browser/__init__.py", new Map([
    ["494a3bd9e98968c081da", browserPatterns.attributeQuotes],
  ])],
]);
