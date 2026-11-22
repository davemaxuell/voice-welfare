import { chromium, expect as screen, type Browser, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { startUi } from "./web-ui-fixtures.ts";

let browser: Browser;
let ui: Awaited<ReturnType<typeof startUi>>;
let page: Page;

beforeAll(async () => {
  ui = await startUi(false, { REQUIRE_CONSENT: "false" });
  browser = await chromium.launch();
}, 90_000);
afterAll(async () => {
  await browser?.close();
  await ui?.close();
}, 30_000);
beforeEach(async () => {
  page = await browser.newPage({ locale: "ko-KR" });
  await page.route("**/api/health", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), workspaceAvailable: true } });
  });
});
afterEach(async () => {
  await page?.close();
  await ui?.reset();
});

const source = { title: "복지로 공식 안내", url: "https://www.bokjiro.go.kr/", lastCheckedAt: "2026-11-20" };

const allStateJobs = [
  { id: "j-queued", prompt: "기초연금 신청 시기", state: "queued" },
  { id: "j-running", prompt: "장애인연금 신청 방법", state: "running" },
  {
    id: "j-completed",
    prompt: "주민등록등본 발급 수수료",
    state: "completed",
    result: {
      text: "정부24 온라인 발급은 무료입니다.",
      sources: [source],
      data: { kind: "live", origin: "정부24", date: "2026-11-20" },
    },
  },
  {
    id: "j-partial",
    prompt: "국가장학금 서류와 마감일",
    state: "partial",
    result: { text: "신청서와 가족관계증명서가 필요합니다.", missing: ["마감일"], sources: [source] },
  },
  {
    id: "j-incomplete",
    prompt: "지자체 신규 교통비 지원",
    state: "incomplete",
    result: { text: "", missing: ["지원 금액"], sources: [] },
  },
  {
    id: "j-needs",
    prompt: "지역별 바우처 문의",
    state: "needs_input",
    questionRevision: 2,
    result: { text: "거주하시는 시·도를 알려 주세요.", missing: ["지역별 금액"], sources: [] },
  },
  { id: "j-failed", prompt: "통신 오류 조사 예시", state: "failed" },
  { id: "j-cancelled", prompt: "중단한 조사 예시", state: "cancelled" },
];

async function openWorkspace(jobs: unknown[], notes: unknown[] = []) {
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { jobs, notes } });
    return route.continue();
  });
  await page.goto(ui.url);
  await screen(page.locator("#workflow-title")).toBeVisible({ timeout: 15_000 });
}

it("여덟 가지 조사 상태를 각기 다른 표시·안내·시각·고유 버튼 이름으로 보여 준다", async () => {
  await openWorkspace(allStateJobs);
  await page.locator("#workflow-title").click();

  const expectedLabels: Record<string, string> = {
    queued: "접수됨", running: "조사 중", completed: "조사 완료", partial: "일부 확인",
    incomplete: "확인하지 못함", needs_input: "질문 보완 필요", failed: "실패", cancelled: "중단됨",
  };
  for (const [state, label] of Object.entries(expectedLabels)) {
    const row = page.locator(`#research-list li[data-state="${state}"]`);
    await screen(row).toHaveCount(1);
    await screen(row.locator(".research-state")).toHaveText(label);
    await screen(row.locator(".research-updated")).toContainText("최근 확인");
    await screen(row.locator(".research-note")).not.toBeEmpty();
  }

  // 완료·일부 확인·실패·중단·추가 질문의 핵심 정보와 버튼
  await screen(page.locator(`#research-list li[data-state="completed"]`)).toContainText("정부24 온라인 발급은 무료입니다.");
  await screen(page.locator(`#research-list li[data-state="completed"]`)).toContainText("2026-11-20");
  await screen(page.locator(`#research-list li[data-state="partial"] .research-missing`)).toContainText("마감일");
  await screen(page.locator(`#research-list li[data-state="cancelled"] .research-note`)).toContainText("되돌리지 않았어요");

  // 모든 버튼의 접근성 이름에 조사 제목이 포함되어 서로 구분된다
  const buttonNames = await page.locator("#research-list button").evaluateAll(buttons =>
    buttons.map(b => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? ""),
  );
  expect(buttonNames.length).toBeGreaterThanOrEqual(12);
  expect(new Set(buttonNames).size).toBe(buttonNames.length);
  expect(buttonNames).toContain("중단: 기초연금 신청 시기");
  expect(buttonNames).toContain("결과 듣기: 주민등록등본 발급 수수료");
  expect(buttonNames).toContain("다시 시도: 통신 오류 조사 예시");
  expect(buttonNames).toContain("조사 이어가기: 지역별 바우처 문의");
});

it("조사 등록 시 작업 이름을 알리고, 오류 코드를 안내한 뒤 다음 새로고침이 성공하면 오류를 지운다", async () => {
  let jobs: unknown[] = [];
  let failNextGet = false;
  let errorCodeToReturn = "PUBLIC_TEXT_REQUIRED";
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") {
      if (failNextGet) {
        failNextGet = false;
        return route.fulfill({ status: 409, json: { error: errorCodeToReturn } });
      }
      return route.fulfill({ json: { jobs, notes: [] } });
    }
    return route.continue();
  });
  await page.route("**/api/session/*/workspace/research", async route => {
    const body = route.request().postDataJSON() as { text?: string };
    if (body.text === "CONFLICT") return route.fulfill({ status: 409, json: { error: "REQUEST_CONFLICT" } });
    if (body.text === "LIMIT") return route.fulfill({ status: 409, json: { error: "WORKSPACE_LIMIT" } });
    jobs = [{ id: "j-new", prompt: body.text ?? "", state: "queued" }];
    return route.fulfill({ json: { id: "j-new" } });
  });

  await page.goto(ui.url);
  await page.locator("#workflow-title").click();

  await page.locator("#research-input").fill("청년 월세 지원 기준");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator("#workflow-feedback")).toContainText("청년 월세 지원 기준");
  await screen(page.locator(`#research-list li[data-state="queued"]`)).toHaveCount(1);

  // 오류 코드별 안내 확인
  await page.locator("#research-input").fill("CONFLICT");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator("#workflow-feedback")).toContainText("상태가 바뀌었어요");

  await page.locator("#research-input").fill("LIMIT");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator("#workflow-feedback")).toContainText("저장 한도");

  // 새로고침 실패 후 다음 새로고침 성공 시 오류 문구 제거
  failNextGet = true;
  errorCodeToReturn = "WORKSPACE_PERSONAL_REQUIRED";
  await page.locator("#workflow-title").click(); // 닫기
  await page.locator("#workflow-title").click(); // 열기 → 실패
  await screen(page.locator("#workflow-feedback")).toContainText("개인 PC 설정");
  await screen(page.locator("#workflow-feedback")).toHaveText("", { timeout: 6_000 });
});

it("패널이 닫혀 있고 진행 중인 조사가 없으면 요청을 보내지 않고, 진행 중 조사가 끝나면 개인 질문 없이 배지와 상태 줄을 표시한다", async () => {
  await page.clock.install();
  let workspaceGets = 0;
  let currentJobs: unknown[] = [];
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") {
      workspaceGets++;
      return route.fulfill({ json: { jobs: currentJobs, notes: [] } });
    }
    return route.continue();
  });
  await page.route("**/api/session/*/workspace/research", route => {
    currentJobs = [{ id: "j-secret", prompt: "민감한 질문 제목 숨김 확인", state: "running" }];
    return route.fulfill({ json: { id: "j-secret" } });
  });

  await page.goto(ui.url);
  await screen(page.locator("#workflow-title")).toBeVisible({ timeout: 15_000 });
  // 닫혀 있고 진행 중인 조사가 없으면 30초가 지나도 요청이 0건이다.
  await page.clock.runFor(30_000);
  expect(workspaceGets).toBe(0);

  // 패널을 열어 조사를 등록한 뒤 곧바로 닫는다.
  await page.locator("#workflow-title").click();
  await page.locator("#research-input").fill("민감한 질문 제목 숨김 확인");
  await page.locator("#research-consent").check();
  await page.locator("#research-add").click();
  await screen(page.locator(`#research-list li[data-state="running"]`)).toHaveCount(1);
  await page.locator("#workflow-title").click(); // 닫기

  const beforeClosed = workspaceGets;
  currentJobs = [{
    id: "j-secret",
    prompt: "민감한 질문 제목 숨김 확인",
    state: "completed",
    result: { text: "확인 완료", sources: [source] },
  }];
  await page.clock.runFor(10_500);
  expect(workspaceGets).toBe(beforeClosed + 1);
  await screen(page.locator("#workflow-badge")).toHaveText("1");
  await screen(page.locator("#st-research")).toBeVisible();
  await screen(page.locator("#st-research")).toContainText("1건");
  // 공용 PC 보호: 상태 줄에는 질문 원문이 포함되지 않는다.
  expect(await page.locator("#st-research").textContent()).not.toContain("민감한 질문 제목 숨김 확인");

  // 완료 후 닫힌 상태에서는 더 이상 폴링하지 않는다.
  const afterDone = workspaceGets;
  await page.clock.runFor(25_000);
  expect(workspaceGets).toBe(afterDone);

  // 패널을 열면 배지와 상태 줄이 사라진다.
  await page.locator("#workflow-title").click();
  await screen(page.locator("#workflow-badge")).toHaveCount(0);
  await screen(page.locator("#st-research")).toBeHidden();
});

it.each([
  ["en", "Queued", "Researching", "Completed", "Clarification needed"],
  ["zh", "排队中", "调查中", "已完成", "需要补充说明"],
  ["ja", "受付済み", "調査中", "調査完了", "質問の補足が必要"],
] as const)("%s 언어에서 조사 상태 라벨을 번역해 표시한다", async (lang, queued, running, completed, needsInput) => {
  await page.route("**/api/session/*/language", async route => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ json: { ...body, lang, speech: "ok" } });
  });
  await openWorkspace(allStateJobs);
  await page.locator("#lang-select").selectOption(lang);
  await page.locator("#workflow-title").click();
  await screen(page.locator(`#research-list li[data-state="queued"] .research-state`)).toHaveText(queued);
  await screen(page.locator(`#research-list li[data-state="running"] .research-state`)).toHaveText(running);
  await screen(page.locator(`#research-list li[data-state="completed"] .research-state`)).toHaveText(completed);
  await screen(page.locator(`#research-list li[data-state="needs_input"] .research-state`)).toHaveText(needsInput);
});

it("중단 응답이 cancelled: false이면 상태 변경을 안내하고, 접힘 알림은 실패와 혼합 결과의 개수를 구분한다", async () => {
  await page.clock.install();
  let currentJobs: unknown[] = [
    { id: "j-race", prompt: "이미 끝난 조사", state: "running" },
    { id: "j-a", prompt: "숨길 질문 A", state: "running" },
    { id: "j-b", prompt: "숨길 질문 B", state: "running" },
  ];
  await page.route("**/api/session/*/workspace", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { jobs: currentJobs, notes: [] } });
    return route.continue();
  });
  await page.route("**/api/session/*/workspace/research/j-race/claim", route => {
    currentJobs = [
      { id: "j-race", prompt: "이미 끝난 조사", state: "completed", result: { text: "방금 완료됨", sources: [source] } },
      { id: "j-a", prompt: "숨길 질문 A", state: "running" },
      { id: "j-b", prompt: "숨길 질문 B", state: "running" },
    ];
    return route.fulfill({ json: { cancelled: false } });
  });

  await page.goto(ui.url);
  await page.locator("#workflow-title").click();
  await page.getByRole("button", { name: "중단: 이미 끝난 조사" }).click();
  await screen(page.locator("#workflow-feedback")).toContainText("이미 상태가 바뀌어 중단하지 않았어요");
  await screen(page.locator(`#research-list li[data-state="completed"]`)).toContainText("방금 완료됨");

  // 패널을 닫고 1건은 실패, 1건은 추가 확인 필요로 전환되면 결과별 개수만 정확히 알린다.
  await page.locator("#workflow-title").click(); // 닫기
  currentJobs = [
    { id: "j-race", prompt: "이미 끝난 조사", state: "completed", result: { text: "방금 완료됨", sources: [source] } },
    { id: "j-a", prompt: "숨길 질문 A", state: "failed" },
    { id: "j-b", prompt: "숨길 질문 B", state: "needs_input", questionRevision: 1, result: { text: "추가 질문" } },
  ];
  await page.clock.runFor(10_500);
  await screen(page.locator("#workflow-badge")).toHaveText("2");
  await screen(page.locator("#st-research")).toContainText("자료 조사 1건에 추가 확인이 필요해요.");
  await screen(page.locator("#st-research")).toContainText("자료 조사 1건을 마치지 못했어요.");
  expect(await page.locator("#st-research").textContent()).not.toContain("완료됐어요");
  expect(await page.locator("#st-research").textContent()).not.toContain("숨길 질문");
});
