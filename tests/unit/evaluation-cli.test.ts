import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { check, loadRows, sttReport } from "../../scripts/eval-stt.ts";
import { meterBrowseInputs } from "../../scripts/eval-agent.ts";
import { type StructuredLlm } from "../../src/core/llm.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { FakeLlm } from "../helpers.ts";
import { fixed } from "../../scripts/eval-text.ts";

it("reads quoted sentences, matches recorded extensions, and redacts reference and recognized text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cheongeum-eval-"));
  try {
    const csv = join(dir, "sentences.csv");
    await writeFile(
      csv,
      [
        "id,lang,kind,text,read_as,expect",
        's,ko,secret,"비밀번호는 654321, 입력",,secret',
        'm,en,command,"hello, ""browser""",,',
      ].join("\r\n"),
    );
    await writeFile(join(dir, "s.wav"), new Uint8Array());
    const rows = loadRows(dir, csv);
    const first = rows[0]!;
    expect(rows[1]).toMatchObject({ text: 'hello, "browser"', audio: undefined });
    expect(first.audio).toBe(join(dir, "s.wav"));
    const checks = check(first, first.text);
    expect(checks).toMatchObject({ cer: 0, digits: true, secret: true, stop: null });
    const report = sttReport(
      rows,
      [
        {
          provider: "local",
          row: first,
          ms: 250,
          text: first.text,
          error: null,
          checks,
        },
      ],
      dir,
    );
    expect(report.markdown).not.toContain("654321");
    expect(report.markdown).toContain("문장 2개 중 녹음 1개 (없음: m)");
    expect(report.summary.local).toMatchObject({ clips: 1, digitMatch: 1, intentMatch: null, p95Ms: 250 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["separate", "shared", "fallback"] as const)("meters the model that handles browse_step (%s)", async (role) => {
  const base = new FakeLlm({});
  const goal = role === "separate" ? new FakeLlm({}) : base;
  const deps: { llm: StructuredLlm; goalLlm?: StructuredLlm } = {
    llm: base, goalLlm: role === "fallback" ? undefined : goal,
  };
  const average = meterBrowseInputs(deps);
  const request = { schemaName: "browse_step", schema: {}, system: "계획𠮷", user: redactText("질문") };
  await deps.llm.generate({ ...request, schemaName: "chat_route" });
  await deps.goalLlm!.generate(request);
  await deps.goalLlm!.generate({ ...request, system: "계획𠮷🐾씨" });
  expect(average()).toBe(6);
  expect(goal.calls.filter(r => r.schemaName === "browse_step")).toHaveLength(2);
  expect(base.calls.filter(r => r.schemaName === "chat_route")).toHaveLength(1);
});

it("renders exact halfway percentages with round-to-even while retaining inexact binary rounding", () => {
  expect(fixed(12.5, 0)).toBe("12");
  expect(fixed(13.5, 0)).toBe("14");
  expect(fixed(-1.25, 1)).toBe("-1.2");
  expect(fixed(2.675, 2)).toBe("2.67");
});
