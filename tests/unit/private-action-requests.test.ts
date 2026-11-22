import { expect, it, vi } from "vitest";
import { WelfareInformationAgent } from "../../src/agents/welfare/agent.ts";
import { FixtureWelfareDataProvider } from "../../src/agents/welfare/data/index.ts";
import { WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { LinkChoices } from "../../src/agents/web/link_choices.ts";
import { createMockWelfareProfile, fieldVocabulary } from "../../src/agents/web/profile.ts";
import { ACTION_TYPES } from "../../src/core/actions.ts";
import { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { MESSAGE } from "../../src/personal/guardian.ts";
import { PersonalStore } from "../../src/personal/store.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";
import { browser } from "./fake-browser.ts";

function privateSession(requireConsent = false) {
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ directActions: true, allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES,
    allowedFieldIds: [], secretFieldIds: [], maxActionsPerTurn: 12 });
  const personal = new PersonalStore();
  const generate = vi.fn(async () => undefined);
  const send = vi.fn(async () => "accepted" as const);
  const session = new SessionOrchestrator({ personal, requireConsent, web: new WebExecutionAgent(browser({}).adapter, guard, profile),
    welfare: new WelfareInformationAgent(FixtureWelfareDataProvider.fromFile()),
    intentProvider: new RuleBasedIntentProvider(fieldVocabulary(profile)), llm: {name: "test", generate},
    guardianSender: {preview: false, send} });
  return { personal, session, send, generate };
}

it("내 정보의 삭제나 저장에 대해 묻거나 거절·정정한 음성은 금고와 외부 모델에 전달하지 않는다", async () => {
  const { personal, session, generate } = privateSession();
  personal.saveVault({address: "기존길"});
  for (const text of ["내 정보 삭제하면 어떻게 되나요?", "내 정보 삭제하지 마세요",
    "내 정보를 지워줘, 아니 지우지 마", "내 주소는 모란길이라고 기억해두지는 마세요",
    "내 주소는 모란길이라고 저장하면 어디에 보관돼요?", "내 주소는 모란길 말고 다른 주소로 저장해 줘",
    "내 주소는 모란길이면 저장해줘", "내 주소는 모란길이라고 안저장해 줘",
    "내 주소는 모란길이고 주소는 다른길이라고 저장해줘"]) {
    const turn = await session.handleTurn(text, {fromVoice: true});
    expect(personal.vault(), text).toEqual({address: "기존길"});
    expect(turn.pendingConfirmation, text).toBeUndefined();
    expect(turn.localSpeechOnly, text).toBe(true);
  }
  expect(JSON.stringify(session.exportHistory())).not.toContain("모란길");
  expect(generate).not.toHaveBeenCalled();
  expect((await session.handleTurn("내 주소는 가람길이라고 저장해 주세요")).pendingConfirmation).toBeUndefined();
  expect(personal.vault()).toEqual({address: "가람길"});
  expect((await session.handleTurn("저장된 내 정보를 모두 지워 주세요")).pendingConfirmation).toBeUndefined();
  expect(personal.vault()).toEqual({});
});

it("보호자 연락·삭제의 질문과 금지·정정은 기기 안에서 처리하고 명시적으로 요청한 문자만 한 번 발송한다", async () => {
  const { personal, session, send, generate } = privateSession();
  const contact = {name: "예시보호자", phone: "01011112222"};
  personal.setGuardian(contact);
  for (const text of ["보호자에게 문자 보내면 뭐라고 가나요?", "보호자한테 연락하지 마세요",
    "보호자에게 문자 보내줘, 아니 보내지 마", "보호자 문자", "보호자 연락처를 지워도 되나요?",
    "보호자 번호는 삭제하지 마세요", "보호자 이름은 하늘이고 전화번호는 01033334444"]) {
    const turn = await session.handleTurn(text, {fromVoice: true});
    expect(personal.guardian(), text).toEqual(contact);
    expect(send, text).not.toHaveBeenCalled();
    expect(turn.localSpeechOnly, text).toBe(true);
  }
  expect(JSON.stringify(session.exportHistory())).not.toContain("01033334444");
  expect(generate).not.toHaveBeenCalled();
  const save = await session.handleTurn("보호자 이름은 하늘이고 전화번호는 01033334444 등록해 주세요");
  expect(save.pendingConfirmation).toBeUndefined();
  expect(personal.guardian()).toEqual({name: "하늘", phone: "01033334444"});
  expect((await session.handleTurn("보호자에게 문자 보내 주세요")).pendingConfirmation).toBeUndefined();
  expect(send.mock.calls).toEqual([["01033334444", MESSAGE]]);
  expect((await session.handleTurn("보호자 연락처를 삭제해 주세요")).pendingConfirmation).toBeUndefined();
  expect(personal.guardian()).toBeUndefined();
});

it("이용 동의 전에도 거절한 값은 대화 기록과 모델로 전달하지 않는다", async () => {
  const { session, personal, generate } = privateSession(true);
  const answer = await session.handleTurn("내 주소는 산들길이라고 기억해두지는 마세요", {fromVoice: true});
  expect(answer.localSpeechOnly).toBe(true);
  expect(personal.vault()).toEqual({});
  expect(JSON.stringify(session.exportHistory())).not.toContain("산들길");
  expect(generate).not.toHaveBeenCalled();
});

it("다른 링크에 대한 대답을 기다리더라도 새 개인 정보 요청은 승인 모델로 보내지 않는다", async () => {
  const { session, generate, send } = privateSession();
  for (const text of ["내 주소는 늘푸른길이라고 기억해두지는 마세요", "보호자에게 문자 보내면 무슨 내용이 가나요?"]) {
    session.browse.linkChoices = new LinkChoices("about:blank", [{name: "현재 공지", role: "link", ref: "r1"}], "search", 1, "current");
    const answer = await session.handleTurn(text, {fromVoice: true});
    expect(answer.localSpeechOnly, text).toBe(true);
    expect(generate, text).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }
});
