import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";
import { ActionSchema } from "../../src/core/actions.ts";
import { AuthHandoff, DialogueState } from "../../src/core/dialogue.ts";
import { PlaceAsk, isPlaceKind } from "../../src/core/places.ts";
import { RegionMention } from "../../src/core/region.ts";
import { PendingConfirmationSchema, SessionStateSchema } from "../../src/core/turn.ts";

// 기대값은 pyref(77aad3e)의 cheongeum.core.dialogue.DialogueState에 같은 동작을 차례로 시킨 결과다. 만드는 법은 tests/fixtures/core/generate.py.
const fingerprint = z.object({ page: z.string(), speech: z.string(), fields: z.array(z.never()), actions: z.array(z.never()) });
const acting = { action: ActionSchema, confirmation: PendingConfirmationSchema, fingerprint };
const text = z.string();
const approval = z.union([
  z.object({ ...acting, kind: z.literal("submit").optional(), url: text.optional() }),
  z.object({ ...acting, kind: z.literal("assist"), url: text, guided: z.boolean().optional(), actions: z.tuple([ActionSchema]).rest(ActionSchema) }),
  z.object({ ...acting, kind: z.literal("click"), url: text, then: z.enum(["login-open", "login-submit"]).optional() }),
  z.object({ kind: z.literal("file"), record: z.unknown(), digest: text, question: text, confirmation: PendingConfirmationSchema }),
  z.object({ kind: z.literal("visual"), goal: text, checkpoint: z.unknown(), confirmation: PendingConfirmationSchema }),
  z.object({ kind: z.literal("research"), goal: text, confirmation: PendingConfirmationSchema }),
]);
const contact = z.object({ name: text, phone: text });
const vault = z.union([
  z.object({ kind: z.literal("vault-clear") }),
  z.object({ kind: z.literal("vault-save"), values: z.object({ name: text.optional(), address: text.optional(), phone: text.optional(), email: text.optional(), birth: text.optional() }) }),
  z.object({ kind: z.enum(["guardian-save", "guardian-clear"]), contact, at: z.number(), resume: SessionStateSchema }),
  z.object({ kind: z.literal("guardian-send"), contact, at: z.number(), resume: SessionStateSchema, message: text, screen: text }),
]);
const place = z.object({
  kind: text, region: z.object({ province: text, districts: z.array(text), dong: text }), options: z.array(text), field: text,
});
const handoff = z.object({
  id: text, session_id: text, task_id: text, browser: z.boolean(), expected_origin: text, expected_path: text,
  kind: z.enum(["login", "verification", "captcha"]), deadline: z.number(), site: text,
});
const authStatus = z.enum(["waiting", "completed", "cancelled", "expired", "interrupted", "blocked"]);
const op = z.union([
  z.tuple([z.literal("tick"), z.number()]), z.tuple([z.literal("commit"), SessionStateSchema]),
  z.tuple([z.literal("ask_approval"), approval]), z.tuple([z.literal("clear_approval")]),
  z.tuple([z.literal("ask_value"), text]), z.tuple([z.literal("drop_value_wait")]), z.tuple([z.literal("value_filled"), text]),
  z.tuple([z.literal("navigated"), z.boolean()]), z.tuple([z.literal("ask_which"), text, z.array(z.unknown())]), z.tuple([z.literal("clear_choice")]),
  z.tuple([z.literal("ask_site"), z.record(text, z.unknown())]), z.tuple([z.literal("take_site_guess")]),
  z.tuple([z.literal("ask_first_run"), text]), z.tuple([z.literal("end_first_run")]),
  z.tuple([z.literal("ask_profile"), text]), z.tuple([z.literal("profile_done")]),
  z.tuple([z.literal("ask_place"), place.nullable()]), z.tuple([z.literal("take_place_ask")]),
  z.tuple([z.literal("ask_vault_confirm"), vault]), z.tuple([z.literal("take_vault_confirm")]),
  z.tuple([z.literal("start_guided"), text, z.array(text)]), z.tuple([z.literal("end_guided")]),
  z.tuple([z.literal("hold_auth"), z.object({ kind: z.enum(["form", "guided"]) }).nullable(), handoff.nullable()]),
  z.tuple([z.literal("take_auth_resume")]), z.tuple([z.literal("clear_auth_resume")]), z.tuple([z.literal("finish_auth"), authStatus]),
  z.tuple([z.literal("stop")]), z.tuple([z.literal("stop_preserve_auth")]),
]);
const fixture = z.object({
  scenarios: z.record(text, z.tuple([z.array(op), z.array(z.object({ ret: z.unknown(), after: z.record(text, z.unknown()) }))])),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/dialogue.json", import.meta.url), "utf8")));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu;
const normal = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).replace(UUID, "<uuid>"));

function placeJson(ask: PlaceAsk | undefined) {
  return ask === undefined ? null : {
    kind: ask.kind, region: { province: ask.region.province, districts: [...ask.region.districts], dong: ask.region.dong },
    options: [...ask.options], field: ask.field,
  };
}

function run(steps: z.infer<typeof op>[]) {
  const clock = { now: 100 };
  const state = new DialogueState<unknown>("IDLE", () => clock.now);
  const browser = {};
  return steps.map(step => {
    let ret: unknown = null;
    switch (step[0]) {
      case "tick": clock.now += step[1]; break;
      case "commit": state.commit(step[1]); break;
      case "ask_approval": state.askApproval(step[1]); break;
      case "clear_approval": state.clearApproval(); break;
      case "ask_value": state.askValue(step[1]); break;
      case "drop_value_wait": state.dropValueWait(); break;
      case "value_filled": state.valueFilled(step[1]); break;
      case "navigated": state.navigated(step[1]); break;
      case "ask_which": state.askWhich(step[1], step[2]); break;
      case "clear_choice": state.clearChoice(); break;
      case "ask_site": state.askSite(step[1]); break;
      case "take_site_guess": ret = state.takeSiteGuess(); break;
      case "ask_first_run": state.askFirstRun(step[1]); break;
      case "end_first_run": state.endFirstRun(); break;
      case "ask_profile": state.askProfile(step[1]); break;
      case "profile_done": state.profileDone(); break;
      case "ask_place": {
        const raw = step[1];
        if (raw !== null && !isPlaceKind(raw.kind)) throw new Error(raw.kind);
        state.askPlace(raw === null || !isPlaceKind(raw.kind) ? undefined
          : new PlaceAsk(raw.kind, new RegionMention(raw.region.province, raw.region.districts, raw.region.dong), raw.options, raw.field));
        break;
      }
      case "take_place_ask": ret = placeJson(state.takePlaceAsk()); break;
      case "ask_vault_confirm": state.askVaultConfirm(step[1]); break;
      case "take_vault_confirm": ret = state.takeVaultConfirm(); break;
      case "start_guided": state.startGuided(step[1], step[2]); break;
      case "end_guided": state.endGuided(); break;
      case "hold_auth": {
        const raw = step[2];
        state.holdAuth(step[1] ?? undefined, raw === null ? undefined : new AuthHandoff({
          id: raw.id, sessionId: raw.session_id, taskId: raw.task_id, browser: raw.browser ? browser : null, expectedOrigin: raw.expected_origin,
          expectedPath: raw.expected_path, kind: raw.kind, deadline: raw.deadline, site: raw.site,
        }));
        break;
      }
      case "take_auth_resume": ret = state.takeAuthResume(); break;
      case "clear_auth_resume": state.clearAuthResume(); break;
      case "finish_auth": state.finishAuth(step[1]); break;
      case "stop": state.stop(); break;
      case "stop_preserve_auth": state.stop({ preserveAuth: true }); break;
    }
    const held = state.authHandoff;
    return {
      op: step,
      ret: normal(ret),
      after: normal({
        state: state.state, approval: state.approval ?? null, age: state.approvalAge, awaiting: state.awaiting ?? null,
        clarification: state.clarification ?? null, profileQuestion: state.profileQuestion ?? null, placeAsk: placeJson(state.placeAsk),
        vaultConfirm: state.vaultConfirm ?? null, guided: state.guided ?? null, authResume: state.authResume ?? null,
        authHandoff: held === undefined ? null : {
          public: held.public(), sessionId: held.sessionId, expectedOrigin: held.expectedOrigin, expectedPath: held.expectedPath,
          deadline: held.deadline, browserHeld: held.browser !== null,
        },
        authWaiting: state.authWaiting, pending: state.hasPendingInteraction, firstRun: state.firstRun ?? null,
        confirmation: state.confirmation ?? null, expectsConfirmation: state.expectsConfirmation,
      }),
    };
  });
}

it("대화 상태가 장면마다 동작 하나하나 Python과 같다", () => {
  const names = Object.keys(fixture.scenarios);
  expect(names.length).toBeGreaterThan(40);
  const different = names.flatMap(name => {
    const [steps, expected] = fixture.scenarios[name] ?? [[], []];
    const actual = run(steps);
    const at = actual.findIndex((entry, index) => {
      const want = expected[index];
      return want === undefined || !isDeepStrictEqual(normal(entry.after), normal(want.after)) || !isDeepStrictEqual(entry.ret, normal(want.ret));
    });
    return at < 0 && actual.length === expected.length ? [] : [{ name, at, step: steps[at], actual: actual[at], expected: expected[at] }];
  });
  expect(different.slice(0, 2)).toEqual([]);
});

it("같은 확인 문구로 다시 물으면 새 확인 번호를 달고 다른 문구면 그대로 둔다", () => {
  const state = new DialogueState("IDLE", () => 0);
  const asked = approval.parse({
    action: { id: "a", type: "click", reason: "모의 접수", risk: "consequential", requiresConfirmation: true },
    confirmation: { actionId: "first", purpose: "모의 접수", site: "연습", values: [], realSubmission: false },
    fingerprint: { page: "p", speech: "s", fields: [], actions: [] },
  });
  state.askApproval(asked);
  expect(state.confirmation?.actionId).toBe("first");
  state.askApproval(asked);
  expect(state.confirmation?.actionId).not.toBe("first");
  expect(asked.confirmation.actionId).toBe("first");
  state.askApproval({ ...asked, confirmation: { ...asked.confirmation, purpose: "다른 일" } });
  expect(state.confirmation?.purpose).toBe("다른 일");
});

it("읽기 전용 자리는 새로 생긴 것도 바꿀 수 없다", () => {
  for (const name of ["placeAsk", "firstRun", "authHandoff", "authWaiting", "hasPendingInteraction", "confirmation", "approvalAge"]) {
    expect(Reflect.set(new DialogueState("IDLE"), name, undefined), name).toBe(false);
  }
});
