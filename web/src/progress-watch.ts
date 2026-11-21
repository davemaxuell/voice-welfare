import type { api } from "./api.ts";

type Report = Awaited<ReturnType<typeof api.progress>>;

interface ProgressWatch {
  poll(): Promise<Report>;
  isCurrent(): boolean;
  apply(report: Report): void;
  considerSpeech(report: Report): void;
  wait(next: () => void): () => void;
}

export function watchProgress({ poll, isCurrent, apply, considerSpeech, wait }: ProgressWatch) {
  let stopped = false;
  let previous: Report | undefined;
  const current = () => !stopped && isCurrent();
  async function tick() {
    if (!current()) return;
    const report = await poll().catch(() => undefined);
    if (!current()) return;
    if (report !== undefined) {
      if (previous?.seq !== report.seq || previous.activity !== report.activity) apply(report);
      previous = report;
      if (current()) considerSpeech(report);
    }
    if (current()) cancelWait = wait(() => void tick());
  }
  let cancelWait = wait(() => void tick());
  return () => {
    stopped = true;
    cancelWait();
  };
}
