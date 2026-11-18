export class VoiceNotSupportedError extends Error {
  readonly code = "NOT_SUPPORTED";
}
export class VoiceProviderError extends Error {
  readonly status: number;
  constructor(status: number) { super("voice provider error (HTTP " + status + ")"); this.status = status; }
}
