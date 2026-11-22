import { afterEach, expect, it, vi } from "vitest";
import { api, type ProgressSnapshot } from "../../web/src/api.ts";
import { BackendStatus } from "../../web/src/backend-status.ts";

afterEach(() => {
  api.writer(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reads complete JSON values across byte boundaries with the current session writer", async () => {
  const updates = [
    { seq: 1, backend_status: "공식 사이트를 살펴보고 있어요." }, { seq: 2, backend_status: "" },
  ];
  const encoded = new TextEncoder().encode(updates.map(p => "data: " + JSON.stringify(p) + "\r\n\r\n").join(""));
  const body = new ReadableStream({
    start(controller) {
      for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  api.writer("current-writer");
  const receive = vi.fn();
  await api.streamProgress("session", new AbortController().signal, receive);
  expect(receive.mock.calls.map(([snapshot]) => snapshot)).toEqual(updates);
  expect(fetch).toHaveBeenCalledWith("/api/session/session/progress/stream", expect.objectContaining({
    headers: expect.objectContaining({ "X-Cheongeum-Writer": "current-writer" }),
  }));
});

it("shares a stream across overlapping turns and Live, and ignores stale sequence numbers and stopped streams", async () => {
  const stream = vi.spyOn(api, "streamProgress").mockImplementation(async (_sid, signal) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const poll = vi.spyOn(api, "progress");
  const update = vi.fn();
  const progress = new BackendStatus("s", update);
  const closeLive = progress.watch();
  const finishTurn = progress.watch();
  const [, signal, receive] = stream.mock.calls[0]!;
  receive({ seq: 3, backend_status: "Checking the source" });
  receive({ seq: 2, backend_status: "Out of order" });
  closeLive();
  expect(signal.aborted).toBe(false);
  expect(update.mock.calls).toEqual([["Checking the source", 3]]);
  receive({ seq: 4, backend_status: "" });
  expect(update).toHaveBeenLastCalledWith("", 4);
  progress.stop();
  const finishNew = progress.watch();
  const [, nextSignal, nextReceive] = stream.mock.calls[1]!;
  finishTurn();
  receive({ seq: 5, backend_status: "Cancelled work" });
  expect(nextSignal.aborted).toBe(false);
  nextReceive({ seq: 6, backend_status: "Reading the new page" });
  expect(update.mock.calls.map(([status]) => status)).toEqual(["Checking the source", "", "", "Reading the new page"]);
  finishNew();
  await Promise.resolve();
  expect(update).toHaveBeenLastCalledWith("");
  expect(nextSignal.aborted).toBe(true);
  expect(poll).not.toHaveBeenCalled();
});

it("falls back to serial polling and discards a late response after completion", async () => {
  vi.spyOn(api, "streamProgress").mockRejectedValue(new Error("connection closed"));
  let respond!: (value: ProgressSnapshot) => void;
  const response = new Promise<ProgressSnapshot>(resolve => { respond = resolve; });
  const poll = vi.spyOn(api, "progress").mockReturnValue(response);
  const update = vi.fn();
  const progress = new BackendStatus("s", update);
  const finish = progress.watch();
  await Promise.resolve();
  expect(poll).toHaveBeenCalledTimes(1);
  finish();
  respond({ seq: 3, backend_status: "Stale page" });
  await Promise.resolve();
  expect(update.mock.calls).toEqual([[""]]);
});

it("waits for each poll and keeps retrying transient network failures", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "streamProgress").mockRejectedValue(new Error("stream unavailable"));
  let respond!: (snapshot: ProgressSnapshot) => void;
  const poll = vi.spyOn(api, "progress")
    .mockReturnValueOnce(new Promise(resolve => { respond = resolve; }))
    .mockRejectedValueOnce(new Error("connection reset"))
    .mockResolvedValue({ seq: 2, backend_status: "Reading the page" });
  const update = vi.fn();
  const finish = new BackendStatus("session", update).watch();
  try {
    await vi.advanceTimersByTimeAsync(12_000);
    expect(poll).toHaveBeenCalledTimes(1);
    respond({ seq: 1, backend_status: "Opening the page" });
    await vi.advanceTimersByTimeAsync(1499);
    expect(update.mock.calls).toEqual([["Opening the page", 1]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(update.mock.calls).toEqual([["Opening the page", 1], ["Reading the page", 2]]);
  } finally { finish(); }
});
