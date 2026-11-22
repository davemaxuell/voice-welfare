export class VoiceNotSupportedError extends Error {
  readonly code = "NOT_SUPPORTED";
}
export class VoiceProviderError extends Error {
  readonly status: number;
  readonly providerCode: string | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(status: number, providerCode?: string, retryAfterMs?: number) {
    super("voice provider error (HTTP " + status + ")");
    this.status = status;
    this.providerCode = providerCode;
    this.retryAfterMs = retryAfterMs;
  }
  // 기록에 발화 내용, 요청 본문, API 키가 들어가지 않게 공급자의 구조화된 오류 코드만 허용한다.
  static fromBody(body: unknown, status?: number, retryAfterMs?: number) {
    const detail = typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
    const code = typeof detail === "object" && detail !== null && "code" in detail && typeof detail.code === "string"
      && Object.hasOwn(providerStatus, detail.code) ? detail.code : undefined;
    return new VoiceProviderError(code === undefined ? status ?? 502 : providerStatus[code] ?? status ?? 502, code, retryAfterMs);
  }
  static async fromResponse(response: Response) {
    const header = response.headers.get("retry-after");
    const after = header === null ? undefined : Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    return this.fromBody(await response.json().catch(() => undefined), response.status,
      after !== undefined && Number.isFinite(after) && after >= 0 ? after : undefined);
  }
}

const providerStatus: Record<string, number> = {
  invalid_api_key: 401, permission_denied: 403, model_not_found: 404, rate_limit_exceeded: 429,
  insufficient_quota: 429, session_expired: 401, server_error: 502,
};
