export class Progress {
  spoken = true;
  #running = false;
  #steps: string[] = [];
  #seq = 0;

  get running(): boolean { return this.#running; }
  get count(): number { return this.#steps.length; }
  get latest(): string | undefined { return this.#steps.at(-1); }

  start(): void {
    this.#running = true;
    this.#steps = [];
  }

  add(sentence: string): void {
    this.#steps.push(sentence);
    this.#seq++;
  }

  finish(): void { this.#running = false; }

  snapshot() {
    return { running: this.running, seq: this.#seq, latest: this.latest ?? null, spoken: this.spoken };
  }
}
