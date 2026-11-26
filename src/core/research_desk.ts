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
  readonly savedOn: string;
}

export interface Reading {
  readonly jobId: string;
  readonly speech: string;
  readonly lang: Lang;
  readonly sources: readonly SourceCitation[];
  readonly receipt?: { readonly token: string };
}

export type AnswerOutcome = "queued" | "stale" | "unsafe" | "refused";

interface PickOption { readonly jobId: string }
export type SavedPick =
  | { readonly action: "read" | "cancel"; readonly options: readonly PickOption[] }
  | { readonly action: "answer"; readonly answer: string; readonly options: readonly (PickOption & { readonly revision: number | undefined })[] };

export interface ResearchDesk {
  recent(limit: number): Promise<readonly SavedJob[]>;
  delegate(idempotencyKey: string, goal: string): Promise<{ jobId: string } | undefined>;
  read(jobId: string, brevity: Brevity): Promise<Reading | undefined>;
  answer(jobId: string, revision: number, text: string): Promise<AnswerOutcome>;
  cancel(jobId: string): Promise<{ request: string; token?: string } | undefined>;
}
