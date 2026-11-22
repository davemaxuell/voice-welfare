import { expect, it, vi } from "vitest";
import { context, page, pilot } from "./fake-browser.ts";

const url = "https://www.gov.kr/";
const quote = "신청서와 신분증을 준비하세요.";
const office = page(url, "공공서비스 안내");
office.outline = { ...office.outline!, mainText: quote,
  items: ["이용 안내", "공지사항"].map((name, i) => ({ name, ref: String(i), role: "link", region: "main", disabled: false })) };
const routeQuestion = { action: "ask_user", target: "navigation", answer: "이용 안내와 공지사항 중에서 어디를 확인할까요?", claims: [] };

it("continues an ordinary foreground lookup when the browser proposes asking what to do next", async () => {
  const { auto } = pilot({ [url]: office }, [
    { action: "ask_user", answer: "어떤 메뉴를 먼저 확인할까요?" },
    { action: "answer", answer: quote, evidence: [quote] },
  ], {}, url);
  const result = await auto.run("준비할 것을 확인해 줘", context());
  expect(result).toMatchObject({ status: "answered", speech: quote });
});

it("chooses how to investigate a public question and returns the verified source", async () => {
  const orient = vi.fn(async () => { throw new Error("Public page text is sufficient"); });
  const { auto } = pilot({ [url]: office }, [routeQuestion, {
    action: "answer", claims: [{ fact: "documents", quote }],
  }], { offerVisual: true, orient }, url);
  const result = await auto.run("필요한 서류를 찾아줘", context(), undefined, { requestedFacts: ["documents"] });
  expect(result).toMatchObject({ status: "answered", speech: quote, sources: [{ url }] });
  expect(orient).not.toHaveBeenCalled();
});

it("continues comparing two offices even when the first source already has the requested fact type", async () => {
  const first = "동부 창구는 월요일 오전에 접수합니다.";
  const second = "서부 창구는 수요일 오후에 접수합니다.";
  const west = "https://www.gov.kr/west";
  const { auto, opened } = pilot({
    [url]: { ...office, outline: { ...office.outline!, mainText: first } },
    [west]: page(west, "서부 창구", { outline: { ...office.outline!, mainText: second } }),
  }, [
    { action: "open_url", target: west, claims: [{ fact: "dates", quote: first }] },
    { action: "answer", claims: [{ fact: "dates", quote: second }] },
  ], {}, url);
  const result = await auto.run("동부와 서부 창구 접수일을 비교해줘", context(), undefined,
    { requestedFacts: ["dates"], allowedUrls: [west] });
  expect(result).toMatchObject({ status: "answered", sources: [{ url }, { url: west }], reviewQuotes: [first, second] });
  expect(opened).toEqual([west]);
});

it("states when only part of a same-fact comparison could be verified", async () => {
  const { auto } = pilot({ [url]: office }, [
    { action: "find", target: "서부 창구", claims: [{ fact: "documents", quote }] },
    { action: "fail", claims: [] },
  ], {}, url);
  const result = await auto.run("동부와 서부 창구 서류를 비교해줘", context(), undefined, { requestedFacts: ["documents"] });
  expect(result).toMatchObject({ status: "partial", sources: [{ url }], reviewQuotes: [quote] });
  expect(result.speech).toContain(quote);
  expect(result.speech).toContain("일부");
});

it("keeps a verified partial answer when the browser exhausts its routes", async () => {
  const { auto } = pilot({ [url]: office }, [{
    ...routeQuestion, claims: [{ fact: "documents", quote }],
  }, routeQuestion], { maxSteps: 2 }, url);
  const result = await auto.run("신청 서류와 마감일을 찾아줘", context(), undefined, { requestedFacts: ["documents", "dates"] });
  expect(result).toMatchObject({ status: "partial", sources: [{ url }], reviewQuotes: [quote] });
  expect(result.speech).toContain("기간");
  expect(result.speech).not.toContain(routeQuestion.answer);
});

it("asks the user a material question without choosing a personal circumstance", async () => {
  const question = "지역마다 접수일이 달라요. 어느 지역의 날짜를 확인할까요?";
  const { auto, executed } = pilot({ [url]: office }, [{ action: "ask_user", target: "user_choice", answer: question }], {}, url);
  const result = await auto.run("우리 지역 마감일을 알려줘", context(), undefined, { requestedFacts: ["dates"] });
  expect(result).toMatchObject({ status: "asked", speech: question });
  expect(executed).toEqual([]);
});

it("does not ask the user to choose screen menus to recover a failed browser decision", async () => {
  const { auto, executed } = pilot({ [url]: office }, [], {}, url);
  const result = await auto.run("신청 서류를 찾아줘", context());
  expect(result.status).toBe("failed");
  expect(result.speech).not.toMatch(/이용 안내|공지사항|메뉴 이름을 말씀/u);
  expect(executed).toEqual([]);
});
