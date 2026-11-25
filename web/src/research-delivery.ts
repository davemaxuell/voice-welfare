import { z } from "zod";
import { api } from "./api.ts";
import { LangSchema, type Lang } from "../../src/core/turn.ts";

export const RESEARCH_POLL_MS = 10_000;
const pending = z.object({pending: z.array(z.object({
  id: z.string(), token: z.string(), state: z.string(), language: LangSchema, speech: z.string(),
}))});
const changes = new EventTarget();
export function researchStarted() { changes.dispatchEvent(new Event("queued")); }

const receiptKey = (token: string) => "cheongeum.researchReceipt." + token;
const heardTokens = new Set<string>();
const sending = new Map<string, Promise<boolean>>();

function wasHeard(token: string) {
  if (heardTokens.has(token)) return true;
  try { return localStorage.getItem(receiptKey(token)) === "1"; } catch { return false; }
}

export function recordHeard(sessionId: string, jobId: string, token: string): Promise<boolean> {
  const current = sending.get(token);
  if (current !== undefined) return current;
  heardTokens.add(token);
  try { localStorage.setItem(receiptKey(token), "1"); } catch { /* 메모리 인수증 사용 */ }
  const sent = api.workspace(sessionId, `/research/${encodeURIComponent(jobId)}/delivery/${encodeURIComponent(token)}`, "DELETE").then(() => {
    heardTokens.delete(token);
    try { localStorage.removeItem(receiptKey(token)); } catch { /* 이미 서버에 도착한 인수증 */ }
    return true;
  }, () => false).finally(() => sending.delete(token));
  sending.set(token, sent);
  return sent;
}

export function watchResearch(sessionId: string, deliver: (token: string, text: string, lang: Lang) => Promise<boolean>) {
  let closed = false, busy = false, again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
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
        if (!wasHeard(job.token) && !await deliver(job.token, job.speech, job.language)) { wait = true; continue; }
        if (!await recordHeard(sessionId, job.id, job.token)) wait = true;
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
