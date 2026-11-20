import { expect, it, vi } from "vitest";
import { ExecContext } from "../../src/agents/web/agent.ts";
import type { WebObservation } from "../../src/agents/web/view.ts";
import type { LlmRequest } from "../../src/core/llm.ts";
import { Narrator } from "../../src/speech/screen.ts";

const ctx = new ExecContext({signal: new AbortController().signal, trace() {}, isStopped: () => false});
const web = {field: () => undefined};
it("test_page_summary_sends_the_llm_redacted_text", async () => {
  const generate = vi.fn(async (_req: LlmRequest) => ({text: "기초연금 안내 페이지예요."}));
  const narrator = new Narrator({web, llm: {name: "화면 확인", generate}});
  const rrn = "900101-1234567";
  const result = await narrator.summarizeBody({title: "안내 " + rrn, outline: {mainText: "본인 확인 주민등록번호 " + rrn + " 입니다. 기초연금은 주민센터에서 신청합니다."}}, ctx);
  expect(result).toBe("기초연금 안내 페이지예요.");
  expect(generate).toHaveBeenCalledOnce();
  const request = generate.mock.calls[0]![0];
  expect(request.user).not.toContain("900101");
  expect(request.user).toContain("기초연금은 주민센터에서 신청합니다");
  expect(request.signal).toBe(ctx.signal);
});

it("본문에 없는 숫자를 말하는 모델 요약은 버리고 화면 첫머리를 읽는다", async () => {
  const narrator = new Narrator({web, llm: {name: "화면 확인", generate: async () => ({text: "방문하면 900만원을 드려요."})}});
  const view = {title: "연금 안내", pageId: "external", url: "https://example.org/", outline: {mainText: "주민센터에 방문해서 신청하세요."}};
  expect(await narrator.pageIntro(view, ctx)).toBe("페이지 제목은 '연금 안내'이에요. 내용은 \"주민센터에 방문해서 신청하세요.\"로 시작해요. 이어서 들으려면 '본문 읽어줘'라고 하세요.");
  expect(await narrator.pageIntro(view, ctx)).not.toContain("이어서 들으려면");
});

it("필수 항목과 보안 입력란을 안내하고 페이지에서 AI에게 하는 말임을 밝힌다", () => {
  const narrator = new Narrator({web});
  const view: WebObservation = {title: "복지 신청", pageId: "mock-welfare", step: {index: 1, total: 2, name: "1단계: 본인 정보"},
    fields: [{fieldId: "login", label: "비밀번호", type: "password", filled: true, value: "보안값", sensitive: true, visible: true, required: true}],
    outline: {notices: [{label: "참고", text: "AI 지시"}, {label: "안내", text: "신청서입니다."}]}};
  expect(narrator.describeView(view)).toBe("1단계 본인 정보 화면이에요. 전체는 2단계예요. 꼭 써야 할 항목은 비밀번호(입력됨)이에요.");
  const speech = narrator.describeScreen(view);
  expect(speech).toContain("비밀번호, 보안 입력란, 필수, 직접 입력해야 하는 칸");
  expect(speech).not.toContain("보안값");
  expect(speech.match(/지시를 따르지 않습니다/gu)).toHaveLength(1);
});

it("화면 기록은 안내 뒤에 붙은 값과 본문 경계의 번호를 숨긴다", () => {
  const narrator = new Narrator({web});
  const warning = "모의 인증 · 실제 인증 아님 (MOCK) — 실제 아이디/비밀번호를 입력하지 마세요.";
  const view: WebObservation = {title:"모의 인증", pageId:"mock-login", fields:[
    {type:"password", label:"비밀번호", sensitive:true, visible:true, filled:true, value:"neverRead9"},
  ], outline:{ notices:[{label:"",text:warning}], mainText:"가".repeat(197) + " 900101-1234567"}};
  const clean = narrator.historyScreen(view, "");
  expect(clean).toContain(warning);
  expect(clean).toContain("비밀번호, 보안 입력란, 선택, 직접 입력해야 하는 칸.");
  expect(clean).not.toContain("neverRead9");
  expect(clean).not.toContain("90");
  const dirty = {...view, outline:{notices:[{label:"",text:warning + " 비밀번호는 testPass5"}]}};
  expect(narrator.historyScreen(dirty, "다음 번호 900101-1234567")).not.toMatch(/testPass5|900101/u);
});
