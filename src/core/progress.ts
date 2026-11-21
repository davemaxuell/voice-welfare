export class Progress {
  spoken = true;
  #reviews = 0;
  #running = false;
  #steps: string[] = [];
  #seq = 0;
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
      running: this.running, seq: this.#seq, latest: this.latest ?? null, spoken: this.spoken && (this.#reviews === 0 || this.#activitySpoken),
      activity: this.#activity, activitySpoken: this.#activitySpoken,
      ...(this.#activitySpoken ? { activitySeq: this.#activitySeq } : {}),
    };
  }
}
