import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { ExecContext, WebExecutionAgent } from "../../src/agents/web/agent.ts";
import { createMockWelfareProfile } from "../../src/agents/web/profile.ts";
import { ACTION_TYPES, ObservationSchema, type Action, type Observation } from "../../src/core/actions.ts";
import { PolicyGuard } from "../../src/safety/guard.ts";
import { Autopilot } from "../../src/agents/web/autopilot.ts";
import { WebObservationSchema } from "../../src/agents/web/view.ts";
import type { LlmRequest } from "../../src/core/llm.ts";

// 목표 수행의 출처: 근거 문장이 실제로 있던 화면(독립 검토 2026-11-19, 먼저 본 화면을 출처로 잡던 문제).
const HOME = z.object({ home: WebObservationSchema }).parse(
  JSON.parse(readFileSync(new URL("../fixtures/bokjiro-public-pages.json", import.meta.url), "utf8")),
).home;
const HOME_OUTLINE = { headings: [], notices: [], steps: [], buttons: [], links: [] };
const observed = ObservationSchema.parse({ ...HOME, capturedAt: "", outline: { ...HOME_OUTLINE, ...HOME.outline } });
const NPS = "https://www.nps.or.kr/guide/basic.do";

function fakeWeb(extra = "") {
  const official: Observation = {
    ...observed, url: NPS, title: "기초연금 신청 안내 | 국민연금공단", dialogs: [],
    outline: { ...observed.outline ?? HOME_OUTLINE, items: [], mainText: "기초연금신청\n기초연금은 만 65세 이상이면 주소지 주민센터나 국민연금공단 지사에서 신청할 수 있습니다." + extra },
  };
  let view = observed;
  const profile = createMockWelfareProfile("http://localhost:5174");
  const guard = new PolicyGuard({ allowedOrigins: [profile.origin], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [],
    secretFieldIds: [], maxActionsPerTurn: 12, readOnlyWeb: true });
  const adapter = {
    observe: async () => view,
    execute: async (action: Action) => {
      if (action.type === "navigate") view = official;
      return { actionId: action.id, ok: true, verified: true, latencyMs: 0 };
    },
    close: async () => {},
  };
  return new WebExecutionAgent(adapter, guard, profile);
}

function model(answer: string, evidence: string[]) {
  let n = 0;
  return {
    name: "fake",
    generate: async (_: LlmRequest) => ++n === 1
      ? { action: "open_url", target: NPS, answer: "", evidence: [] }
      : { action: "answer", target: "", answer, evidence },
  };
}
const context = () => new ExecContext({ signal: new AbortController().signal, isStopped: () => false, trace() {} });

it("test_source_is_the_page_that_holds_the_answer", async () => {
  const web = fakeWeb();
  const result = await new Autopilot(web, model("기초연금은 주소지 주민센터나 국민연금공단 지사에서 신청할 수 있어요.",
    ["기초연금신청", "주소지 주민센터나 국민연금공단 지사에서 신청할 수 있습니다"]), { searchUrl: q => `https://s/?q=${q}` })
    .run("기초연금 신청은 어디서 하는지 찾아줘", context());
  expect(result.status).toBe("answered");
  expect(result.sources.map(source => source.url)).toEqual([NPS]);
});

it("test_answer_from_two_pages_cites_both", async () => {
  const web = fakeWeb(" 상담 시간은 평일 09:00~18:00입니다.");
  const result = await new Autopilot(web, model("맞춤형급여안내에 가입할 수 있고, 상담은 평일 09:00~18:00이에요.",
    ["맞춤형급여안내(복지멤버십) 서비스에 가입하여 맞춤형 서비스 안내를 경험해 보세요.", "평일 09:00~18:00"]), { searchUrl: q => `https://s/?q=${q}` })
    .run("복지멤버십과 상담 시간 알려줘", context());
  expect(result.status).toBe("answered");
  expect(new Set(result.sources.map(source => source.url))).toEqual(new Set([HOME.url, NPS]));
});
