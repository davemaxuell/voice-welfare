import { vi } from "vitest";
import { z } from "zod";
import type { JobPhase, ResearchDesk, SavedJob } from "../../src/core/research_desk.ts";
import type { FakeLlm } from "../helpers.ts";

const unusedFields = {requestedFacts: [], exclusions: [], continuation: false, choices: []};
export const savedDecision = (action: "read" | "answer" | "cancel", jobs: string[], answer: string | null = null) =>
  ({public_service_decision: {kind: "saved_research", research: {action, jobs, answer}, ...unusedFields}});
export const savedJob = (id: string, request: string, phase: JobPhase): SavedJob => ({id, request, language: "ko", phase, savedOn: "2026-11-25"});

export function deskOf(jobs: SavedJob[]) {
  const recent = vi.fn<ResearchDesk["recent"]>(async limit => jobs.slice(0, limit));
  const read = vi.fn<ResearchDesk["read"]>(async jobId => ({
    jobId, speech: `‘${jobs.find(job => job.id === jobId)?.request}’ 조사 결과예요. 신분증을 준비하세요.`, lang: "ko", sources: [], receipt: {token: "receipt-" + jobId},
  }));
  const answer = vi.fn<ResearchDesk["answer"]>(async () => "queued");
  const cancel = vi.fn<ResearchDesk["cancel"]>(async jobId => {
    const request = jobs.find(job => job.id === jobId)?.request;
    return request === undefined ? undefined : {request, token: "receipt-" + jobId};
  });
  return {recent, read, answer, cancel, delegate: vi.fn<ResearchDesk["delegate"]>(async () => undefined)};
}

export const plannerPayloads = (model: FakeLlm) => model.calls.filter(call => call.schemaName === "public_service_decision")
  .map(call => z.record(z.string(), z.unknown()).parse(JSON.parse(call.user)));
