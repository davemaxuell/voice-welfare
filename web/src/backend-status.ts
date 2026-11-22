import { api, errorStatus, type ProgressSnapshot } from "./api.ts";

/** HTTP turns and an open Live call share the same session's progress stream. */
export class BackendStatus {
  readonly sessionId: string;
  readonly update: (status: string, seq?: number) => void;
  #readers = new Set<symbol>();
  #controller: AbortController | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;

  constructor(sessionId: string, update: (status: string, seq?: number) => void) {
    this.sessionId = sessionId;
    this.update = update;
  }

  watch() {
    const reader = Symbol();
    this.#readers.add(reader);
    if (this.#controller === undefined) {
      this.#controller = new AbortController();
      void this.#follow(this.#controller.signal);
    }
    return () => {
      if (this.#readers.delete(reader) && this.#readers.size === 0) this.stop();
    };
  }

  stop() {
    this.#readers.clear();
    this.#controller?.abort();
    this.#controller = undefined;
    clearTimeout(this.#retry);
    this.update("");
  }

  async #follow(signal: AbortSignal) {
    let lastSeq = -1;
    const receive = (snapshot: ProgressSnapshot) => {
      if (signal.aborted || snapshot.seq <= lastSeq) return;
      lastSeq = snapshot.seq;
      this.update(snapshot.backend_status, snapshot.seq);
    };
    try {
      await api.streamProgress(this.sessionId, signal, receive);
    } catch { /* Some connections cannot stream. Read the same snapshot below. */ }
    const poll = async () => {
      if (signal.aborted) return;
      try { receive(await api.progress(this.sessionId, signal)); }
      catch (error) {
        const status = errorStatus(error);
        if (!signal.aborted && (status === 404 || status === 409 || status === 410)) this.stop();
      }
      if (!signal.aborted) this.#retry = setTimeout(() => void poll(), 750);
    };
    await poll();
  }
}
