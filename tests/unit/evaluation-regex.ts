import { evaluationPatterns } from "../../src/evaluation/index.ts";

export const evaluationRegexPorts = new Map<string, ReadonlyMap<string, RegExp>>([
  ["src/cheongeum/evaluation/__init__.py", new Map([
    ["a850f59abb7f4e070060", evaluationPatterns.phone],
    ["92c7383cf082644a0c3c", evaluationPatterns.secret],
    ["d45e12b4d28d0dca034a", evaluationPatterns.password],
  ])],
]);
