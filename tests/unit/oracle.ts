import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deepStrictEqual } from "node:assert/strict";
import { z } from "zod";
import { plannerImplementations } from "./planner-oracle.ts";
import { ruleImplementations } from "./understanding-rules-oracle.ts";

const rowSchema = z.object({
  fn: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  result: z.json(),
}).strict();
type OracleCase = z.infer<typeof rowSchema> & { location?: string };
type OracleGroup = { module: string; cases: OracleCase[] };
type Implementation = (args: OracleCase["args"]) => unknown;

// 각 이식 PR에서 Python 호출 이름과 TypeScript 함수를 연결한다.
export const implementations = new Map<string, Implementation>([...ruleImplementations, ...plannerImplementations]);

function readFixture(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`missing oracle fixture: ${path}`, { cause: error });
    }
    throw error;
  }
}

export function loadOracle(directory: string): Map<string, OracleGroup> {
  const moduleName = z.string().regex(/^[a-z_]\w*(?:\.[a-z_]\w*)*$/u);
  const inventory = z.record(moduleName, z.array(z.string().min(1)).min(1)).parse(
    JSON.parse(readFixture(join(directory, "inventory.json"))),
  );
  for (const file of readdirSync(directory)) {
    if (file.endsWith(".jsonl") && !Object.hasOwn(inventory, file.slice(0, -6))) {
      throw new Error(`unexpected oracle fixture: ${file}`);
    }
  }
  const grouped = new Map<string, OracleGroup>();
  for (const [module, names] of Object.entries(inventory)) {
    const path = join(directory, `${module}.jsonl`);
    for (const name of names) {
      if (grouped.has(name)) throw new Error(`duplicate oracle target: ${name}`);
      grouped.set(name, { module, cases: [] });
    }
    const lines = readFixture(path).trimEnd();
    if (lines.length === 0) throw new Error(`missing oracle cases: ${path}`);
    for (const [index, line] of lines.split(/\r?\n/u).entries()) {
      const location = `${path}:${index + 1}`;
      let row;
      try {
        row = rowSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`invalid oracle case at ${location}`, { cause: error });
      }
      const group = grouped.get(row.fn);
      if (group === undefined || group.module !== module) {
        throw new Error(`unexpected oracle function in ${path}: ${row.fn}`);
      }
      group.cases.push({ ...row, location });
    }
    for (const name of names) {
      if (grouped.get(name)?.cases.length === 0) throw new Error(`missing oracle cases: ${name}`);
    }
  }
  if (grouped.size === 0) throw new Error("missing oracle targets");
  return grouped;
}

export function oracleImplementation(name: string, module: string, ported: ReadonlySet<string>): Implementation | undefined {
  const path = "src/cheongeum/" + module.replaceAll(".", "/");
  const implementation = implementations.get(name);
  if (implementation === undefined && (ported.has(path + ".py") || ported.has(path + "/__init__.py"))) {
    throw new Error(`missing TS oracle implementation for ported module: ${name}`);
  }
  return implementation;
}

export async function replayCase(row: OracleCase, invoke: Implementation): Promise<void> {
  deepStrictEqual(await invoke(row.args), row.result, row.location ?? row.fn);
}
