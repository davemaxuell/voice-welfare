import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { practiceSite } from "../../src/core/assets.ts";
import { WebObservationSchema, type WebObservation } from "../../src/agents/web/view.ts";
import { Churn, diffViews } from "../../src/agents/web/effect.ts";
import { digestPage } from "../../src/agents/web/digest.ts";
import { authPageKind } from "../../src/agents/web/auth_page.ts";
import { webPolicyImplementations } from "./web-policy-oracle.ts";

const directory = new URL("../fixtures/observations/", import.meta.url);
const views = new Map<string, WebObservation>();
const viewRow = z.object({
  id: z.string(), view: WebObservationSchema, digest: z.json(), auth: z.enum(["login","verification","other"]),
});
const recorded = readFileSync(new URL("views.jsonl", directory), "utf8").trimEnd().split("\n").map(line => viewRow.parse(JSON.parse(line)));
for (const row of recorded) views.set(row.id, row.view);

const cases = z.object({
  pages: z.record(z.string(), z.string()),
  idle: z.array(z.object({ origin: z.string(), view: z.string(), volatile: z.record(z.string(), z.number()) })),
  clicks: z.array(z.object({
    before: z.string(), after: z.string(), tests: z.array(z.string()).nonempty(),
    action: z.object({ type: z.literal("click"), target: z.object({ref: z.string().optional()}).passthrough() }),
    effect: z.tuple([z.string(), z.string()]), fingerprint: z.json(),
  })),
});
// 기준은 recorder가 저장한 원본 Python 결과다.
function view(id: string) {
  const found = views.get(id);
  if (found === undefined) throw new Error("기록된 관찰이 없습니다: "+id);
  return found;
}

const interactions = cases.parse(JSON.parse(readFileSync(new URL("interactions.json", directory), "utf8")));
const origins = ["http://localhost:5174", "http://127.0.0.1:5174"];

it("두 모의 출처의 모든 페이지를 실제 브라우저에서 기록했다", () => {
  const pages = readdirSync(practiceSite).filter(name => name.endsWith(".html"));
  expect(new Set(Object.keys(interactions.pages))).toEqual(new Set(origins.flatMap(origin => pages.map(name => origin+"/"+name))));
  for (const [url, id] of Object.entries(interactions.pages)) expect(view(id).url).toBe(url);
  expect(views.size).toBe(recorded.length);
});
it("실제 화면마다 본문·입력 칸·링크와 인증 화면 종류가 Python 관찰과 일치한다", () => {
  for (const row of recorded) {
    expect(digestPage(row.view), row.id).toEqual(row.digest);
    expect(authPageKind(row.view), row.id).toBe(row.auth);
  }
});
it("클릭 직전·직후의 변화와 승인 지문이 Python과 일치한다", async () => {
  const fingerprint = webPolicyImplementations.get("agents.web.approval.fingerprint");
  if (fingerprint === undefined) throw new Error("승인 지문이 등록되지 않았습니다.");
  const compared = new Set<string>();
  for (const row of interactions.clicks) {
    const before = view(row.before), after = view(row.after);
    compared.add(new URL(before.url ?? "").origin);
    expect(diffViews(before, after, row.action.target.ref), row.tests.join(", ")).toEqual(row.effect);
    expect(await fingerprint({view: before, actions: [row.action], speech: "이 항목을 누를까요?", field_ids: null})).toEqual(row.fingerprint);
  }
  expect(compared).toEqual(new Set(origins));
});
it("누르지 않아도 바뀌는 배너는 출처별로 학습한다", () => {
  for (const origin of origins) {
    const churn = new Churn();
    let previous: WebObservation | undefined;
    const rows = interactions.idle.filter(row => row.origin === origin);
    for (const row of rows) {
      const now = view(row.view);
      churn.observe(now, previous);
      expect(churn.volatile()).toEqual(row.volatile);
      previous = now;
    }
    expect(rows.length).toBeGreaterThan(2);
    expect(Object.keys(churn.volatile()).length).toBeGreaterThan(0);
  }
});
