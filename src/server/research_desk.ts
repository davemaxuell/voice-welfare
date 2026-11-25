import { StoredResearch } from "../core/research.ts";
import type { ResearchDesk } from "../core/research_desk.ts";
import { LangSchema } from "../core/turn.ts";
import { hasReading } from "./workflow_store.ts";
import type { Workflows, WorkspaceSession } from "./workflows.ts";

export function createResearchDesk(flows: Workflows, session: WorkspaceSession): ResearchDesk {
  const permitted = () => flows.personal && session.consentStatus === "granted";
  const languageOf = (language: string) => LangSchema.safeParse(language).data ?? "ko";

  async function guarded<T>(work: () => Promise<T>): Promise<T | undefined> {
    const generation = session.generation;
    if (!permitted()) return undefined;
    const result = await work();
    return permitted() && session.generation === generation ? result : undefined;
  }

  return {
    async recent(limit) {
      const summaries = await guarded(async () => (await flows.store()).summaries(limit));
      return (summaries ?? []).map(({ id, prompt, language, phase }) => ({ id, request: prompt, language: languageOf(language), phase }));
    },

    async delegate(idempotencyKey, goal) {
      const generation = session.generation;
      if (!permitted()) return undefined;
      try {
        return { jobId: await flows.enqueue(session, idempotencyKey, goal, () => session.generation === generation) };
      } catch {
        return undefined;
      }
    },

    read: (jobId, brevity) => guarded(async () => {
      const job = (await (await flows.store()).jobs()).find(row => row.id === jobId);
      if (job === undefined || !hasReading(job)) return undefined;
      const sources = StoredResearch.safeParse(job.result).data?.sources ?? [];
      return {
        jobId, speech: flows.reading(session, job, brevity), lang: languageOf(job.language),
        sources: sources.map(source => ({ ...source, lastCheckedAt: source.lastCheckedAt ?? "" })),
      };
    }),
  };
}
