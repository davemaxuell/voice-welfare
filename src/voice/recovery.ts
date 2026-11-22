export const TRANSCRIPTION_DEADLINE_MS = 55_000;
export class VoiceFault extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  constructor(code: string, retryable: boolean, retryAfterMs?: number) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}
const terminal = new Set(["VOICE_KEY", "VOICE_QUOTA", "VOICE_MODEL", "VOICE_CONTENT", "NOT_SUPPORTED", "REQUEST_CONFLICT", "SESSION_NOT_FOUND"]);

/** GPT-Live가 직접 보낸 종료 원인. 콘텐츠로 종료한 세션은 자동으로 되살리지 않는다. */
export function liveClosure(reason: unknown): VoiceFault | undefined {
  switch (reason) {
    case "expired": return new VoiceFault("VOICE_SESSION_EXPIRED", true);
    case "content": return new VoiceFault("VOICE_CONTENT", false);
    case "remote_hangup": return new VoiceFault("VOICE_REMOTE_HANGUP", true);
    case "connection_lost": return new VoiceFault("VOICE_CONNECTION", true);
    default: return undefined;
  }
}

export function voiceFault(error: unknown): VoiceFault {
  if (error instanceof VoiceFault) return error;
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) return new VoiceFault("MIC_DENIED", false);
  if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "OverconstrainedError")) return new VoiceFault("MIC_LOST", false);
  if (error instanceof DOMException && error.name === "NotReadableError") return new VoiceFault("MIC_LOST", true);
  if (error instanceof DOMException && error.name === "NetworkError") return new VoiceFault("VOICE_NETWORK", true);
  if (error instanceof TypeError && error.cause instanceof Error) return voiceFault(error.cause);
  const data = typeof error === "object" && error !== null ? error : {};
  const status = "status" in data && typeof data.status === "number" ? data.status : undefined;
  const code = "code" in data && typeof data.code === "string" ? data.code : undefined;
  const kind = "kind" in data ? data.kind : undefined;
  const after = "retryAfterMs" in data && typeof data.retryAfterMs === "number" ? data.retryAfterMs : undefined;
  if ("providerCode" in data) {
    if (data.providerCode === "session_expired") return new VoiceFault("VOICE_SESSION_EXPIRED", true, after);
    if (data.providerCode === "insufficient_quota") return new VoiceFault("VOICE_QUOTA", false);
  }
  if (error instanceof Error && error.name === "TimeoutError") return new VoiceFault("VOICE_TIMEOUT", true);
  if (code !== undefined && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH"].includes(code)) return new VoiceFault(code, true);
  if (code !== undefined && terminal.has(code)) return new VoiceFault(code, false);
  const transient = kind === "network" || kind === "timeout" || status === 408 || status === 429 || (status !== undefined && status >= 500);
  return new VoiceFault(code !== undefined && ["VOICE_SESSION_EXPIRED", "VOICE_LIMIT", "VOICE_TIMEOUT", "VOICE_REMOTE_HANGUP", "VOICE_CONNECTION"].includes(code) ? code :
    kind === "timeout" ? "VOICE_TIMEOUT" : kind === "network" ? "VOICE_NETWORK" : status !== undefined ? "HTTP_" + status : "VOICE_CONNECTION", transient, after);
}

function backoff(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** 같은 음성 전송만 재시도한다. 이미 요청한 앱 동작은 재전송하지 않는다. */
export async function recoverVoice<T>(operation: "speech" | "conversation" | "transcription", signal: AbortSignal, run: () => Promise<T>,
  onInterrupted?: () => void, wait = backoff, classify = voiceFault): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try { return await run(); } catch (error) {
      signal.throwIfAborted();
      const fault = classify(error);
      console.warn("[voice]", { operation, code: fault.code, attempt });
      onInterrupted?.();
      const delay = fault.retryAfterMs ?? 300 * 2 ** (attempt - 1);
      if (!fault.retryable || attempt >= 3) throw error;
      await wait(delay, signal);
    }
  }
}
