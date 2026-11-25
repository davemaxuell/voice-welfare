import { z } from "zod";
import { api } from "./api.ts";
import { LangSchema, type Lang } from "../../src/core/turn.ts";
import { resultWord, stateNote } from "../../src/core/research_copy.ts";

export const RESEARCH_POLL_MS = 10_000;
const pending = z.object({pending: z.array(z.object({
  id: z.string(), token: z.string(), state: z.string(), language: LangSchema,
  result: z.object({text: z.string().optional(), missing: z.array(z.string()).optional()}).nullish(),
}))});
const changes = new EventTarget();
export function researchStarted() { changes.dispatchEvent(new Event("queued")); }

/** 전달한 내용은 저장하지 않고, 서버 인수증을 다시 보낼 경우에만 번호를 기억한다. */
export function watchResearch(sessionId: string, deliver: (token: string, text: string, lang: Lang) => Promise<boolean>) {
  let closed = false, busy = false, again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const heard = new Set<string>();
  async function check() {
    if (closed) return;
    clearTimeout(timer);
    if (busy) { again = true; return; }
    busy = true;
    let wait = false;
    try {
      const {pending: jobs} = pending.parse(await api.workspace(sessionId, "/deliveries"));
      for (const job of jobs) {
        if (closed) break;
        if (job.state === "queued" || job.state === "running") { wait = true; continue; }
        const key = "cheongeum.researchReceipt." + job.token;
        try { if (localStorage.getItem(key) === "1") heard.add(job.token); } catch { /* 메모리 인수증 사용 */ }
        if (!heard.has(job.token)) {
          const result = job.state === "cancelled" ? undefined : job.result;
          const missing = result?.missing ?? [];
          const answer = result?.text;
          const line = [answer !== undefined && answer.length > 0 ? answer : stateNote(job.state, job.language),
            ...(missing.length > 0 ? [resultWord("missing", job.language), ...missing] : [])].join(". ");
          if (!await deliver(job.token, line, job.language)) { wait = true; continue; }
          heard.add(job.token);
          try { localStorage.setItem(key, "1"); } catch { /* 메모리 인수증 사용 */ }
        }
        if (closed) break;
        await api.workspace(sessionId, `/research/${encodeURIComponent(job.id)}/delivery/${encodeURIComponent(job.token)}`, "DELETE");
        heard.delete(job.token);
        try { localStorage.removeItem(key); } catch { /* 이미 서버에 도착한 인수증 */ }
      }
    } catch { wait = true; }
    finally {
      busy = false;
      if (!closed && again) { again = false; void check(); }
      else if (!closed && wait) timer = setTimeout(() => void check(), RESEARCH_POLL_MS);
    }
  }
  changes.addEventListener("queued", check);
  void check();
  return () => { closed = true; clearTimeout(timer); changes.removeEventListener("queued", check); };
}
