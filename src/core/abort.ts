/** 중단된 요청은 시작하지 않는다. 실행 중인 I/O도 이 신호를 받아야 한다. */
export async function raceAbort<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal = new AbortController().signal,
  error?: Error,
): Promise<T> {
  if (signal.aborted) throw error ?? signal.reason;
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(error ?? signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, work(signal)]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
