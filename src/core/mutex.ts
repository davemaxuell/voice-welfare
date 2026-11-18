/** 멈추기 전에 대기한 요청은 순서가 돌아와도 실행하지 않는다. */
export class TurnQueue {
  #tail: Promise<void> = Promise.resolve();
  #epoch = 0;

  get epoch(): number { return this.#epoch; }

  invalidate(): void { this.#epoch++; }

  enqueue<T>(work: () => Promise<T>, voided: () => T, epoch = this.#epoch): Promise<T> {
    const result = this.#tail.then(() => epoch === this.#epoch ? work() : voided());
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}
