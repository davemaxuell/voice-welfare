import { z } from "zod";

export const ResearchSource = z.object({
  title: z.string().max(360), url: z.string().max(4096),
  lastCheckedAt: z.string().optional(), version: z.string().optional(),
});
export const ResearchProof = z.object({ quote: z.string().min(1).max(2800), url: z.string().max(4096) });
export const ResearchStop = z.enum([
  "verified", "needs_input", "source_unavailable", "no_progress", "budget", "policy", "cancelled", "interrupted", "lease_lost",
]);
export type ResearchStop = z.infer<typeof ResearchStop>;

export const ResearchFinding = z.object({
  text: z.string().min(1).max(4800), sources: z.array(ResearchSource).min(1).max(8),
  proof: z.array(ResearchProof).min(1).max(32),
});
export const ResearchStep = z.object({
  requirement: z.string().min(1).max(1200),
  attempts: z.number().int().min(0).max(2),
  clarification: z.string().max(600).optional(),
  outcome: z.discriminatedUnion("status", [
    z.object({ status: z.literal("verified"), finding: ResearchFinding }),
    z.object({ status: z.literal("unavailable") }),
    z.object({ status: z.literal("waiting"), question: z.string().min(1).max(1200) }),
  ]).optional(),
});
export const ResearchPlan = z.object({
  route: z.enum(["welfare", "browser", "places", "quiet"]),
  goal: z.string().min(1).max(1200), subject: z.string().max(1200),
  agency: z.string().max(160).optional(),
  exclusions: z.array(z.string().max(40)).max(5),
  steps: z.array(ResearchStep).min(2).max(32),
});
export const ResearchCheckpoint = z.object({
  version: z.literal(1),
  activeMs: z.number().int().nonnegative(), continuations: z.number().int().nonnegative(),
  plan: ResearchPlan,
});
export type ResearchPlan = z.infer<typeof ResearchPlan>;
export type ResearchCheckpoint = z.infer<typeof ResearchCheckpoint>;
export type ResearchFinding = z.infer<typeof ResearchFinding>;

export interface ResearchOutcome<Source = { url?: string; title?: string | null; lastCheckedAt?: string; version?: string }> {
  text?: string | null;
  sources?: readonly Source[];
  proof?: readonly z.infer<typeof ResearchProof>[];
  data?: { kind: "live" | "stored" | "private-program"; origin: string; date?: string };
  missing?: readonly string[];
  reason?: ResearchStop;
}

export interface ResearchProgress {
  readonly checkpoint: ResearchCheckpoint | undefined;
  readonly signal: AbortSignal;
  save(plan: ResearchPlan): Promise<ResearchPlan>;
}

export function researchSummary(plan: ResearchPlan, budget = false): [string, ResearchOutcome<z.infer<typeof ResearchSource>>] {
  const verified = plan.steps.flatMap(step => step.outcome?.status === "verified" ? [step.outcome.finding] : []);
  const missing = plan.steps.filter(step => step.outcome?.status !== "verified").map(step => step.requirement);
  const question = plan.steps.find(step => step.outcome?.status === "waiting")?.outcome;
  const notes = verified.map(finding => finding.text);
  if (question?.status === "waiting") notes.push(question.question);
  const state = question ? "needs_input" : missing.length === 0 ? "completed" : verified.length > 0 ? "partial" : "incomplete";
  const reason = question ? "needs_input" : missing.length === 0 ? "verified" : budget ? "budget" : "source_unavailable";
  return [state, {
    text: notes.join("\n\n"), sources: [...new Map(verified.flatMap(finding => finding.sources).map(source => [source.url, source])).values()],
    proof: verified.flatMap(finding => finding.proof), missing, reason,
  }];
}
