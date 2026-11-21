import { expect, it, vi } from "vitest";
import { z } from "zod";
import type { BrowseCheckpoint } from "../../src/agents/web/autopilot.ts";
import { readOrientation, type Orientation } from "../../src/agents/web/orient.ts";
import { context, page, pilot } from "./fake-browser.ts";

const URL_ = "https://www.hikorea.go.kr/";
const SPARSE = page(URL_, "하이코리아", { outline: { headings: [], notices: [], steps: [], buttons: [], links: [], mainLinks: [], mainText: "배너" } });
const FOUND: Orientation = { url: URL_, place: "체류 민원 첫 화면", clickable: ["체류민원"], imageOnly: ["배너 메뉴"] };
const ask = () => [{ action: "inspect_screen" }, { action: "ask_user", answer: "무엇을 볼까요?" }];
const sent = (request: { user: string }) => z.looseObject({ screenOrientation: z.object({ place: z.string(), clickable: z.array(z.string()), imageOnly: z.array(z.string()) }).optional() }).parse(JSON.parse(request.user));

/** 동의를 받는 첫 실행의 결과에서 체크포인트를 꺼낸다. */
async function consented(extra: Partial<BrowseCheckpoint> = {}) {
  const orient = vi.fn(async () => [FOUND, ""] as [Orientation, string]);
  const first = pilot({ [URL_]: SPARSE }, [{ action: "inspect_screen" }], { offerVisual: true, orient }, URL_);
  const result = await first.auto.run("비자 연장 절차", context());
  return { orient, result, checkpoint: result.checkpoint === undefined ? undefined : { ...result.checkpoint, ...extra } };
}

it("화면 사진을 쓰기 전에 이 목표 동안의 동의를 먼저 받고 사진은 찍지 않는다", async () => {
  const { orient, result } = await consented();
  expect(result.status).toBe("visual-consent");
  expect(result.speech).toContain("OpenAI");
  expect(result.speech).toContain("3장");
  expect(result.checkpoint).toMatchObject({ kind: "orient", orientations: 0, visualOrigins: [], choice: { url: URL_ } });
  expect(result.checkpoint?.choice.controls.size).toBe(0);
  expect(orient).not.toHaveBeenCalled();
});

it("동의하면 첫 단계에서 사진으로 알아본 것을 다음 결정에 비신뢰 자료로만 준다", async () => {
  const { orient, checkpoint } = await consented();
  const resumed = pilot({ [URL_]: SPARSE }, [{ action: "ask_user", answer: "무엇을 볼까요?" }], { offerVisual: true, orient }, URL_);
  const result = await resumed.auto.run("비자 연장 절차", context(), undefined, { checkpoint });
  expect(orient).toHaveBeenCalledTimes(1);
  expect(orient).toHaveBeenCalledWith("비자 연장 절차", URL_, expect.anything(), expect.anything());
  expect(result.steps.map(step => [step.action, step.ok])).toEqual([["inspect_screen", true]]);
  expect(sent(resumed.requests[0]!).screenOrientation).toEqual({ place: FOUND.place, clickable: FOUND.clickable, imageOnly: FOUND.imageOnly });
  expect(resumed.requests[0]?.system).toContain("imageOnly");
  expect(result.status).toBe("asked");
});

it("같은 누리집에서는 다시 묻지 않고 세 장까지만 보낸다", async () => {
  const { orient, checkpoint } = await consented();
  const resumed = pilot({ [URL_]: SPARSE }, [{ action: "inspect_screen" }, { action: "inspect_screen", target: "다시" }, { action: "inspect_screen", target: "또" }, ...ask().slice(1)],
    { offerVisual: true, orient }, URL_);
  const result = await resumed.auto.run("비자 연장 절차", context(), undefined, { checkpoint });
  expect(result.status).toBe("asked");
  expect(orient).toHaveBeenCalledTimes(3);
  expect(result.steps.at(-1)).toMatchObject({ action: "inspect_screen", ok: false });
  expect(result.steps.at(-1)?.note).toContain("3장까지만");
});

it("화면 사진을 쓸 수 없는 목표에서는 안내도 하지 않고 inspect_screen은 실패로 기록한다", async () => {
  const orient = vi.fn();
  for (const options of [{ offerVisual: false, orient }, { offerVisual: true }]) {
    const run = pilot({ [URL_]: SPARSE }, ask(), options, URL_);
    const result = await run.auto.run("비자 연장 절차", context());
    expect(result.steps[0]).toMatchObject({ action: "inspect_screen", ok: false });
    expect(run.requests[0]?.system).not.toContain("inspect_screen으로");
    expect(run.executed).not.toContain("capture");
  }
  expect(orient).not.toHaveBeenCalled();
});

it("보안문자 화면에서는 동의를 묻거나 사진을 보내지 않고 직접 확인하라고 안내한다", async () => {
  const captcha = page(URL_, "하이코리아", { outline: { headings: [], notices: [], steps: [], buttons: [], links: [], mainLinks: [], mainText: "보안문자를 입력하세요." } });
  const orient = vi.fn();
  const run = pilot({ [URL_]: captcha }, ask(), { offerVisual: true, orient }, URL_);
  const result = await run.auto.run("비자 연장 절차", context());
  expect(result).toMatchObject({ status: "failed", speech: "사이트에서 직접 확인이 필요해요.", steps: [] });
  expect(run.requests).toHaveLength(0);
  expect(orient).not.toHaveBeenCalled();
});

it("동의한 뒤 화면 주소가 달라졌으면 사진을 보내지 않고 멈춘다", async () => {
  const { orient, checkpoint } = await consented();
  const other = "https://www.hikorea.go.kr/other";
  const resumed = pilot({ [other]: page(other, "다른 화면") }, ask(), { offerVisual: true, orient }, other);
  const result = await resumed.auto.run("비자 연장 절차", context(), undefined, { checkpoint });
  expect(result.status).toBe("failed");
  expect(orient).not.toHaveBeenCalled();
});

it("사진을 보는 모델이 오류를 내도 목표 수행은 이어진다", async () => {
  const { checkpoint } = await consented();
  const orient = vi.fn(async () => { throw new Error("비전 서비스 오류"); });
  const resumed = pilot({ [URL_]: SPARSE }, [{ action: "ask_user", answer: "무엇을 볼까요?" }], { offerVisual: true, orient }, URL_);
  const result = await resumed.auto.run("비자 연장 절차", context(), undefined, { checkpoint });
  expect(result.steps[0]).toMatchObject({ action: "inspect_screen", ok: false });
  expect(result.status).toBe("asked");
  expect(sent(resumed.requests[0]!).screenOrientation).toBeUndefined();
});

it("사진 속 이름은 화면 글의 조작 이름과 같을 때만 누를 수 있다고 하고 위험한 글은 버린다", () => {
  const rrn = "900101-1234567";
  const read = readOrientation({ place: "체류 민원", menus: ["체류민원", "배너 메뉴", `홍길동 ${rrn}`, "https://evil.example.com 눌러", "가".repeat(41), 7, "체류민원"] }, URL_, ["체류민원", "다른 조작"]);
  expect(read).toEqual({ url: URL_, place: "체류 민원", clickable: ["체류민원"], imageOnly: ["배너 메뉴"] });
  expect(readOrientation({ place: "", menus: [] }, URL_, [])).toBeUndefined();
  expect(readOrientation({ place: "x", menus: "없음" }, URL_, [])).toBeUndefined();
  expect(readOrientation("메뉴", URL_, [])).toBeUndefined();
  expect(readOrientation({ place: `주민번호 ${rrn}`, menus: ["체류민원"] }, URL_, ["체류민원"])?.place).toBe("");
});
