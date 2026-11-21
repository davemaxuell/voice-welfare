export type Stage = "input-received" | "first-state-paint" | "turn-sent" | "result-applied" | "turn-failed"
  | "stop-requested" | "local-stop-shown" | "cancel-acknowledged" | "stopped-state-paint"
  | "microphone-requested" | "track-live" | "capture-end" | "transcript-shown"
  | "speech-requested" | "first-audio" | "overlay-loaded" | "figure-visible";

export interface TimingRecord {
  stage: Stage;
  durationMs: number;
  turn: number;
  cancelled: boolean;
}

interface TimingData { records: TimingRecord[]; commits: number }
declare global { interface Window { cheongeumPerf?: TimingData } }

export interface TimingPoint { time: number; record: TimingRecord }

export class ClientTiming {
  readonly data: TimingData = { records: [], commits: 0 };
  private sequence = 0;
  private lastCancelled = -1;
  private pending = new Set<number>();

  mark(stage: Stage, turn = this.sequence, since?: number): TimingPoint {
    const name = `cheongeum:${stage}`;
    performance.clearMarks(name);
    const time = performance.mark(name, { detail: turn }).startTime;
    const record = { stage, durationMs: since === undefined ? 0 : time - since, turn, cancelled: false };
    this.data.records.push(record);
    if (this.data.records.length > 2048) this.data.records.shift();
    return { time, record };
  }

  begin(stage: "input-received" | "capture-end") {
    const turn = ++this.sequence;
    this.pending.add(turn);
    return this.mark(stage, turn);
  }

  measure(from: TimingPoint | undefined, to: Stage) {
    if (from === undefined || from.record.cancelled || from.record.turn <= this.lastCancelled) return;
    const { turn } = from.record;
    if (to === "result-applied" || to === "turn-failed") this.pending.delete(turn);
    return this.mark(to, turn, from.time);
  }

  cancelPending() {
    for (const record of this.data.records) {
      if (this.pending.has(record.turn)) record.cancelled = true;
    }
    this.pending.clear();
    this.lastCancelled = this.sequence++;
  }

  stop() {
    this.cancelPending();
    return this.mark("stop-requested");
  }

  afterPaint(from: TimingPoint | undefined, to: Stage, visible: () => boolean = () => true) {
    if (from === undefined) return;
    requestAnimationFrame(() => {
      if (visible() && !document.hidden) requestAnimationFrame(() => this.measure(from, to));
    });
  }
}

export const timing = typeof window !== "undefined" && new URLSearchParams(window.location?.search).get("perf") === "1"
  ? new ClientTiming() : undefined;
if (timing !== undefined) window.cheongeumPerf = timing.data;
