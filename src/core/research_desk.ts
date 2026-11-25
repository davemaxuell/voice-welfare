import type { Lang, SourceCitation, SpeechPrefs } from "./turn.ts";

export type Brevity = SpeechPrefs["length"];

export type JobPhase =
  | { readonly kind: "working" }
  | { readonly kind: "asking"; readonly revision: number | undefined }
  | { readonly kind: "ready" }
  | { readonly kind: "ended" };

export interface SavedJob {
  readonly id: string;
  readonly request: string;
  readonly language: Lang;
  readonly phase: JobPhase;
}

export interface Reading {
  readonly jobId: string;
  readonly speech: string;
  readonly lang: Lang;
  readonly sources: readonly SourceCitation[];
}

export interface ResearchDesk {
  recent(limit: number): Promise<readonly SavedJob[]>;
  delegate(idempotencyKey: string, goal: string): Promise<{ jobId: string } | undefined>;
  read(jobId: string, brevity: Brevity): Promise<Reading | undefined>;
}
