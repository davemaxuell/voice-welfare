import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { implementations, loadOracle, oracleImplementation, replayCase } from "./oracle.ts";

const fixtures = fileURLToPath(new URL("../fixtures/oracle/", import.meta.url));
const groups = loadOracle(fixtures);
const manifest = z.object({ modules: z.record(z.string(), z.object({ python: z.array(z.string()) })) })
  .parse(JSON.parse(readFileSync(new URL("../../port-manifest.json", import.meta.url), "utf8")));
const ported = new Set(Object.values(manifest.modules).flatMap(entry => entry.python));
const pending = [];

for (const [name, { module, cases }] of groups) {
  const implementation = oracleImplementation(name, module, ported);
  if (implementation === undefined) {
    pending.push(name);
    it.skip(`missing TS implementation: ${name} (${cases.length})`);
  } else {
    it(name, async () => {
      for (const row of cases) await replayCase(row, implementation);
    });
  }
}
if (pending.length > 0) process.stdout.write(`missing TS implementations (oracle):\n${pending.join("\n")}\n`);

it("requires an adapter for each ported source file and package", () => {
  for (const path of ["src/cheongeum/control.py", "src/cheongeum/control/__init__.py"]) {
    expect(() => oracleImplementation("control.echo", "control", new Set([path]))).toThrow(/missing TS oracle/u);
  }
  for (const name of implementations.keys()) expect(groups.has(name), name).toBe(true);
});

it("rejects an altered oracle result", async () => {
  const row = { fn: "control", args: { text: "청음" }, result: "청음" };
  const echo = (args: Record<string, unknown>) => args.text;
  await replayCase(row, echo);
  await expect(replayCase({ ...row, result: "다른 말" }, echo)).rejects.toThrow();
});

it("reports a missing oracle fixture even when its function is pending", () => {
  const directory = mkdtempSync(join(tmpdir(), "cheongeum-oracle-"));
  try {
    writeFileSync(join(directory, "inventory.json"), JSON.stringify({ control: ["control.echo"] }));
    expect(() => loadOracle(directory)).toThrow(/missing oracle fixture.*control\.jsonl/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
