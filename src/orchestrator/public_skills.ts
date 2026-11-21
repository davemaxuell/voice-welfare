import type { Fact } from "./public_task.ts";

export const publicResearchSkills = {
  "find-official-documents": {
    version: 1,
    tools: ["official-catalog", "search", "fetch"],
    instruction: "Find the official list of required documents for the named service. Cite the list and keep applicant conditions and exceptions with the documents.",
  },
  "check-a-claim": {
    version: 1,
    tools: ["search", "fetch"],
    instruction: "Compare the claim with the authoritative source. Say whether the quoted passage supports or contradicts it. If the source is silent, describe that limit and never imply the claim is true or false.",
  },
} as const;

export function researchSkill(facts: readonly Fact[], question: string): keyof typeof publicResearchSkills | undefined {
  if (/사실인지|맞는지|verify (?:that|the claim)|check (?:whether|the claim)|是否属实|本当か/iu.test(question)) return "check-a-claim";
  if (facts.includes("documents") || /서류|documents|材料|書類/iu.test(question)) return "find-official-documents";
  return undefined;
}
