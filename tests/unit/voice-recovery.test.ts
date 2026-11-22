import { expect, it, vi } from "vitest";
import { VoiceProviderError } from "../../src/voice/errors.ts";
import { liveClosure, recoverVoice, voiceFault, VoiceFault } from "../../src/voice/recovery.ts";

it("공급자의 재시도 시간과 세션 만료를 구분하고 본문이나 키를 기록하지 않는다", async () => {
  const limited = await VoiceProviderError.fromResponse(Response.json({ error: { code: "rate_limit_exceeded", message: "비공개 원문" } },
    { status: 429, headers: { "retry-after": "30" } }));
  expect(limited).toMatchObject({ providerCode: "rate_limit_exceeded", retryAfterMs: 30_000 });
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const run = vi.fn<() => Promise<number>>().mockRejectedValueOnce(limited).mockResolvedValue(7);
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await recoverVoice("speech", new AbortController().signal, run, undefined, sleep)).toBe(7);
    expect(sleep.mock.calls[0]?.[0]).toBe(30_000);
    expect(JSON.stringify(log.mock.calls)).not.toContain("비공개 원문");
    expect(voiceFault(VoiceProviderError.fromBody({ error: { code: "session_expired" } })).retryable).toBe(true);
    expect(voiceFault(VoiceProviderError.fromBody({ error: { code: "insufficient_quota" } })).retryable).toBe(false);
    expect(VoiceProviderError.fromBody({ error: { code: "비공개 원문" } }).providerCode).toBeUndefined();
    expect(liveClosure("expired")).toMatchObject({ code: "VOICE_SESSION_EXPIRED", retryable: true });
    expect(liveClosure("connection_lost")).toMatchObject({ code: "VOICE_CONNECTION", retryable: true });
    expect(liveClosure("content")).toMatchObject({ code: "VOICE_CONTENT", retryable: false });
  } finally { log.mockRestore(); }
});

it("영구 인증 오류와 사용자가 취소한 재연결은 다시 시도하지 않는다", async () => {
  const abort = new AbortController();
  const denied = vi.fn(async () => { throw new VoiceFault("MIC_DENIED", false); });
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(recoverVoice("conversation", abort.signal, denied)).rejects.toMatchObject({ code: "MIC_DENIED" });
    expect(denied).toHaveBeenCalledTimes(1);
    const temporary = vi.fn(async () => { throw new VoiceFault("WEBRTC_FAILED", true); });
    await expect(recoverVoice("conversation", abort.signal, temporary, undefined, async () => { abort.abort(); })).rejects.toMatchObject({ name: "AbortError" });
    expect(temporary).toHaveBeenCalledTimes(1);
  } finally { log.mockRestore(); }
});
