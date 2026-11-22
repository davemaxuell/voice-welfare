import { expect, it } from "vitest";
import { Autopilot } from "../../src/agents/web/autopilot.ts";
import { ExecContext } from "../../src/agents/web/agent.ts";
import { FakeLlm } from "../helpers.ts";
import { browserCases } from "./browser-cases.ts";

const open = browserCases();
const searchPage = "https://archive.go.kr/";
const context = () => new ExecContext({signal: new AbortController().signal, isStopped: () => false, trace() {}, publicLookup: true});

it.each(["https://www.bokjiro.go.kr", "www.bokjiro.go.kr"])("직접 받은 주소 %s는 두 턴의 모델·음성 기록·메모 조회에서 보호한다", async origin => {
  const {session, page} = await open();
  const token = "/a/private-row?key=content#member";
  const address = origin + token;
  const destination = "https://www.bokjiro.go.kr" + token;
  const safeOrigin = new URL(destination).origin;
  const quote = "신청 안내는 시민자료관에서 열람합니다.";
  await page.route(safeOrigin + "/**", route => route.fulfill({contentType: "text/html; charset=utf-8",
    body: `<title>시민자료관</title><main><p>${quote}</p></main>`}));
  const queries: string[] = [];
  session.deps.recallNotes = async query => { queries.push(query); return [`저장한 주소 ${address}`]; };
  let first = true;
  const model = new FakeLlm(({schemaName, user}) => {
    if (schemaName === "public_browse_step") return {action: "answer", claims: JSON.parse(user).missingFacts.includes("page_title") === true ?
      [{fact: "page_title", quote: "시민자료관"}] : [{fact: "procedure", passageId: 1, quote}]};
    if (schemaName !== "public_service_decision") return undefined;
    if (!first) return {kind: "find_information", source: "browser", goal: "현재 열린 화면 자체의 제목 확인", searchMode: "visible",
      continuation: false, choices: [], exclusions: [], requestedFacts: ["page_title"]};
    first = false;
    return {kind: "find_information", source: "browser", agency: "복지로", subject: "신청 안내", goal: "신청 안내를 열람할 곳 확인", requestedFacts: ["procedure"],
      exclusions: [], continuation: false, choices: [], searchMode: "visible"};
  });
  session.deps.llm = model;
  const firstResult = await session.handleTurn(`기관 안내가 있는 ${address} 에서 어디로 가야 하나요?`);
  expect(firstResult.speech).toContain("시민자료관");
  const second = await session.handleTurn("지금 보고 있는 페이지의 제목도 읽어 주시겠어요?");
  expect(second.speech).toContain("시민자료관");
  const intake = model.calls.filter(call => call.schemaName === "public_service_decision");
  expect(intake).toHaveLength(2);
  expect(JSON.parse(intake[1]!.user).recent).toEqual(expect.arrayContaining([expect.objectContaining({request: expect.stringContaining(safeOrigin)})]));
  expect(session.recentVoiceDialogue()[0]?.text).toContain(safeOrigin);
  expect(queries).toHaveLength(2);
  for (const projected of [queries, session.recentVoiceDialogue(), session.recentDialogue(), model.calls.map(call => call.user)]) {
    expect(JSON.stringify(projected)).not.toMatch(/private-row|key=content|#member/u);
  }
  expect(page.url()).toBe(destination);
});

it("페이지 자체의 제목은 공지 헤딩이나 본문 문장과 별도로 확인된다", async () => {
  const {session, page} = await open();
  const title = "숲문화 자료원", notice = "겨울 운영 시간 변경 안내";
  await page.route(searchPage, route => route.fulfill({contentType: "text/html; charset=utf-8",
    body: `<title>${title}</title><main><h1>${notice}</h1><p>상세 공지는 여기에서 확인합니다.</p></main>`}));
  await page.goto(searchPage);
  let calls = 0;
  const model = new FakeLlm(() => ({action: "answer", claims: [
    {fact: "page_title", passageId: null, quote: ++calls === 1 ? notice : title},
  ]}));
  const result = await new Autopilot(session.web, model, {searchUrl: () => searchPage}).run("방금 연 웹페이지 자체의 제목이 뭐예요?", context(), undefined,
    {siteUrl: searchPage, requestedFacts: ["page_title"]});
  expect(result.status).toBe("answered");
  expect(result.speech).toContain(title);
  expect(result.speech).not.toContain(notice);
  expect(result.reviewQuotes).toEqual([title]);
  expect(calls).toBe(2);
});

it("기관 이름이 없어도 제공된 페이지를 먼저 확인하고 모델이 되읽은 출처를 실제 주소로 연결한다", async () => {
  const {session, page} = await open();
  const destination = "https://archive.go.kr/circulation/season?edition=private";
  const quote = "배송 예정일은 사흘 뒤입니다.";
  await page.route("https://archive.go.kr/**", route => route.fulfill({contentType: "text/html; charset=utf-8",
    body: route.request().url() === destination ? `<title>분관 순회 안내</title><main>${quote}</main>` : "<title>첫 화면</title><main>기관 소개</main>"}));
  const model = new FakeLlm(({schemaName, user}) => {
    const input = JSON.parse(user);
    if (schemaName === "public_service_decision") return input.suppliedPage?.origin === "https://archive.go.kr" ?
      {kind: "existing", choices: [], exclusions: [], continuation: false, requestedFacts: []} :
      {kind: "clarify", question: "어떤 서비스예요?", choices: [], exclusions: [], continuation: false, requestedFacts: []};
    if (schemaName === "intent_plan") return {steps: [{type: "GOAL", site: "archive.go.kr", topic: "분관의 배송 예정일을 읽어 줘"}]};
    if (schemaName === "browse_step") return input.page?.title === "분관 순회 안내" ?
      {action: "answer", answer: quote, evidence: [quote]} : {action: "open_url", target: "https://archive.go.kr"};
    return undefined;
  });
  session.deps.llm = model;
  const result = await session.handleTurn(`${destination}에서 분관의 배송 예정일을 읽어 줘`);
  expect(page.url()).toBe(destination);
  expect(result.speech).toContain("사흘");
  expect(JSON.stringify(model.calls.map(call => call.user))).not.toMatch(/circulation|edition=private/u);
});

it("다른 기관과 여러 번 대화한 뒤에도 처음 필요했던 조건을 모델에 전달하고 수정한다", async () => {
  const {session} = await open();
  const memory = {reset: false, changes: [{aspect: "region", quote: "춘천"}, {aspect: "age", quote: "68세"},
    {aspect: "benefit", quote: "생활 이동 지원"}, {aspect: "situation", quote: "지어낸 주소"}]};
  let update: unknown = memory;
  const model = new FakeLlm(({schemaName}) => schemaName === "public_service_decision" ? {kind: "conversation", reply: "말씀하신 조건을 살펴볼게요.",
    continuation: false, exclusions: [], choices: [], requestedFacts: [], needUpdate: update} : undefined);
  session.deps.llm = model;
  await session.handleTurn("춘천에 사는 68세예요. 생활 이동 지원을 찾고 싶어요.");
  update = null;
  for (let i = 0; i < 5; i++) await session.handleTurn("이번에는 다른 기관의 안내도 들려주세요.");
  update = {reset: false, changes: [{aspect: "region", quote: "원주"}]};
  await session.handleTurn("아까 춘천이라고 했는데 원주였어요.");
  update = null;
  await session.handleTurn("그거 신청하려면 뭐가 더 필요한가요?");
  const last = model.calls.filter(call => call.schemaName === "public_service_decision").at(-1);
  expect(JSON.parse(last?.user ?? "{}").need).toEqual({region: "원주", age: "68세", benefit: "생활 이동 지원"});
  session.redactEarlierMentions(["원주"]);
  await session.handleTurn("다른 건 없을까요?");
  expect(JSON.parse(model.calls.at(-1)!.user).need.region).toBeUndefined();
});

it("현재 공식 사이트에 검색칸이 있으면 내부 검색 조건을 보내지 않고 그 칸을 쓴다", async () => {
  const {session, page} = await open();
  await page.route("https://archive.go.kr/**", route => route.fulfill({contentType: "text/html; charset=utf-8", body:
    '<title>새 기관 자료실</title><form action="/results"><input type="search" aria-label="통합 검색" name="q"></form><main>행사 자료</main>'}));
  await page.goto(searchPage);
  let calls = 0;
  const route = {targetPage: "시민 교육 안내", keywords: ["시민", "교육"], fallback: "find_links"};
  const model = new FakeLlm(() => ++calls === 1 ? {action: "search", target: "site:archive.go.kr 시민 교육", route} :
    {action: "ask_user", answer: "자료의 제작 시기를 알려 주시겠어요?"});
  const external: string[] = [];
  const pilot = new Autopilot(session.web, model, {searchUrl: q => { external.push(q); return searchPage + "?wrong=1"; }});
  const result = await pilot.run("새로 생긴 자료에서 교육 행사를 찾아 줘", context());
  expect(external).toEqual([]);
  expect(new URL(page.url()).searchParams.get("q")).toBe("시민 교육");
  expect(JSON.stringify(result.actions)).not.toContain("site:");
  expect(JSON.stringify(result.steps)).not.toContain("site:");
});

it("맞춤 복지 문진이 모델이 이미 확인한 나이와 생활 조건을 다시 묻지 않는다", async () => {
  const {session} = await open();
  let first = true;
  session.deps.llm = new FakeLlm(({schemaName}) => {
    if (schemaName !== "public_service_decision") return undefined;
    const needUpdate = first ? {reset: false, changes: [
      {aspect: "age", quote: "예순여덟", profile: {age: 68}},
      {aspect: "situation", quote: "장애는 없어요", profile: {disability: "no"}},
    ]} : null;
    const kind = first ? "conversation" : "existing";
    first = false;
    return {kind, reply: kind === "conversation" ? "말씀하신 조건을 기억할게요." : null,
      continuation: false, choices: [], exclusions: [], requestedFacts: [], needUpdate};
  });
  await session.handleTurn("저는 예순여덟이고 장애는 없어요.");
  const response = await session.handleTurn("나한테 맞는 복지 찾아줘");
  expect(response.speech).toContain("차상위");
  expect(response.speech).not.toContain("나이가");
});

it("효과 없는 같은 클릭을 되풀이하지 않고 계획한 검색으로 회복한다", async () => {
  const {session, page} = await open();
  await page.route("https://archive.go.kr/**", route => route.fulfill({contentType: "text/html; charset=utf-8", body:
    '<title>배움터</title><form action="/results"><input type="search" aria-label="통합 검색" name="q"></form><main><a href="#" onclick="event.preventDefault();window.taps=(window.taps||0)+1">수업 안내</a></main>'}));
  await page.goto(searchPage);
  const route = {targetPage: "공예 수업 안내", keywords: ["공예"], fallback: "search"};
  let calls = 0;
  const model = new FakeLlm(() => ++calls <= 2 ? {action: "click", target: "수업 안내", route} : {action: "ask_user", answer: "어느 수업을 원하세요?"});
  const result = await new Autopilot(session.web, model, {searchUrl: () => searchPage}).run("공예 교육 자료를 보고 싶어요", context(), undefined, {siteUrl: searchPage});
  expect(result.actions.filter(entry => entry.action.type === "click")).toHaveLength(1);
  expect(new URL(page.url()).searchParams.get("q")).toBe("공예");
  expect(JSON.parse(model.calls[1]!.user).navigation).toMatchObject({targetPage: "공예 수업 안내", lastHelped: false});
});

it("탐색 예산을 모두 쓰면 확인한 화면과 구체적인 다음 행동을 알려준다", async () => {
  const {session, page} = await open();
  await page.route(searchPage, route => route.fulfill({contentType: "text/html; charset=utf-8", body:
    '<title>새 시민 자료실</title><main>고시 자료가 있습니다.</main>'}));
  await page.goto(searchPage);
  const model = new FakeLlm(() => ({action: "find", target: "없는 말", route: {targetPage: "강좌 안내", keywords: ["공예"], fallback: "find_links"}}));
  const result = await new Autopilot(session.web, model, {maxSteps: 1, searchUrl: () => searchPage})
    .run("공예 강좌 내용을 알려 주세요", context());
  expect(result.status).toBe("limit");
  expect(result.speech).toContain("새 시민 자료실");
  expect(result.speech).toContain("링크");
  expect(result.speech).not.toContain("정해진 단계");
});

it.each([
  ["https://archive.go.kr/community/notice", "https://archive.go.kr/community/notice"],
  ["127.0.0.1:5174/external.html", "http://127.0.0.1:5174/external.html"],
])("다른 기관을 추천한 모델보다 주민이 요청한 출처 %s에서 확인한다", async (address, destination) => {
  const {session, page} = await open();
  const quoted = "이번 특별 지원 안내는 시민자료관에서 열람합니다.";
  await page.route(destination, route => route.fulfill({contentType: "text/html; charset=utf-8",
    body: `<title>함께 보는 자료실</title><main><p>${quoted}</p></main>`}));
  await page.route("https://*.bokjiro.go.kr/**", route => route.fulfill({contentType: "text/html; charset=utf-8", body: "<title>다른 기관</title>"}));
  session.deps.llm = new FakeLlm(({schemaName}) => {
    if (schemaName === "public_service_decision") return {kind: "find_information", source: "welfare", agency: "복지로", subject: "기초연금",
      goal: "기초연금 안내를 어디에서 열람하는지 확인", requestedFacts: ["procedure"], exclusions: [], continuation: false, choices: [], searchMode: "visible"};
    if (schemaName === "public_browse_step") return {action: "answer", claims: [{fact: "procedure", passageId: 1, quote: quoted}]};
    return undefined;
  });
  const result = await session.handleTurn(`${address}에서 기초연금 안내를 어디서 열람하나요?`);
  expect(page.url()).toBe(destination);
  expect(result.speech).toContain("시민자료관");
  expect(result.sources?.map(source => source.url)).toContain(destination);
});
