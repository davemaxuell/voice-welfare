export class Progress {
  spoken = true;
  #reviews = 0;
  #running = false;
  #steps: string[] = [];
  #seq = 0;
  #activity: string | null = null;
  #activitySpoken = false;

  get running(): boolean { return this.#running; }
  get count(): number { return this.#steps.length; }
  get latest(): string | undefined { return this.#steps.at(-1); }

  start(): void {
    this.#running = true;
    this.#steps = [];
    this.#activity = null;
    this.#activitySpoken = false;
  }

  add(sentence: string): void {
    this.#steps.push(sentence);
    this.#seq++;
  }

  note(text: string, speak: boolean): void {
    this.#activity = text;
    this.#activitySpoken = speak;
    this.#seq++;
  }

  finish(): void { this.#running = false; }

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
      running: this.running, seq: this.#seq, latest: this.latest ?? null, spoken: this.spoken && this.#reviews === 0,
      activity: this.#activity, activitySpoken: this.#activitySpoken,
    };
  }
}
