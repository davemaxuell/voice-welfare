import { MODEL_STATUS, modelActivities } from "./model_status.ts";
import { AGENT_IDS, type Lang } from "./turn.ts";

const activities = {
  transcribing: {ko: "녹음한 말씀을 글로 옮기고 있어요.", en: "Transcribing your recording.", zh: "正在转写您的录音。", ja: "録音を文字に起こしています。"},
  planning: modelActivities.request,
  screen: modelActivities.page,
  searching: {ko: "공식 자료를 찾고 있어요.", en: "Looking for official guidance.", zh: "正在查找官方资料。", ja: "公式の案内を探しています。"},
  welfare: {ko: "복지 안내를 살펴보고 있어요.", en: "Checking benefit information.", zh: "正在查看福利信息。", ja: "福祉制度の案内を調べています。"},
  navigating: {ko: "페이지에서 다음 단계를 확인하고 있어요.", en: "Finding the next step on the page.", zh: "正在页面上查找下一步。", ja: "ページで次の手順を確認しています。"},
  permission: {ko: "요청하신 작업의 권한을 확인하고 있어요.", en: "Checking permission for this step.", zh: "正在检查这一步的权限。", ja: "この操作の権限を確認しています。"},
  executing: {ko: "요청하신 단계를 진행하고 있어요.", en: "Carrying out the requested step.", zh: "正在执行您要求的步骤。", ja: "ご依頼の操作を進めています。"},
  verifying: {ko: "결과를 확인하고 있어요.", en: "Checking the result.", zh: "正在核对结果。", ja: "結果を確認しています。"},
} satisfies Record<string, Record<Lang, string>>;

export function backendActivity(activity: keyof typeof activities) {
  const scope = MODEL_STATUS.getStore();
  if (scope) scope.begin(activity, activities[activity][scope.language]);
}

/** Trace notes may contain page text and private fields. Only the trusted phase and agent select a UI label. */
export function backendTrace(phase: string, agent: string) {
  switch (phase) {
    case "OBSERVING": return backendActivity("screen");
    case "VERIFYING": return backendActivity("verifying");
    case "POLICY_CHECK": return backendActivity("permission");
    case "EXECUTING": return backendActivity("executing");
    case "PLANNING":
      return backendActivity(agent === AGENT_IDS.web ? "navigating" : agent === AGENT_IDS.welfare ? "welfare" : "planning");
  }
}

export interface BackendStatus { seq: number; backend_status: string }

export class Progress {
  spoken = true;
  #reviews = 0;
  #running = false;
  #steps: string[] = [];
  #seq = 0;
  #backend = "";
  #recordings = new Map<symbol, string>();
  #owner?: symbol;
  #pass = 0;
  #listeners = new Set<(state: BackendStatus | null) => void>();
  #activity: string | null = null;
  #activitySpoken = false;
  #activitySeq = 0;
  #generation = 0;
  #quiet: string | null = null;
  #lastMilestone?: string;
  #queue: { seq: number; text: string }[] = [];

  get running(): boolean { return this.#running; }
  get count(): number { return this.#steps.length; }
  get latest(): string | undefined { return this.#steps.at(-1); }
  get generation(): number { return this.#generation; }
  get backendStatus(): string { return this.#backend; }

  watchBackend(listener: (state: BackendStatus | null) => void): () => void {
    listener({ seq: this.#seq, backend_status: this.#backend });
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #notify(state: BackendStatus | null) {
    for (const listener of this.#listeners) {
      try { listener(state); }
      catch { this.#listeners.delete(listener); } // A disconnected display cannot interrupt the task.
    }
  }

  #setBackend(text: string) {
    if (this.#backend === text) return;
    this.#backend = text;
    this.#notify({ seq: ++this.#seq, backend_status: text });
  }

  /** An incoming recording may overlap a running task or a Stop. Keep the active turn's status on screen. */
  async transcribing<T>(lang: Lang, work: () => Promise<T>): Promise<T> {
    const id = Symbol();
    this.#recordings.set(id, activities.transcribing[lang]);
    if (!this.#owner) this.#setBackend(activities.transcribing[lang]);
    try { return await work(); }
    finally {
      if (this.#recordings.delete(id) && !this.#owner) this.#setBackend(this.#recordingStatus());
    }
  }

  #recordingStatus() { return [...this.#recordings.values()].at(-1) ?? ""; }

  async trackBackend<T>(language: () => Lang, safe: (line: string) => boolean | Promise<boolean>, work: () => Promise<T>): Promise<T> {
    const owner = this.#owner = Symbol();
    const scope = {
      get language() { return language(); },
      begin: (_operation: string, fallback?: string) => {
        if (this.#owner !== owner) return () => {};
        const pass = ++this.#pass;
        this.#setBackend(fallback ?? activities.planning[language()]);
        return (line: string) => {
          if (this.#owner !== owner || this.#pass !== pass || line.length === 0 || line === this.#backend) return;
          // Slow privacy checks and parallel model responses can finish after a newer step.
          void Promise.resolve().then(() => safe(line)).then(ok => {
            if (ok && this.#owner === owner && this.#pass === pass) this.#setBackend(line);
          }).catch(() => { /* Keep the trusted activity label when the check is unavailable. */ });
        };
      },
    };
    try {
      return await MODEL_STATUS.run(scope, work);
    } finally {
      if (this.#owner === owner) this.#endBackend();
    }
  }

  #endBackend() {
    this.#owner = undefined;
    this.#setBackend(this.#recordingStatus());
  }

  close() {
    this.#recordings.clear();
    this.#endBackend();
    this.#notify(null);
    this.#listeners.clear();
  }

  start(): void {
    this.#running = true;
    this.#steps = [];
    this.#activity = null;
    this.#activitySpoken = false;
    this.#activitySeq = 0;
    this.#quiet = null;
    this.#lastMilestone = undefined;
    this.#queue = [];
    this.#generation++;
  }

  add(sentence: string): void {
    this.#steps.push(sentence);
    this.#seq++;
  }

  note(text: string, speak: boolean): void {
    this.#publish(text, speak && this.#reviews === 0);
  }

  milestone(key: string, text: string): void {
    if (this.#lastMilestone === key) return;
    this.#lastMilestone = key;
    this.add(text);
    this.#publish(text, true);
  }

  #publish(text: string, speak: boolean): void {
    this.#seq++;
    const audible = speak && this.spoken;
    if (audible) {
      this.#queue.push({ seq: this.#seq, text });
      this.#activity = text;
      this.#activitySpoken = true;
      this.#activitySeq = this.#seq;
    } else if (this.#queue.length === 0) {
      this.#quiet = text;
      this.#activity = text;
      this.#activitySpoken = false;
      this.#activitySeq = this.#seq;
    } else {
      this.#quiet = text;
    }
  }

  hasSpoken(): boolean { return this.#queue.length > 0; }

  /** 아직 읽지 않은 끝난 단계 문장을 하나 꺼낸다. 꺼낸 뒤에는 다음 대기 줄을 보여 준다. */
  shiftSpoken(): string | undefined {
    const item = this.#queue.shift();
    if (this.#queue.length === 0) {
      this.#activity = this.#quiet;
      this.#activitySpoken = false;
      this.#activitySeq = 0;
    } else {
      const next = this.#queue[0];
      if (next !== undefined) {
        this.#activity = next.text;
        this.#activitySpoken = true;
        this.#activitySeq = next.seq;
      }
    }
    return item?.text;
  }

  /** 그 번호의 대기 문장만 바꾼다. 화면은 그 번호가 아직 보일 때만 바뀐다. */
  revise(seq: number, text: string): void {
    const item = this.#queue.find(row => row.seq === seq);
    if (item !== undefined) item.text = text;
    if (this.#activitySeq === seq) this.#activity = text;
  }

  finish(): void { this.#running = false; }

  interrupt(): void {
    this.#recordings.clear();
    this.#endBackend();
    this.#running = false;
    this.#generation++;
    this.#queue = [];
    this.#quiet = this.#activity = null;
    this.#activitySpoken = false;
    this.#activitySeq = 0;
  }

  /** 검토가 끝날 때까지 자동 음성 안내만 보류한다. 사용자가 물으면 최신 단계는 그대로 읽을 수 있다. */
  async review<T>(work: () => T | Promise<T>): Promise<T> {
    this.#reviews++;
    try {
      return await work();
    } finally {
      this.#reviews--;
    }
  }

  snapshot() {
    return {
      running: this.running, seq: this.#seq, backend_status: this.#backend, latest: this.latest ?? null, spoken: this.spoken && (this.#reviews === 0 || this.#activitySpoken),
      activity: this.#activity, activitySpoken: this.#activitySpoken,
      ...(this.#activitySpoken ? { activitySeq: this.#activitySeq } : {}),
    };
  }
}
