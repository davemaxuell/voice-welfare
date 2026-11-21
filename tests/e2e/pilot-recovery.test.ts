import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/server/runtime.ts";
import { PlaywrightExecutionAdapter } from "../../src/agents/web/browser/index.ts";
import { PORTAL } from "../helpers.ts";
import { apiFixture, Approval, Checkpoint, Credentials } from "./runtime-http-fixture.ts";

const generation = z.object({ stopGeneration: z.number() });
it("test_recovered_stopped_session_requires_current_writer_and_stop_generation", async () => {
  const { api, post, close } = apiFixture({ PILOT_PROFILE: "personal", REQUIRE_CONSENT: "true" });
  try {
    const original = Credentials.parse(await (await post("/api/session", { recovery: true })).json());
    const old = { "x-cheongeum-writer": original.writer }, path = "/api/session/" + original.sessionId;
    const first = generation.parse(await (await post(path + "/cancel", undefined, old)).json());
    expect((await post(path + "/detach", undefined, old)).status).toBe(200);
    const recovered = Credentials.and(Checkpoint).parse(await (await post("/api/session/recover", { token: original.token, attempt: randomUUID() })).json());
    const writer = { "x-cheongeum-writer": recovered.writer }, token = generation.parse(recovered.checkpoint);
    expect(token.stopGeneration).toBeGreaterThan(first.stopGeneration); expect(recovered.checkpoint.state).toBe("STOPPED");
    expect((await post(path + "/wake", token, writer)).status).toBe(409);
    expect(await (await post(path + "/resume", undefined, writer)).json()).toMatchObject({ ...token, state: "STOPPED" });
    expect((await post(path + "/wake", token, old)).status).toBe(409);
    expect((await post(path + "/wake", first, writer)).status).toBe(409);
    expect(await (await post(path + "/wake", token, writer)).json()).toEqual({ state: "IDLE" });
    expect(api.sessions.get(original.sessionId)?.consentStatus).toBe("pending");
  } finally { await close(); }
});
it("test_recovery_rotates_writer_and_revalidates_before_fresh_approval", async () => {
  const { api, post, close } = apiFixture({ PILOT_PROFILE: "personal" });
  try {
    const original = Credentials.parse(await (await post("/api/session", { recovery: true })).json());
    const old = { "x-cheongeum-writer": original.writer }, path = "/api/session/" + original.sessionId;
    const turn = async (text: string, headers = old) => (await post("/api/turn", { sessionId: original.sessionId, text }, headers)).json();
    await turn(PORTAL + " 열어줘");
    const first = Approval.parse(await turn("이름 칸에 김하늘 써줘")).pendingConfirmation;
    expect(first.kind).toBe("field-entry"); expect((await post(path + "/detach", undefined, old)).status).toBe(200);
    expect((await api.request(path + "/state", { headers: old })).status).toBe(409);
    const race = await Promise.all([0, 1].map(() => post("/api/session/recover", { token: original.token, attempt: randomUUID() })));
    expect(race.map(r => r.status).sort((a, b) => a - b)).toEqual([200, 404]);
    const winner = Credentials.and(Checkpoint).parse(await race.find(r => r.ok)?.json());
    expect(winner.token).not.toBe(original.token); expect(winner.writer).not.toBe(original.writer);
    expect(winner.checkpoint.approvalKind).toBe("field-entry"); expect(JSON.stringify(winner.checkpoint)).not.toContain("김하늘");
    const writer = { "x-cheongeum-writer": winner.writer };
    expect((await api.request(path + "/state", { headers: writer })).status).toBe(409);
    expect((await post(path + "/resume", undefined, writer)).status).toBe(200);
    expect(await (await api.request(path + "/state", { headers: writer })).json()).not.toHaveProperty("pendingConfirmation");
    const current = Approval.parse(await turn("이름 칸에 김하늘 써줘", writer)).pendingConfirmation;
    expect(current.actionId).not.toBe(first.actionId);
    expect(await (await post(path + "/confirm", { approve: true, actionId: first.actionId }, writer)).json()).toMatchObject({ actions: [] });
    const retry = { ...writer, "x-cheongeum-request": "1" }, body = { approve: true, actionId: current.actionId };
    const adapter = api.sessions.get(original.sessionId)?.web.adapter;
    const page = adapter instanceof PlaywrightExecutionAdapter ? adapter.page : undefined;
    if (page === undefined) throw new Error("No work page");
    await page.evaluate(() => { document.body.dataset.entries = "0"; document.addEventListener("input", () => { document.body.dataset.entries = String(Number(document.body.dataset.entries) + 1); }); });
    const done = await (await post(path + "/confirm", body, retry)).json();
    expect(await (await post(path + "/confirm", body, retry)).json()).toEqual(done);
    expect(await page.evaluate(() => document.body.dataset.entries)).toBe("1");
    const actions = z.object({ actions: z.array(z.object({ result: z.object({ ok: z.boolean() }).optional() })) }).parse(done).actions;
    expect(actions.filter(action => action.result?.ok === true)).toHaveLength(1);
    expect((await post(path + "/confirm", { ...body, approve: false }, retry)).status).toBe(409);
    expect(await (await post(path + "/cancel", undefined, writer)).json()).toMatchObject({ state: "STOPPED" });
    expect((await api.request(path, { method: "DELETE", headers: writer })).status).toBe(200);
    expect((await post("/api/session/recover", { token: winner.token, attempt: randomUUID() })).status).toBe(404);
  } finally { await close(); }
});
it("test_shared_profiles_isolate_personal_state_and_preserve_three_active_sessions", async () => {
  const { rt, api, post, close } = apiFixture({ PILOT_PROFILE: "shared", CHEONGEUM_DATA_DIR: "unused", BROWSER_MODE: "chrome" });
  try {
    expect(rt.config.dataDir).toBeUndefined(); expect(rt.config.browserMode).toBe("chromium");
    expect(loadConfig({}).pilotProfile).toBe("unidentified");
    expect((await post("/api/session", { recovery: true })).status).toBe(403);
    const responses = await Promise.all([1, 2, 3, 4].map(() => post("/api/session")));
    expect(responses.map(r => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200, 409]);
    expect(new Set(api.sessions.values().map(s => s.personal)).size).toBe(3);
    for (const s of api.sessions.values()) expect((await api.request("/api/session/" + s.id + "/state")).status).toBe(200);
  } finally { await close(); }
});

it("issues current auth choices after reconnecting the same browser", async () => {
  const { post, close } = apiFixture({ PILOT_PROFILE: "personal" });
  try {
    const original = Credentials.parse(await (await post("/api/session", { recovery: true })).json());
    const old = { "x-cheongeum-writer": original.writer };
    const path = "/api/session/" + original.sessionId;
    const turn = async (text: string) => (await post("/api/turn", { sessionId: original.sessionId, text }, old)).json();
    await turn("장애인연금 신청 도와줘");
    const initial = z.object({ turnId: z.string(), authHandoff: z.object({ id: z.string() }) }).parse(await turn("로그인하고 싶어"));
    expect((await post(path + "/detach", undefined, old)).status).toBe(200);
    const recovered = Credentials.parse(await (await post("/api/session/recover", { token: original.token, attempt: randomUUID() })).json());
    const writer = { "x-cheongeum-writer": recovered.writer };
    const resumed = z.object({ turnId: z.string(), offeredChoices: z.array(z.object({ key: z.string() })) })
      .parse(await (await post(path + "/resume", undefined, writer)).json());
    expect(resumed.turnId).not.toBe(initial.turnId);
    expect(resumed.offeredChoices.map(choice => choice.key)).toEqual(["auth-done", "auth-cancel"]);
    const chosen = { turnId: resumed.turnId, key: "auth-cancel", handoffId: initial.authHandoff.id };
    expect((await post(path + "/choice", { ...chosen, turnId: initial.turnId }, writer)).status).toBe(409);
    expect((await post(path + "/choice", chosen, old)).status).toBe(409);
    expect(await (await post(path + "/choice", chosen, writer)).json()).toMatchObject({ authHandoff: { status: "cancelled" }, actions: [] });
  } finally { await close(); }
});
