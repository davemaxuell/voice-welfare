import { ReadableStream } from "node:stream/web";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { Progress } from "../../src/core/progress.ts";
import { ModelConnections, SIMPLE_TEXT_SCHEMA, createStructuredLlm } from "../../src/core/llm.ts";
import { STACK } from "../../src/core/model_stack.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { ABSORBED, BUSY, LiveProvider, MISSED, Transcript, VoiceEdge, effortChoice, type EdgeSession, type EdgeTiming } from "../../src/server/voice_edge.ts";

function delta(text: string, start: number, end: number, kind = "input") {
  return { type: `session.${kind}_transcript.delta`, delta: text, start_ms: start, end_ms: end, event_id: `${kind}-${start}` };
}

function delegation(id: string, offset: number, target = "client") {
  return { type: "session.delegation.created", offset_ms: offset, delegation: { id, target } };
}

it("test_transcript_matches_offsets_and_keeps_fragments_and_approval_together", () => {
  const transcript = new Transcript();
  transcript.add(delta("Thanks", 0, 250), "old");
  transcript.add(delta("OK.", 300, 450, "output"), "");
  transcript.add(delta(" Open", 510, 600), "");
  transcript.add(delta(" KOSAF", 610, 740), "changed");
  transcript.add(delta("sure", 780, 850, "output"), "");
  transcript.add(delta(" Next page", 1600, 1900), "new");
  expect(transcript.read(720, { consume: true })).toEqual(["Open KOSAF", ""]);
  expect(transcript.read(720)).toEqual(["", ""]);
  expect(transcript.read(1900, { consume: true })).toEqual(["Next page", "new"]);
});

it("test_a_thinking_pause_keeps_the_whole_sentence", () => {
  const transcript = new Transcript();
  transcript.add(delta("로그인은 하지 말고", 0, 900), "");
  transcript.add(delta(" 국민연금 열어줘", 2200, 3200), "");
  expect(transcript.read(3250, { consume: true })).toEqual(["로그인은 하지 말고 국민연금 열어줘", ""]);
});

it("test_an_oversized_native_fragment_cannot_turn_into_a_short_approval", () => {
  const transcript = new Transcript();
  transcript.add(delta("응" + " ".repeat(499) + "지우지 마세요", 100, 300), "visible-card");
  expect(transcript.read(310, { consume: true })[0]).toBe("");
});

it("test_an_evicted_transcript_prefix_cannot_turn_into_a_short_approval", () => {
  const transcript = new Transcript();
  transcript.add(delta("지우지 마세요", 0, 1), "visible-card");
  for (let i = 1; i < 400; ++i) transcript.add(delta(" ", i, i + 1), "visible-card");
  transcript.add(delta("응", 400, 401), "visible-card");
  expect(transcript.read(410, { consume: true })[0]).toBe("");
  transcript.add(delta("응", 9000, 9500), "visible-card");
  expect(transcript.read(9510, { consume: true })[0]).toBe("응");
});

it("test_live_offer_falls_back_to_client_when_decisions_are_unavailable", async () => {
  const modes: unknown[] = [];
  const provider = new LiveProvider({ apiKey: "dummy", baseUrl: "https://example.test/v1", edgeModel: "voice" }, {
    fetch: async (_url, options) => {
      if (typeof options?.body !== "string") throw new Error("expected a JSON offer");
      const mode = z.object({ session: z.object({ delegation: z.object({ type: z.string() }) }) }).parse(JSON.parse(options.body)).session.delegation.type;
      modes.push(mode);
      return mode === "decisions" ? new Response(null, { status: 403 })
        : Response.json({ session: { id: "live_test" }, transport: { sdp: "answer-test" } }, { status: 201 });
    },
  });
  expect(await provider.offer("v=0", { lang: "ko", state: "IDLE", recentVoiceDialogue: () => [] }, 1.35))
    .toEqual(["live_test", "answer-test"]);
  expect(modes).toEqual(["decisions", "client"]);
});

it("accepts only the three configured effort ratings", () => {
  for (const choice of ["low", "medium", "high", "toString", "constructor", "", null]) {
    const result = effortChoice({ decision: { answers: [{ name: "sol_effort", type: "choice", choice }] } });
    expect(result).toBe(choice === "low" || choice === "medium" || choice === "high" ? choice : undefined);
  }
});

function startMonitor(turn: EdgeSession["handleTurn"], linkOfferId = "", action = "", timing: Partial<EdgeTiming> = {}, progress = new Progress()) {
  vi.useFakeTimers();
  let feed: (event: object) => void;
  const stream = new ReadableStream<string>({ start(controller) { feed = event => { controller.enqueue(JSON.stringify(event)); }; } });
  function enqueue(event: object) { feed(event); }
  function receive(): Promise<never> { return new Promise(() => {}); }
  const sent: unknown[] = [];
  const socket = { receive, sendJson: vi.fn(async (_packet: unknown) => {}) };
  const sideband = { [Symbol.asyncIterator]: () => stream.values(), send: async (event: string) => { sent.push(JSON.parse(event)); } };
  const session = {
    generation: 0, consentStatus: "granted", dialogue: { authWaiting: false }, linkOfferId,
    lang: "ko", state: "IDLE", progress, recentVoiceDialogue: () => [], handleTurn: turn,
  } satisfies EdgeSession;
  const monitor = new VoiceEdge({ clock: () => 1 + performance.now() / 1000, timing }).monitor(sideband, socket, session, () => {}, action);
  function appended(kind: string, id: string) {
    return sent.flatMap(packet => {
      const entry = z.object({ type: z.literal("session." + kind + ".append"), delegation_id: z.literal(id), content: z.string() }).safeParse(packet);
      return entry.success ? [entry.data.content] : [];
    });
  }
  return { session, enqueue, appended, sent, socket, monitor, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms), async close() {
    enqueue({ type: "session.closed" });
    try { await monitor; } finally { vi.useRealTimers(); }
  } };
}

it("dispatches an ordinary turn after the short pause when the session has no link offer", async () => {
  const turn = vi.fn(async () => ({ state: "BROWSING", speech: "네" }));
  const run = startMonitor(turn);
  try {
    run.enqueue(delta("정부24 열어줘", 0, 500));
    run.enqueue(delegation("open", 510));
    await run.advance(1000);
    expect(turn).toHaveBeenCalledExactlyOnceWith("정부24 열어줘", { approvalId: "", fromVoice: true, linkOfferId: "" });
    expect(run.socket.sendJson).toHaveBeenCalledWith({ exact: false, result: { state: "BROWSING", speech: "네" } });
  } finally { await run.close(); }
});

it("test_ambiguous_live_output_cannot_authorize_the_prefix_of_a_link_reply", async () => {
  const turn = vi.fn(async () => ({ state: "BROWSING", speech: "네" }));
  const run = startMonitor(turn, "link-offer");
  try {
    run.enqueue(delta("네, 첫 번째 링크가 맞아요", 24400, 27600));
    run.enqueue(delegation("pick", 27400));
    await run.advance(400);
    run.enqueue(delta("물론이죠.", 27800, 28000, "output"));
    await run.advance(700);
    run.enqueue(delta(" 아니요, 열지 마세요", 28400, 29600));
    await run.advance(4000);
    expect(turn).not.toHaveBeenCalled();
    expect(run.sent).toContainEqual(expect.objectContaining({ type: "session.commentary.append", delegation_id: "pick", content: MISSED }));
  } finally { await run.close(); }
});

it("test_late_transcript_replay_and_voice_stop_during_delegated_work", async () => {
  let release = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let completed = false;
  const turn = vi.fn<EdgeSession["handleTurn"]>(async text => {
    if (text === "멈춰") return { state: "STOPPED", speech: "완료" };
    await waiting;
    completed = true;
    return { state: "BROWSING", speech: "완료" };
  });
  const run = startMonitor(turn, "", "known-at-start");
  try {
    run.enqueue(delegation("d1", 810));
    run.enqueue(delta("정부24", 100, 380));
    run.enqueue(delta(" 열어줘", 400, 800));
    run.enqueue(delta(" 열어줘", 400, 800));
    run.enqueue(delegation("d1", 810));
    await run.advance(1000);
    expect(turn).toHaveBeenCalledExactlyOnceWith("정부24 열어줘", { fromVoice: true, approvalId: "known-at-start", linkOfferId: "" });
    run.enqueue(delta("멈춰", 1320, 1450));
    await run.advance(1000);
    await run.monitor;
    expect(turn).toHaveBeenCalledTimes(2);
    expect(turn).toHaveBeenLastCalledWith("멈춰", { fromVoice: true, approvalId: "known-at-start" });
    expect(run.socket.sendJson).toHaveBeenLastCalledWith({ result: { state: "STOPPED", speech: "완료" }, exact: true });
    release();
    await run.advance(100);
    expect(completed).toBe(true);
    expect(run.sent).not.toContainEqual(expect.objectContaining({ type: "session.commentary.append" }));
  } finally { release(); await run.close(); }
});

const ordinary = () => vi.fn<EdgeSession["handleTurn"]>(async () => ({ state: "BROWSING", speech: "네" }));
const voiceLink = (id: string) => ({ approvalId: "", fromVoice: true, linkOfferId: id });
function latch() {
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

it("test_live_link_reply_waits_through_a_spoken_pause", async () => {
  const open = " 그거 열어 주세요", refuse = " 아니요, 열지 마세요", prefix = "네, 화면에 있는 첫 번째 링크가 맞아요";
  for (const [suffix, duplicate, ack, delayed] of [
    [open, false, [], false], [refuse, false, [], false], [open, true, [], false], [open, false, ["네"], false],
    [refuse, false, ["네"], false], [refuse, false, ["네,", " 알겠", "습니다."], false], [refuse, false, ["O", "kay."], false],
    [refuse, false, ["네"], true],
  ] as const) {
    const turn = ordinary(), run = startMonitor(turn, "link-offer");
    try {
      run.enqueue(delta(prefix, 24400, 27600));
      if (!delayed) run.enqueue(delegation("pick", 27400));
      await run.advance(400);
      ack.forEach((word, i) => run.enqueue(delta(word, 27800 + i * 100, 27900 + i * 100, "output")));
      await run.advance(700); run.enqueue(delta(suffix, 28400, 29600));
      if (delayed || duplicate) run.enqueue(delegation("pick", 27400));
      if (duplicate) run.enqueue(delegation("pick-again", 29600));
      await run.advance(7000);
      expect(turn).toHaveBeenCalledExactlyOnceWith(prefix + suffix, voiceLink("link-offer"));
      if (duplicate) {
        expect(run.appended("thinking", "pick")).toEqual([""]);
        expect(run.appended("thinking", "pick-again")).toEqual(["", ABSORBED]);
      }
    } finally { await run.close(); }
  }
});
it("test_delayed_link_delegation_keeps_the_refusal_across_an_ack", async () => {
  for (const offset of [27900, 28050]) {
    const turn = ordinary(), run = startMonitor(turn, "link-offer");
    try {
      run.enqueue(delta("네, 첫 번째 링크가 맞아요", 24400, 27600)); run.enqueue(delegation("pick", offset)); await run.advance(600);
      run.enqueue(delta("네", 27800, 28000, "output")); await run.advance(500);
      run.enqueue(delta(" 열지 마세요", 28400, 29600)); await run.advance(4000);
      expect(turn).toHaveBeenCalledExactlyOnceWith("네, 첫 번째 링크가 맞아요 열지 마세요", voiceLink("link-offer"));
    } finally { await run.close(); }
  }
});
it("test_link_delegation_does_not_reach_back_across_prior_live_output", async () => {
  const turn = ordinary(), run = startMonitor(turn, "link-offer");
  try {
    run.enqueue(delta("두 번째 링크 열어 주세요", 24400, 27600)); run.enqueue(delta("네", 27800, 28000, "output"));
    run.enqueue(delta("첫 번째 링크 열어 주세요", 28400, 29600)); run.enqueue(delegation("pick", 29500));
    await run.advance(3500); expect(turn).toHaveBeenCalledExactlyOnceWith("첫 번째 링크 열어 주세요", voiceLink("link-offer"));
  } finally { await run.close(); }
});
it("test_live_link_reply_keeps_the_first_offer_until_a_new_turn", async () => {
  for (const delivered of [false, true]) {
    const gate = latch(), prior = "현재 화면 읽어줘";
    let change = () => {};
    const turn = vi.fn<EdgeSession["handleTurn"]>(async text => {
      if (text === prior) { await gate.pending; change(); }
      return { state: "BROWSING", speech: "네" };
    });
    const run = startMonitor(turn, "earlier-offer");
    change = () => { run.session.linkOfferId = "replacement-offer"; };
    try {
      run.enqueue(delta(prior, 100, 800)); run.enqueue(delegation("read", 810)); await run.advance(3500);
      run.enqueue(delta("네, 첫 번째 링크가 맞아요", 5000, 5700)); run.enqueue(delegation("old-reply", 5710)); await run.advance(300);
      gate.release(); await run.advance(800); expect(run.appended("commentary", "read")).toEqual(["네"]);
      if (delivered) run.enqueue(delta("네", 6000, 6200, "output"));
      run.enqueue(delta(" 그거 열어 주세요", 6500, 6800));
      if (delivered) run.enqueue(delegation("next-reply", 6780));
      await run.advance(3500); run.enqueue(delta("두 번째 링크 열어줘", 11000, 11400)); run.enqueue(delegation("new-reply", 11410)); await run.advance(3500);
      expect(turn.mock.calls).toEqual([[prior, voiceLink("earlier-offer")], ...(delivered ? [
        ["네, 첫 번째 링크가 맞아요", voiceLink("earlier-offer")], ["그거 열어 주세요", voiceLink("replacement-offer")],
      ] : [["네, 첫 번째 링크가 맞아요 그거 열어 주세요", voiceLink("earlier-offer")]]), ["두 번째 링크 열어줘", voiceLink("replacement-offer")]]);
    } finally { gate.release(); await run.close(); }
  }
});
it("test_live_link_reply_times_out_before_dispatching_unsettled_text", async () => {
  const turn = ordinary(), run = startMonitor(turn, "link-offer", "", { waitWhileTalkingS: 2 });
  try {
    run.enqueue(delta("네, 첫 번째 링크가 맞아요", 100, 1800)); run.enqueue(delegation("pick", 1810)); await run.advance(2600);
    expect(turn).not.toHaveBeenCalled(); expect(run.appended("commentary", "pick")).toEqual([MISSED]);
  } finally { await run.close(); }
});
it("test_live_link_timeout_does_not_authorize_a_late_suffix", async () => {
  const turn = ordinary(), run = startMonitor(turn, "link-offer");
  try {
    run.enqueue(delta("아니요, 열지 마세요", 100, 1800)); run.enqueue(delegation("pick", 1810));
    // Keep the original turn speaking across the full configured deadline.
    for (let i = 0; i < 5; i++) { await run.advance(1900); run.enqueue(delta(" ", 1801 + i * 2, 1802 + i * 2)); }
    await run.advance(1100); expect(run.appended("commentary", "pick")).toEqual([MISSED]);
    run.enqueue(delta("네", 1900, 2050, "output")); run.enqueue(delta("그거 열어줘", 2300, 3200)); run.enqueue(delegation("suffix", 3190));
    await run.advance(3500); run.enqueue(delta(" 그거 열어줘", 5000, 5200)); run.enqueue(delegation("second-suffix", 5210)); await run.advance(3500);
    expect(turn).not.toHaveBeenCalled();
    for (const id of ["suffix", "second-suffix"]) expect(run.appended("commentary", id)).toEqual([MISSED]);
    run.enqueue(delta("첫 번째 링크 열어줘", 9000, 9500)); run.enqueue(delegation("new-pick", 9510)); await run.advance(3500);
    expect(turn).toHaveBeenCalledExactlyOnceWith("첫 번째 링크 열어줘", voiceLink("link-offer"));
  } finally { await run.close(); }
});
it("test_live_urgent_turn_stays_prompt_with_a_link_offer", async () => {
  for (const text of ["지금 어디까지 했어", "멈춰"]) {
    const turn = vi.fn<EdgeSession["handleTurn"]>(async () => ({ state: text === "멈춰" ? "STOPPED" : "BROWSING", speech: "네" }));
    const run = startMonitor(turn, "link-offer");
    try {
      run.enqueue(delta(text, 100, 500)); run.enqueue(delegation("urgent", 510)); await run.advance(1100);
      expect(turn).toHaveBeenCalledExactlyOnceWith(text, { approvalId: "", fromVoice: true });
    } finally { await run.close(); }
  }
});

it("test_live_decisions_set_effort_only_for_the_matching_sol_turn", async () => {
  const requests: [string, string][] = [], difficulties: (string | undefined)[] = [];
  const pool = new ModelConnections(async (url, init) => {
    const { model, reasoning_effort } = z.object({ model: z.string(), reasoning_effort: z.string() }).parse(await new Request(url, init).json());
    requests.push([model, reasoning_effort]);
    return Response.json({ choices: [{ message: { content: '{"text":"완료"}' } }] });
  });
  const model = (model: string, reasoningEffort: string) => createStructuredLlm({ provider: "openai", model, apiKey: "test", reasoningEffort }, { pool });
  const sol = model(STACK.agent, "medium"), utility = model(STACK.utility, "none");
  const request = (text: string) => ({ system: "Reply in text.", user: redactText(text), schemaName: "text", schema: SIMPLE_TEXT_SCHEMA });
  const run = startMonitor(async (text, opts) => {
    difficulties.push(opts.difficulty); await sol?.generate(request(text)); await utility?.generate(request(text)); return { state: "BROWSING", speech: "완료" };
  }, "", "", { effortWaitS: 0.1 });
  const rating = (id: string, choice: unknown) => ({ type: "decision.event", delegation_id: id, event: {
    type: "decision.completed", decision: { answers: [{ type: "choice", name: "sol_effort", choice }] },
  } });
  try {
    run.enqueue(delta("이 앱에서 뭘 할 수 있어", 0, 500)); await run.advance(100); expect(requests).toEqual([]);
    let i = 0;
    for (const [value, difficulty] of [["high", "hard"], ["low", "easy"], ["medium", "medium"], ["invalid", undefined], [{ raw: "high" }, undefined], [null, undefined]] as const) {
      const id = "d" + ++i, start = i * 5000;
      run.enqueue(delta("정부24 열어줘", start, start + 500)); run.enqueue(delegation(id, start + 550, "decisions"));
      if (value !== null) { run.enqueue(rating("unrelated", "high")); run.enqueue(rating(id, value)); }
      await run.advance(1500); expect(run.appended("commentary", id)).toHaveLength(1);
      expect(requests.slice(-2)).toEqual([[STACK.agent, difficulty === undefined ? "medium" : value], [STACK.utility, "none"]]);
      expect(difficulties.at(-1)).toBe(difficulty);
    }
  } finally { await run.close(); }
  await sol?.generate(request("정부24 열어줘")); expect(requests.at(-1)).toEqual([STACK.agent, "medium"]); await pool.close();
});

it("test_progress_question_is_answered_while_a_task_runs", async () => {
  const gate = latch();
  const run = startMonitor(async text => {
    if (text.includes("찾아줘")) { await gate.pending; return { state: "BROWSING", speech: "찾았어요." }; }
    return { state: "BROWSING", speech: "기초연금 페이지를 보고 있어요." };
  });
  try {
    run.enqueue(delta("복지로에서 기초연금 신청 방법 찾아줘", 0, 1500)); run.enqueue(delegation("d1", 1550)); await run.advance(1000);
    run.enqueue(delta("지금 어디까지 했어", 4000, 5000)); run.enqueue(delegation("d2", 5050)); await run.advance(1000);
    expect(run.appended("commentary", "d2")).toEqual(["기초연금 페이지를 보고 있어요."]); expect(run.appended("commentary", "d1")).toEqual([]);
    gate.release(); await run.advance(100); expect(run.appended("commentary", "d1")).toEqual(["찾았어요."]);
  } finally { gate.release(); await run.close(); }
});
it("finished steps are spoken without the 15 second hold, and a fresh utterance waits", async () => {
  const first = latch(), second = latch(), done = latch();
  const progress = new Progress();
  const run = startMonitor(async () => {
    progress.start();
    progress.note("생각하는 중이에요.", false);
    await first.pending;
    progress.note("'신청'을 눌렀어요.", true);
    await second.pending;
    progress.note("'다음'을 눌렀어요.", true);
    await done.pending;
    progress.finish();
    return { state: "BROWSING", speech: "끝" };
  }, "", "", {}, progress);
  const activities = () => run.socket.sendJson.mock.calls.map(call => call[0]).filter(packet =>
    typeof packet === "object" && packet !== null && "activity" in packet);
  try {
    run.enqueue(delta("복지로에서 신청 눌러줘", 0, 800));
    run.enqueue(delegation("d1", 900));
    await run.advance(2000);
    expect(activities()).toEqual([{ activity: "생각하는 중이에요." }]);
    expect(run.appended("commentary", "d1")).toEqual([]);
    run.enqueue(delta("잠깐", 3000, 3200));
    first.release();
    await run.advance(400);
    expect(activities().map(packet => packet.activity)).toContain("'신청'을 눌렀어요.");
    expect(run.appended("commentary", "d1")).toEqual([]);
    await run.advance(1600);
    expect(run.appended("commentary", "d1")).toEqual(["'신청'을 눌렀어요."]);
    second.release();
    await run.advance(3000);
    expect(run.appended("commentary", "d1")).toEqual(["'신청'을 눌렀어요.", "'다음'을 눌렀어요."]);
  } finally { done.release(); await run.close(); }
});

it("test_long_task_speaks_each_new_progress_step_once", async () => {
  const gate = latch(), progress = new Progress();
  const run = startMonitor(async () => {
    progress.start(); progress.note("복지로를 열었어요.", true); await gate.pending; progress.finish();
    return { state: "BROWSING", speech: "찾았어요." };
  }, "", "", { progressGapS: 0.3 }, progress);
  try {
    run.enqueue(delta("복지로에서 기초연금 찾아줘", 0, 1000)); run.enqueue(delegation("d1", 1050)); await run.advance(1800);
    expect(run.appended("commentary", "d1")).toEqual(["복지로를 열었어요."]);
    progress.note("'신청 방법'을 눌렀어요.", true); await run.advance(1400); gate.release(); await run.advance(300);
    expect(run.appended("commentary", "d1")).toEqual(["복지로를 열었어요.", "'신청 방법'을 눌렀어요.", "찾았어요."]);
  } finally { gate.release(); await run.close(); }
});
it("test_reviewed_turn_holds_automatic_progress_and_speaks_the_reviewed_result", async () => {
  const gate = latch(), progress = new Progress(), final = "방문 신청은 확인했지만 온라인 신청 방법은 확인하지 못했어요.";
  const run = startMonitor(async text => {
    if (text === "지금 어디까지 했어") return { state: "BROWSING", speech: progress.latest ?? "" };
    await progress.review(async () => { progress.start(); progress.add("신청 방법 페이지를 열었어요."); await gate.pending; progress.finish(); });
    return { state: "BROWSING", semanticAction: "review-before-output", speech: final };
  }, "", "", {}, progress);
  try {
    run.enqueue(delta("신청 방법을 모두 찾아줘", 10, 600)); run.enqueue(delegation("review", 630)); await run.advance(2000);
    expect(progress.running).toBe(true); await run.advance(17000); expect(run.appended("commentary", "review")).toEqual([]);
    run.enqueue(delta("지금 어디까지 했어", 20000, 20500)); run.enqueue(delegation("status", 20550)); await run.advance(2000);
    expect(run.appended("commentary", "status")).toEqual(["신청 방법 페이지를 열었어요."]);
    gate.release(); await run.advance(1000); expect(run.appended("commentary", "review")).toEqual([]);
    expect(run.socket.sendJson).toHaveBeenCalledWith(expect.objectContaining({ exact: true, result: expect.objectContaining({ speech: final }) }));
    expect(run.appended("thinking", "review").at(-1)).toContain("application is reading"); expect(progress.snapshot().spoken).toBe(true);
  } finally { gate.release(); await run.close(); }
});
it("test_a_user_who_keeps_talking_is_heard_in_full", async () => {
  const turn = ordinary(), run = startMonitor(turn, "", "", { waitForTextS: 1 });
  try {
    run.enqueue(delta("기초연금 신청하려면", 0, 800)); run.enqueue(delegation("d1", 850));
    for (let i = 0; i < 7; i++) { await run.advance(500); run.enqueue(delta(" 말" + i, 1000 + i * 500, 1400 + i * 500)); }
    run.enqueue(delegation("d2", 4500)); await run.advance(7000);
    expect(turn.mock.calls.map(call => call[0])).toEqual(["기초연금 신청하려면 말0 말1 말2 말3 말4 말5 말6"]);
    expect(run.appended("commentary", "d1")).toEqual(["네"]); expect(run.appended("commentary", "d2")).toEqual([]);
  } finally { await run.close(); }
});
it("test_stop_right_after_unanswered_speech_still_stops", async () => {
  const turn = vi.fn<EdgeSession["handleTurn"]>(async () => ({ state: "STOPPED", speech: "멈췄어요." })), run = startMonitor(turn);
  try {
    run.enqueue(delta("다음 페이지", 0, 800)); run.enqueue(delta("멈춰", 2300, 2600)); await run.advance(2000); await run.monitor;
    expect(turn.mock.calls.map(call => call[0])).toEqual(["멈춰"]);
  } finally { await run.close(); }
});
it("test_missing_words_ask_the_user_to_say_it_again", async () => {
  const run = startMonitor(ordinary(), "", "", { waitForTextS: 0.3 });
  try {
    run.enqueue(delegation("d1", 5000)); await run.advance(1000);
    const words = run.appended("commentary", "d1"); expect(words).toHaveLength(1);
    expect(words[0]).toContain("again"); expect(words[0]).not.toContain("service");
  } finally { await run.close(); }
});
it("test_requests_beyond_the_waiting_limit_are_answered_busy", async () => {
  const gate = latch();
  const turn = vi.fn<EdgeSession["handleTurn"]>(async text => { await gate.pending; return { state: "BROWSING", speech: text }; });
  const run = startMonitor(turn, "", "", { maxWaitingTurns: 1 });
  try {
    const words = ["정부24 열어줘", "다음 페이지", "뒤로 가"];
    for (const [i, text] of words.entries()) {
      run.enqueue(delta(text, i * 3000, i * 3000 + 800)); run.enqueue(delegation("d" + i, i * 3000 + 850)); await run.advance(1000);
    }
    expect(run.appended("commentary", "d2")).toEqual([BUSY]); gate.release(); await run.advance(500);
    expect(turn.mock.calls.map(call => call[0])).toEqual(words.slice(0, 2));
  } finally { gate.release(); await run.close(); }
});
