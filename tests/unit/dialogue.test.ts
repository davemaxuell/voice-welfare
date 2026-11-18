import { expect, it } from "vitest";
import { DialogueState } from "../../src/core/dialogue.ts";

const approval: Parameters<DialogueState["askApproval"]>[0] = {
  action: { id: "submit-1", type: "click", requiresConfirmation: true, reason: "모의 접수", risk: "consequential" },
  confirmation: { actionId: "submit-1", purpose: "모의 접수", site: "연습", values: [], realSubmission: false },
  fingerprint: { page: "mock-welfare", speech: "접수할까요?", actions: [], fields: [] },
};

it.each(["state", "approval", "awaiting", "clarification", "profileQuestion", "vaultConfirm", "guided", "authResume"])("test_slots_are_read_only", name => {
  expect(Reflect.set(new DialogueState("IDLE"), name, undefined)).toBe(false);
});

it("test_value_filled_releases_matching_wait_and_voids_approval", () => {
  const state = new DialogueState("APPLICATION_OPEN");
  state.askValue("applicantName");
  state.askApproval(approval);
  state.valueFilled("applicantName");
  expect([state.awaiting, state.approval, state.confirmation]).toEqual([undefined, undefined, undefined]);
});

it("test_value_filled_keeps_wait_for_another_field", () => {
  const state = new DialogueState("APPLICATION_OPEN");
  state.askValue("address");
  state.askApproval(approval);
  state.valueFilled("applicantName");
  expect(state.awaiting).toBe("address");
  expect(state.approval).toBeUndefined();
});

it("test_navigated_off_form_drops_wait_and_approval", () => {
  const state = new DialogueState("APPLICATION_OPEN");
  state.askValue("applicantName");
  state.askApproval(approval);
  state.navigated(false);
  expect(state.awaiting).toBeUndefined();
  expect(state.approval).toBeUndefined();
});

it("test_navigated_on_form_keeps_wait", () => {
  const state = new DialogueState("APPLICATION_OPEN");
  state.askValue("applicantName");
  state.askApproval(approval);
  state.navigated(true);
  expect(state.awaiting).toBe("applicantName");
  expect(state.approval).toBeUndefined();
});

it("test_approval_age_counts_from_the_latest_ask", () => {
  let now = 100;
  const state = new DialogueState("APPLICATION_OPEN", () => now);
  state.askApproval(approval);
  now += 90;
  expect(state.approvalAge).toBe(90);
  state.askApproval(approval);
  expect(state.approvalAge).toBe(0);
});

it("test_stop_clears_every_wait", () => {
  const state = new DialogueState<string>("APPLICATION_OPEN");
  state.askApproval(approval);
  state.askValue("applicantName");
  state.askWhich("부산", ["주민등록 주소", "실거주지 주소"]);
  state.askProfile("age");
  state.askVaultConfirm({ kind: "vault-clear" });
  state.startGuided("https://example.org/form", ["f1", "f2"]);
  state.holdAuth({ kind: "form" });
  state.stop();
  expect([state.approval, state.awaiting, state.clarification, state.profileQuestion, state.vaultConfirm, state.guided, state.authResume])
    .toEqual(Array(7).fill(undefined));
  expect(state.state).toBe("APPLICATION_OPEN");
  state.commit("STOPPED");
  expect(state.state).toBe("STOPPED");
});

it("test_hold_auth_and_take_resume", () => {
  const state = new DialogueState("APPLICATION_OPEN");
  state.holdAuth({ kind: "form" });
  expect(state.authResume).toEqual({ kind: "form" });
  expect(state.takeAuthResume()).toEqual({ kind: "form" });
  expect(state.authResume).toBeUndefined();
});
