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

const catalogue = "자료 목록";
const article = "둘째 자료";
const poster = "연금 안내 그림";
const fact = "방문 상담은 평일에 운영합니다.";
const planningView = z.object({
  goal: z.string(),
  page: z.object({ title: z.string(), mainText: z.string() }).nullable(),
  screenOrientation: z.object({ clickable: z.array(z.string()) }).optional(),
});

async function requestCatalogue(withLinks: boolean, heading = catalogue) {
  const { session, page, adapter } = await open();
  const home = "http://" + PORTAL;
  const directory = new URL("/catalogue", home).href;
  const detail = new URL("/article", home).href;
  const imageMenu = `<canvas id="poster" width="350" height="80" style="position:fixed;right:0;bottom:0"></canvas><script>
    const canvas = document.getElementById("poster");
    const context = canvas.getContext("2d");
    context.font = "24px sans-serif";
    context.fillText("${withLinks ? article + " · " + poster : poster}", 10, 40);
    canvas.onclick = () => location.href = "/article";
  </script>`;
  const controls = withLinks ? `<a href="/unrelated">첫째 자료</a><a href="/article">${article}</a>` : "";
  await page.route(home, route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: `<title>자료실</title><main><a href="/catalogue">${catalogue}</a></main>` }));
  await page.route(directory, route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: `<title>도서관</title><main><h1>${heading}</h1>${imageMenu}${controls}</main>` }));
  await page.route(detail, route => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: `<title>상담 안내</title><main><p>${fact}</p></main>` }));

  const goals: string[] = [];
  session.deps.llm = new FakeLlm(({ schemaName, user }) => {
    if (schemaName !== "browse_step") return undefined;
    const { page: view, screenOrientation, goal: currentGoal } = planningView.parse(JSON.parse(user));
    goals.push(currentGoal);
    if (view?.title === "자료실") return step("click", catalogue);
    if (view?.title === "상담 안내") return step("answer", null, fact, [fact]);
    if (view?.title !== "도서관") return openPortal;
    expect(view.mainText).not.toContain(poster);
    if (screenOrientation?.clickable.includes(article) === true) return step("ask_user", null, "보이는 메뉴를 직접 열어 주시겠어요?");
    return step("fail", null, "글만으로는 안내 자료를 찾을 수 없어요.");
  });
  const see = vi.fn<VisionModel["see"]>(async request => {
    expect(request.schemaName).toBe("screen_orientation");
    const { knownControls } = Menus.parse(JSON.parse(request.user));
    if (withLinks) expect(knownControls).toContain(article);
    return { place: "그림 자료 목록", menus: [withLinks ? article : poster],
      positions: withLinks ? [] : [{ menu: poster, region: "bottom-right" }] };
  });
  session.deps.visionLlm = { see };

  const first = await session.handleTurn(goal);
  expect(page.url()).toBe(directory);
  expect(first.pendingConfirmation?.kind, first.speech).toBe("visual-navigation");
  expect(first.actions.some(a => a.action.type === "capture")).toBe(false);
  expect(see).not.toHaveBeenCalled();
  return { session, page, adapter, see, goals, directory, detail, approve: () => session.confirm(true, first.pendingConfirmation?.actionId) };
}

it("글만 보고 포기한 자료 목록에서 사진으로 구별한 링크를 대신 눌러 답한다", async () => {
  const { approve, see, page, detail } = await requestCatalogue(true);
  const result = await approve();
  expect(see).toHaveBeenCalledTimes(1);
  expect(page.url()).toBe(detail);
  expect(result.actions.map(a => a.action.type)).toEqual(["capture", "click"]);
  expect(result.speech).toContain(fact);
});

it("사진을 허용하는 사이 비밀번호 칸이 나타나면 촬영하지 않는다", async () => {
  const { approve, see, page } = await requestCatalogue(false);
  await page.setContent("<title>로그인</title><main><label>비밀번호<input type=password></label></main>");
  const result = await approve();
  expect(see).not.toHaveBeenCalled();
  expect(result.actions.some(a => a.action.type === "capture")).toBe(false);
});

it.each(["voice", "choice", "other-origin", "new-tab", "stop", "other-task"] as const)("그림으로만 보이는 메뉴를 사용자가 누른 뒤 원래 요청을 이어 간다 (%s)", async after => {
  // 음성 경로는 본문 글과 이름 붙은 항목이 모두 없는 순수 그림 페이지에서도 확인한다.
  const { session, approve, see, page, adapter, directory, detail, goals } = await requestCatalogue(false, after === "voice" ? "" : catalogue);
  const handoff = await approve();
  expect(page.url()).toBe(directory);
  expect(handoff.actions.map(a => a.action.type)).toEqual(["capture"]);
  expect(handoff.speech).toContain(poster);
  expect(handoff.speech).toContain("아래쪽 오른편");
  expect(handoff.offeredChoices?.map(choice => choice.key)).toContain("resume-navigation");
  const previousSteps = goals.length;
  if (after === "other-origin") {
    await page.goto("http://localhost:5174");
  } else if (after === "new-tab") {
    const newTab = page.waitForEvent("popup");
    await page.evaluate(() => { window.open("/article", "_blank"); });
    const tab = await newTab;
    await expect.poll(() => adapter.page === tab).toBe(true);
  } else if (after === "stop") {
    session.cancel();
  } else if (after === "other-task") {
    await session.handleTurn("링크 목록 알려줘");
  } else {
    if (after === "voice") {
      const status = await session.handleTurn("지금 어디까지 했어?", { fromVoice: true });
      expect(status.offeredChoices?.map(choice => choice.key)).toContain("resume-navigation");
      expect(status.actions).toEqual([]);
    }
    await page.locator("canvas").click();
    await page.waitForURL(detail);
  }
  const result = after === "voice" ? await session.handleTurn("계속해 줘", { fromVoice: true }) :
    await session.choose(handoff.turnId, "resume-navigation");
  expect(see).toHaveBeenCalledTimes(1);
  if (after !== "voice" && after !== "choice") {
    expect(goals).toHaveLength(previousSteps);
    expect(result?.actions ?? []).toEqual([]);
    return;
  }
  expect(goals.length).toBeGreaterThan(previousSteps);
  expect(new Set(goals).size).toBe(1);
  expect(result?.actions).toEqual([]);
  expect(result?.speech).toContain(fact);
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
