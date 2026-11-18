/** 발화나 입력값을 포함하지 않는 실행 기록. */
export interface ActionEvent {
  sessionId: string;
  turnId: string;
  actionType: string;
  success: boolean;
  latencyMs: number;
  errorCode?: string;
  at: string;
}

export interface EventSink {
  record(event: ActionEvent): void;
}

export class InMemoryEventLog implements EventSink {
  readonly #limit: number;
  #events: ActionEvent[] = [];

  constructor(limit = 5000) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("기록 개수는 0 이상의 정수여야 합니다.");
    this.#limit = limit;
  }

  record(event: ActionEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#limit) this.#events.shift();
  }

  all(): ActionEvent[] { return [...this.#events]; }
}
