import { expect, it, vi } from "vitest";
import { WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { fingerprint } from "../../src/agents/web/approval.ts";
import { createMockWelfareProfile, fieldVocabulary } from "../../src/agents/web/profile.ts";
import { WelfareInformationAgent } from "../../src/agents/welfare/agent.ts";
import { FixtureWelfareDataProvider } from "../../src/agents/welfare/data/index.ts";
import { ACTION_TYPES, type Action, type Observation } from "../../src/core/actions.ts";
import { draft } from "../../src/core/turn.ts";
import { ApplicationCommands } from "../../src/orchestrator/application.ts";
import { SessionOrchestrator } from "../../src/orchestrator/session.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { RuleBasedIntentProvider } from "../../src/understanding/rules.ts";

function scenario() {
  let now = 0;
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ allowedOrigins:[profile.origin], allowedActionTypes:ACTION_TYPES,
    allowedFieldIds:profile.fields.map(f => f.fieldId), secretFieldIds:["loginPassword"], maxActionsPerTurn:12 });
  const view: Observation = { url:profile.urls.apply, title:"신청", platform:"pc", fields:[], errors:[], dialogs:[], capturedAt:"" };
  const adapter = { async observe() {return view;}, async execute(): Promise<never> { throw new Error("Unexpected browser action"); }, async close() {} };
  const web = new WebExecutionAgent(adapter, guard, profile);
  const welfare = new WelfareInformationAgent(FixtureWelfareDataProvider.fromFile());
  const session = new SessionOrchestrator({web, welfare, clock:() => now, intentProvider:new RuleBasedIntentProvider(fieldVocabulary(profile))});
  const turn = session.beginTurn(redactText("승인"));
  turn.intentType = "APPROVE";
  const commands = new ApplicationCommands(session);
  const click: Action = {id:"asked-click",type:"click",target:{name:"로그인",role:"button"},reason:"로그인 진행",risk:"consequential",requiresConfirmation:true};
  const confirmation = {actionId:click.id,purpose:"확인",site:profile.origin,values:[],realSubmission:false as const};
  function askClick() {
    session.dialogue.askApproval({kind:"click",action:click,fingerprint:fingerprint(view,[click],"누를까요?"),confirmation,url:view.url});
  }
  return {session,web,view,commands,click,confirmation,turn,askClick,advance(seconds: number) { now += seconds; }};
}

it("grants the confirmed action ID only during execution, including when execution fails", async () => {
  const {session,commands,turn,click,askClick} = scenario();
  const execute = vi.spyOn(session.browse,"clickApproved").mockImplementation(async (_approval,ctx) => {
    expect([...ctx.approvals]).toEqual([click.id]);
    throw new Error("browser disconnected");
  });
  expect((await commands.approve(turn)).semanticAction).toBe("none");
  expect(execute).not.toHaveBeenCalled();
  askClick();
  await expect(commands.approve(turn)).rejects.toThrow("browser disconnected");
  expect(turn.ctx.approvals.size).toBe(0);
});

it("refreshes approval at exactly two minutes and requires a fresh answer", async () => {
  const {session,commands,turn,askClick,advance} = scenario();
  const execute = vi.spyOn(session.browse,"clickApproved").mockResolvedValue(draft("BROWSING","confirm-click","눌렀어요."));
  askClick();
  advance(120);
  const renewed = await commands.approve(turn);
  expect(renewed).toMatchObject({state:"WAITING_FOR_USER_CONFIRMATION",masked:true,speech:"여쭤본 지 2분이 지나서 다시 여쭤볼게요. 누를까요?"});
  expect(session.dialogue.approvalAge).toBe(0);
  expect(execute).not.toHaveBeenCalled();
  advance(119);
  expect((await commands.approve(turn)).speech).toBe("눌렀어요.");
  expect(execute).toHaveBeenCalledTimes(1);
});

it("a changed page revokes the pending approval before its action can run", async () => {
  const {session,commands,turn,view,askClick} = scenario();
  const execute = vi.spyOn(session.browse,"clickApproved");
  askClick();
  view.url += "/different-page";
  const result = await commands.approve(turn);
  expect(result.speech).toContain("화면이 바뀌었어요. 그래서 누르지 않았어요.");
  expect(session.dialogue.approval).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
  expect(turn.ctx.approvals.size).toBe(0);
});

it.each(["add","remove","reorder"])("an added or removed assist action cancels the entire approval", async mutation => {
  const {session,view,commands,turn,confirmation} = scenario();
  const first: Action = {id:"a",type:"fill",target:{fieldId:"applicantName"},value:"김하늘",reason:"이름",requiresConfirmation:true,risk:"sensitive"};
  const second: Action = {...first,id:"b",target:{fieldId:"address"},value:"서울 중구",reason:"주소"};
  const actions: [Action, ...Action[]] = [first,second];
  session.dialogue.askApproval({kind:"assist",action:first,actions,confirmation,fingerprint:fingerprint(view,actions,"넣을까요?")});
  if (mutation === "add") actions.push({...first,id:"c"});
  else if (mutation === "remove") actions.pop();
  else actions.reverse();
  const result = await commands.approve(turn);
  expect(result.semanticAction).toBe("none");
  expect(result.speech).toContain("넣지 않았어요.");
  expect(session.dialogue.approval).toBeUndefined();
  expect(turn.ctx.approvals.size).toBe(0);
});

it("refuses a grounded handoff before navigating to an unapproved application origin", async () => {
  const {session,web,commands,turn} = scenario();
  session.grounded = {servNm:"장애인연금",sources:[]};
  web.profile.urls.apply = "https://outside.example.invalid/application";
  const open = vi.spyOn(web,"openApplication");
  const result = await commands.open(turn);
  expect(result).toMatchObject({semanticAction:"agent-handoff",handoff:{requiresApprovedDomain:true,domainApproved:false}});
  expect(result.speech).toContain("허용된 사이트가 아니라서 열지 않았습니다");
  expect(session.grounded).toBeUndefined();
  expect(open).not.toHaveBeenCalled();
});

it("replacing the pending request while the page is observed revokes the old approval", async () => {
  const {session,web,commands,turn,askClick} = scenario();
  askClick();
  const original = session.dialogue.approval;
  const observe = web.observe.bind(web);
  vi.spyOn(web,"observe").mockImplementationOnce(async ctx => {
    askClick();
    return observe(ctx);
  });
  const execute = vi.spyOn(session.browse,"clickApproved");
  const result = await commands.approve(turn);
  expect(result.semanticAction).toBe("none");
  expect(session.dialogue.approval).toBeDefined();
  expect(session.dialogue.approval).not.toBe(original);
  expect(execute).not.toHaveBeenCalled();
});

it("asks which service to apply for without opening the browser when the conversation has no service", async () => {
  const {session,web,turn,commands} = scenario();
  session.deps.practiceMode = false;
  const navigate = vi.spyOn(web,"openSite");
  const practice = vi.spyOn(web,"openApplication");
  const result = await commands.start({...turn,text:redactText("신청 도와줘")});
  expect(result).toMatchObject({semanticAction:"clarify",speech:"어떤 도움을 신청하고 싶으세요? ‘월세를 지원받고 싶어요’처럼 말씀해 주세요."});
  expect(navigate).not.toHaveBeenCalled();
  expect(practice).not.toHaveBeenCalled();
});

it("looks up a known benefit's official guide when its direct address is missing", async () => {
  const {session, commands, turn} = scenario();
  session.deps.practiceMode = false;
  session.grounded = {servNm: "보조기기 지원", sources: []};
  const browse = vi.spyOn(session.browse, "runGoal").mockResolvedValue(draft("BROWSING", "agent-handoff", "안내 페이지를 열었어요."));
  const result = await commands.openOfficial(undefined, turn);
  expect(browse).toHaveBeenCalledWith(expect.stringContaining("보조기기 지원"), expect.objectContaining({publicLookup: true}), {agency: "복지로"});
  expect(result.semanticAction).toBe("agent-handoff");
});

it("executes the checked action snapshot even if another reference changes while the executor is running", async () => {
  const {session,commands,turn,askClick,click} = scenario();
  askClick();
  vi.spyOn(session.browse,"clickApproved").mockImplementation(async approved => {
    click.target = {role:"button",name:"다른 작업"};
    expect(approved.action.target?.name).toBe("로그인");
    return draft("BROWSING","confirm-click","눌렀어요.");
  });
  expect((await commands.approve(turn)).semanticAction).toBe("confirm-click");
});
