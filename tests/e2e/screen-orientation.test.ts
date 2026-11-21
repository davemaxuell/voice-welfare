import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { VisionModel } from "../../src/agents/web/visual_step.ts";
import { FakeLlm, PORTAL, scripted, step } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const goal = PORTAL + "에서 장애인연금 안내 기사 내용 알려줘";
const link = "장애인연금 안내";
const answer = step("answer", null, "두 번째 페이지라는 안내 기사예요.", ["두 번째 페이지입니다"]);
const openPortal = step("open_url", "http://" + PORTAL);
const inspect = step("inspect_screen");

const Seen = z.looseObject({ schemaName: z.string() });
const Menus = z.object({ knownControls: z.array(z.string()), goal: z.string() });

it.each(["approve", "reject"])("test_screen_orientation_asks_once_then_sends_one_redacted_picture_%s", async path => {
  const { session } = await open();
  const requests = scripted(session, [openPortal, inspect, step("click", link), answer]);
  const see = vi.fn<VisionModel["see"]>(async request => {
    expect(Seen.parse(request).schemaName).toBe("screen_orientation");
    const { knownControls } = Menus.parse(JSON.parse(request.user));
    expect(knownControls).toContain(link);
    return { place: "장애인연금 안내 첫 화면", menus: [link, "사진에만 보이는 배너"] };
  });
  session.deps.visionLlm = { see };

  const first = await session.handleTurn(goal);
  expect(first.state).toBe("WAITING_FOR_USER_CONFIRMATION");
  expect(first.pendingConfirmation?.kind).toBe("visual-navigation");
  expect(first.pendingConfirmation?.purpose).toBe("화면 사진으로 메뉴 찾기");
  expect(first.pendingConfirmation?.values).toEqual([{ label: "전송 대상", value: "OpenAI" }]);
  expect(first.speech).toContain("3장");
  expect(first.actions.map(a => a.action.type)).not.toContain("capture");
  expect(see).not.toHaveBeenCalled();

  const result = await session.confirm(path === "approve", first.pendingConfirmation?.actionId);
  expect(result.pendingConfirmation).toBeUndefined();
  if (path === "reject") {
    expect(see).not.toHaveBeenCalled();
    expect(result.actions.map(a => a.action.type)).not.toContain("capture");
    return;
  }
  expect(see).toHaveBeenCalledTimes(1);
  expect(result.speech).toBe(answer.answer);
  expect(result.actions.map(a => a.action.type)).toEqual(["capture", "click"]);
  const oriented = requests.find(request => JSON.stringify(request).includes("screenOrientation"));
  expect(JSON.stringify(oriented)).toContain("사진에만 보이는 배너");
});

it("test_screen_orientation_is_not_offered_without_a_vision_model", async () => {
  const { session } = await open();
  scripted(session, [openPortal, inspect, step("click", link), answer]);
  session.deps.visionLlm = undefined;
  const result = await session.handleTurn(goal);
  expect(result.pendingConfirmation).toBeUndefined();
  expect(result.actions.map(a => a.action.type)).not.toContain("capture");
});

const visa = "체류기간 연장은 체류기간 만료 전에 신청합니다.";
const portal = { url: "https://www.hikorea.go.kr/Main.pt", title: "하이코리아" };
const claim = (target: string | null, quote?: string) => ({ action: target === null ? "answer" : "find_portal", target, answer: null,
  claims: quote === undefined ? [] : [{ fact: "procedure", passageId: null, quote }] });

it("test_unknown_agency_is_found_by_search_and_opened_only_from_the_validated_list", async () => {
  const { session, page } = await open();
  await page.route("https://www.hikorea.go.kr/**", route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: `<title>하이코리아</title><main><h1>체류 안내</h1><p>${visa}</p></main>` }));
  const findPortal = vi.fn(async () => [portal, { url: "https://blog.example.com/visa", title: "블로그" }]);
  session.deps.findPortal = findPortal;
  const script = [claim("체류기간 연장 신청"), { ...claim("www.hikorea.go.kr"), action: "open_url" }, claim(null, visa)];
  const requests: string[] = [];
  session.deps.llm = new FakeLlm(({ schemaName, user }) => {
    if (schemaName === "public_service_decision") return { kind: "find_information", source: "browser", agency: null, subject: "체류기간 연장",
      goal: "체류기간 연장 신청 절차 확인", requestedFacts: ["procedure"], exclusions: [], continuation: false, question: null, choices: [],
      searchMode: "visible" };
    if (schemaName !== "public_browse_step") return undefined;
    requests.push(user);
    return script[Math.min(requests.length, script.length) - 1];
  });
  const result = await session.handleTurn("출입국 사이트에서 체류기간 연장 신청 방법을 찾아서 알려줘");
  expect(findPortal).toHaveBeenCalledWith("체류기간 연장 신청", expect.any(AbortSignal));
  expect(requests[1]).toContain("www.hikorea.go.kr");
  expect(requests[1]).not.toContain("blog.example.com");
  expect(result.speech).toContain(visa);
  expect(result.actions.map(a => a.action.type)).toEqual(["navigate"]);
});
