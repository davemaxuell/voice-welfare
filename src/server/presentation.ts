import type { WSEvents } from "hono/ws";

/** 서로 다른 브라우저 프로필로 접속해도 한 창에서만 마이크와 대화를 맡는다. */
export class Presentation {
  #windows = new Set<(message: string) => void>();

  activate() {
    const first = this.#windows.values().next().value;
    first?.("focus");
    return first !== undefined;
  }

  connect(): WSEvents {
    let send: ((message: string) => void) | undefined;
    return {
      onOpen: (_event, socket) => {
        const occupied = this.activate();
        send = message => {
          if (socket.readyState === 1) {
            try { socket.send(message); } catch { /* 닫히는 창은 onClose에서 다음 창에 대화를 넘긴다. */ }
          }
        };
        this.#windows.add(send);
        send(occupied ? "waiting" : "primary");
      },
      onMessage: event => { if (event.data === "focus") this.activate(); },
      onClose: () => {
        const wasPrimary = send === this.#windows.values().next().value;
        if (send !== undefined) this.#windows.delete(send);
        if (wasPrimary) this.#windows.values().next().value?.("primary");
      },
    };
  }
}
