import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../src/core/assets.ts";
import { modules } from "./port-manifest.ts";

export type ChangeKind = "added" | "modified" | "deleted";
export type Area = "code" | "web" | "desktop" | "test" | "fixture" | "script" | "data" | "asset" | "vendor" | "doc" | "audit" | "ci" | "config" | "other";
export type Handling = "port" | "copy" | "skip" | "review";
export type Status = "drift" | "new" | "unmapped" | "retired" | "none";
export type Manifest = Readonly<Record<string, { readonly python: readonly string[] }>>;

export interface Change { readonly kind: ChangeKind; readonly path: string; readonly added: number; readonly removed: number }
export interface LedgerRow extends Change {
  readonly area: Area;
  readonly handling: Handling;
  readonly status: Status;
  readonly tsModules: readonly string[];
}
export interface RouteDiff { readonly shared: readonly string[]; readonly pythonOnly: readonly string[]; readonly tsOnly: readonly string[] }

const AREA_RULES: readonly (readonly [Exclude<Area, "other">, RegExp])[] = [
  ["audit", /^(?:\.audit|scripts\/migration|reports\/migration)\//u],
  ["ci", /^\.github\//u],
  ["script", /^(?:welfare_catalog_checkpoint_[^/]+|scripts\/welfare-catalog)\/tools\//u],
  ["data", /^(?:welfare_catalog_checkpoint_[^/]+|scripts\/welfare-catalog)\//u],
  ["fixture", /^tests\/fixtures\//u],
  ["config", /(?:^|\/)package-lock\.json$/u],
  ["test", /^(?:tests|apps\/desktop\/test)\//u],
  ["desktop", /^apps\/desktop\//u],
  ["script", /^scripts\//u],
  ["doc", /^(?:docs|drafts|research_notes)\/|^(?:README|CLAUDE)\.md$/u],
  ["vendor", /\/vendor\//u],
  ["asset", /^graphics\/|\.(?:png|jpe?g|webp|webm|glb|wav|mp3|ico|icns|woff2?)$/iu],
  ["data", /^src\/cheongeum\/(?:.*\/)?data\/(?!.*\.py$)|^src\/cheongeum\/.*\.(?:json|xml|csv|jsonl)$/u],
  ["config", /^(?:pyproject\.toml|uv\.lock|\.gitignore|\.gitattributes)$/u],
  ["web", /^src\/cheongeum\/web\//u],
  ["code", /^src\/cheongeum\//u],
];

const HANDLING = {
  code: "port", web: "port", desktop: "port", test: "port", script: "port",
  fixture: "copy", data: "copy", asset: "copy",
  audit: "skip",
  vendor: "review", doc: "review", ci: "review", config: "review", other: "review",
} as const satisfies Readonly<Record<Area, Handling>>;

const KIND_OF_STATUS: Readonly<Record<string, ChangeKind>> = { A: "added", M: "modified", D: "deleted" };

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function classify(path: string): Area {
  return AREA_RULES.find(([, pattern]) => pattern.test(path))?.[0] ?? "other";
}

export function statusOf(kind: ChangeKind, handling: Handling, mapped: boolean): Status {
  if (handling !== "port") return "none";
  switch (kind) {
    case "added": return mapped ? "drift" : "new";
    case "modified": return mapped ? "drift" : "unmapped";
    case "deleted": return mapped ? "retired" : "none";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** Reads `git diff --name-status -z --no-renames` and `git diff --numstat -z --no-renames` for the same range. */
export function parseChanges(nameStatusZ: string, numstatZ: string): Change[] {
  const counts = new Map<string, { added: number; removed: number }>();
  for (const record of numstatZ.split("\0")) {
    if (record === "") continue;
    const groups = /^(?<added>\d+|-)\t(?<removed>\d+|-)\t(?<path>.+)$/su.exec(record)?.groups;
    const added = groups?.["added"];
    const removed = groups?.["removed"];
    const path = groups?.["path"];
    if (added === undefined || removed === undefined || path === undefined) throw new Error(`unreadable numstat record ${JSON.stringify(record)}`);
    counts.set(path, { added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed) });
  }
  const fields = nameStatusZ.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length - 1; i += 2) {
    const status = fields[i];
    const path = fields[i + 1];
    if (status === undefined || path === undefined) break;
    const kind = KIND_OF_STATUS[status];
    if (kind === undefined) throw new Error(`unexpected git status ${JSON.stringify(status)} for ${path}; rename detection must be off`);
    const lines = counts.get(path);
    if (lines === undefined) throw new Error(`git listed ${path} without line counts`);
    changes.push({ kind, path, ...lines });
  }
  return changes;
}

export function buildLedger(changes: readonly Change[], manifest: Manifest): LedgerRow[] {
  const portedBy = new Map<string, string[]>();
  for (const [tsModule, { python }] of Object.entries(manifest)) {
    for (const path of python) portedBy.set(path, [...(portedBy.get(path) ?? []), tsModule]);
  }
  return changes
    .map((change): LedgerRow => {
      const area = classify(change.path);
      const handling = HANDLING[area];
      const tsModules = portedBy.get(change.path) ?? [];
      return { ...change, area, handling, tsModules, status: statusOf(change.kind, handling, tsModules.length > 0) };
    })
    .sort((a, b) => byKey(`${a.area}\0${a.path}`, `${b.area}\0${b.path}`));
}

export function toTsv(rows: readonly LedgerRow[]): string {
  const header = ["path", "change", "area", "handling", "status", "added", "removed", "ts_modules"].join("\t");
  const lines = rows.map(row => {
    if (/[\t\n\r]/u.test(row.path)) throw new Error(`path with a control character ${JSON.stringify(row.path)}`);
    return [row.path, row.kind, row.area, row.handling, row.status, String(row.added), String(row.removed), row.tsModules.join(",")].join("\t");
  });
  return `${[header, ...lines].join("\n")}\n`;
}

export function totals(rows: readonly LedgerRow[]) {
  return rows.reduce((sum, row) => ({ files: sum.files + 1, added: sum.added + row.added, removed: sum.removed + row.removed }), { files: 0, added: 0, removed: 0 });
}

export function formatSummary(rows: readonly LedgerRow[]): string {
  const groups = new Map<string, { files: number; added: number; removed: number }>();
  for (const row of rows) {
    const key = `${row.area}  ${row.handling}  ${row.status}`;
    const group = groups.get(key) ?? { files: 0, added: 0, removed: 0 };
    groups.set(key, { files: group.files + 1, added: group.added + row.added, removed: group.removed + row.removed });
  }
  return [...groups.entries()]
    .sort(([a], [b]) => byKey(a, b))
    .map(([key, g]) => `${key.padEnd(30)} ${String(g.files).padStart(5)} files ${String(g.added).padStart(8)} added ${String(g.removed).padStart(7)} removed`)
    .join("\n");
}

const PYTHON_ROUTE = /@(?:app|router|api)\.(?<method>get|post|put|patch|delete|websocket)\(\s*["'](?<path>[^"']+)["']/gu;
const TS_ROUTE = /\b(?:app|api|router)\.(?<method>get|post|put|patch|delete)\(\s*["'`](?<path>[^"'`]+)["'`]/gu;

export const routeKey = (method: string, path: string): string => `${method.toUpperCase()} ${path.replace(/\{([A-Za-z_]\w*)\}/gu, ":$1")}`;

function collectRoutes(pattern: RegExp, source: string): string[] {
  const keys: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const method = match.groups?.["method"];
    const path = match.groups?.["path"];
    if (method !== undefined && path !== undefined) keys.push(routeKey(method, path));
  }
  return keys;
}

export const pythonRoutes = (source: string): string[] => collectRoutes(PYTHON_ROUTE, source);
export const tsRoutes = (source: string): string[] => collectRoutes(TS_ROUTE, source);

export function diffRoutes(python: readonly string[], ts: readonly string[]): RouteDiff {
  const py = new Set(python);
  const typescript = new Set(ts);
  const sorted = (keys: readonly string[]) => [...keys].sort(byKey);
  return {
    shared: sorted([...py].filter(key => typescript.has(key))),
    pythonOnly: sorted([...py].filter(key => !typescript.has(key))),
    tsOnly: sorted([...typescript].filter(key => !py.has(key))),
  };
}

export function formatRouteParity(diff: RouteDiff, base: string, head: string): string {
  return [
    `# Route parity. Python server at ${head} (src/cheongeum/server) against the TypeScript server in this tree (src/server).`,
    `# Ledger range ${base}..${head}. Path parameters are normalized from {x} to :x. WebSocket routes have no TypeScript convention yet.`,
    `shared: ${diff.shared.length}   python-only: ${diff.pythonOnly.length}   ts-only: ${diff.tsOnly.length}`,
    "",
    "## python-only (the TypeScript service must still serve these)",
    ...diff.pythonOnly,
    "",
    "## ts-only",
    ...diff.tsOnly,
    "",
    "## shared (request and response shapes still to compare)",
    ...diff.shared,
    "",
  ].join("\n");
}

const git = (...args: string[]): string => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function resolveCommit(rev: string): string {
  try {
    return git("rev-parse", "--verify", "--quiet", `${rev}^{commit}`).trim();
  } catch {
    throw new Error(`${rev} is not a commit in this repository`);
  }
}

function pythonRoutesAt(rev: string): string[] {
  const files = git("ls-tree", "-r", "-z", "--name-only", rev, "--", "src/cheongeum/server").split("\0").filter(file => file.endsWith(".py"));
  return files.flatMap(file => pythonRoutes(git("show", `${rev}:${file}`)));
}

function tsRoutesHere(): string[] {
  const dir = join(REPO_ROOT, "src/server");
  return readdirSync(dir).filter(file => file.endsWith(".ts")).flatMap(file => tsRoutes(readFileSync(join(dir, file), "utf8")));
}

function checkAgainstShortstat(rows: readonly LedgerRow[], base: string, head: string) {
  const text = git("diff", "--shortstat", "--no-renames", base, head);
  const match = /(?<files>\d+) files? changed(?:, (?<added>\d+) insertions?\(\+\))?(?:, (?<removed>\d+) deletions?\(-\))?/u.exec(text);
  const expected = { files: Number(match?.groups?.["files"] ?? "0"), added: Number(match?.groups?.["added"] ?? "0"), removed: Number(match?.groups?.["removed"] ?? "0") };
  const actual = totals(rows);
  if (actual.files !== expected.files || actual.added !== expected.added || actual.removed !== expected.removed) {
    throw new Error(`ledger totals ${JSON.stringify(actual)} disagree with git --shortstat ${JSON.stringify(expected)}`);
  }
}

export function main(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { base: { type: "string" }, head: { type: "string" }, out: { type: "string" } } });
  if (values.base === undefined || values.head === undefined) {
    console.error("usage: node scripts/port-ledger.ts --base <rev> --head <rev> [--out <dir>]   (--base and --head are required)");
    return 2;
  }
  try {
    const base = resolveCommit(values.base);
    const head = resolveCommit(values.head);
    const range = [base, head];
    const rows = buildLedger(parseChanges(git("diff", "--name-status", "-z", "--no-renames", ...range), git("diff", "--numstat", "-z", "--no-renames", ...range)), modules);
    checkAgainstShortstat(rows, base, head);
    const routes = diffRoutes(pythonRoutesAt(head), tsRoutesHere());
    const out = join(REPO_ROOT, values.out ?? "reports/migration");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "ledger.tsv"), toTsv(rows));
    writeFileSync(join(out, "route-parity.txt"), formatRouteParity(routes, base, head));
    const sum = totals(rows);
    console.log(`${formatSummary(rows)}\n\nledger ${base.slice(0, 7)}..${head.slice(0, 7)}: ${sum.files} files, +${sum.added} -${sum.removed} (matches git --shortstat)`);
    console.log(`routes: ${routes.shared.length} shared, ${routes.pythonOnly.length} python-only, ${routes.tsOnly.length} ts-only`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
