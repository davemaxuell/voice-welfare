import { applicationPatterns } from "../../src/orchestrator/application.ts";
export const applicationRegex = new Map<string, RegExp>([
  ["643023f6ed7baecd00d8", applicationPatterns.practice],
  ["8bb8d1bc74b2aa8aa404", applicationPatterns.pension],
  ["4e7d97ccd5d741ffc4a5", applicationPatterns.spaces],
]);
