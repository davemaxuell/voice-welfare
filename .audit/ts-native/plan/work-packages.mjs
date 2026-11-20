// Splits the port ledger into work packages with disjoint file ownership and a wave order.
// Run from the repo root:  node .audit/ts-native/plan/work-packages.mjs
// Reads .audit/ts-native/ledger.tsv and the Python tests at the commit the ledger was made for (the tree on disk).
// Writes .audit/ts-native/work-packages.tsv and prints a summary.
import { readFileSync, writeFileSync } from "node:fs";

const WAVE = { core: 1, ui: 1, desktop: 1, language: 2, personal: 2, welfare: 2, webagent: 2, server: 2, session: 3, runtime: 3, scripts: 4 };
const C = "src/cheongeum/";
const under = (...prefixes) => (path) => prefixes.some(prefix => path.startsWith(prefix));
const isFile = (...names) => (path) => names.includes(path);
const RULES = [
  [under("apps/desktop/"), "desktop"],
  [under(`${C}core/`), "core"],
  [isFile(`${C}speech/screen.py`, `${C}speech/picture.py`), "webagent"],
  [under(`${C}understanding/`, `${C}language/`, `${C}speech/`, `${C}safety/`), "language"],
  [isFile(`${C}orchestrator/first_run.py`, `${C}orchestrator/speech_repair.py`), "personal"],
  [under(`${C}personal/`), "personal"],
  [under(`${C}agents/welfare/`, `${C}evaluation/`), "welfare"],
  [under(`${C}agents/web/`), "webagent"],
  [isFile(`${C}orchestrator/session.py`, `${C}orchestrator/task_review.py`), "session"],
  [isFile(`${C}orchestrator/public_task.py`), "server"],
  [isFile(`${C}server/runtime.py`, `${C}server/app.py`, `${C}server/__main__.py`), "runtime"],
  [under(`${C}server/`, `${C}voice/`), "server"],
  [under(`${C}practice_site/`), "runtime"],
  [under(`${C}web/`), "ui"],
  [(path) => path.startsWith("welfare_catalog_checkpoint_") && path.includes("/tools/"), "scripts"],
  [under("scripts/"), "scripts"],
];
const wpOfPath = (path) => RULES.find(([matches]) => matches(path))?.[1];

const rows = readFileSync(".audit/ts-native/ledger.tsv", "utf8").trim().split("\n").slice(1).map(line => {
  const [path, change, area, handling, status, added, removed, tsModules] = line.split("\t");
  return { path, change, area, handling, status, added: Number(added), removed: Number(removed), tsModules };
}).filter(row => row.handling === "port");

const importedModules = (text) => {
  const found = new Set();
  for (const m of text.matchAll(/^[ \t]*from[ \t]+cheongeum((?:\.[A-Za-z_]\w*)*)[ \t]+import[ \t]+([^\n(]+|\([^)]*\))/gmu)) {
    const base = m[1].replaceAll(".", "/");
    found.add(`src/cheongeum${base}.py`);
    for (const name of m[2].replace(/[()\s]/gu, "").split(",")) if (/^[a-z_]\w*$/u.test(name)) found.add(`src/cheongeum${base}/${name}.py`);
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+cheongeum((?:\.[A-Za-z_]\w*)*)/gmu)) found.add(`src/cheongeum${m[1].replaceAll(".", "/")}.py`);
  if (/from[ \t]+conftest[ \t]+import/u.test(text)) found.add("src/cheongeum/server/runtime.py");
  return [...found];
};

const assignTest = (row) => {
  if (/^apps\/desktop\//.test(row.path)) return "desktop";
  let text = "";
  try { text = readFileSync(row.path, "utf8"); } catch { return "core"; }
  const owners = importedModules(text).map(wpOfPath).filter(owner => owner !== undefined);
  if (owners.length === 0) return "core";
  return owners.reduce((best, owner) => (WAVE[owner] > WAVE[best] ? owner : best));
};

const out = rows.map(row => {
  const wp = row.area === "test" ? assignTest(row) : (wpOfPath(row.path) ?? "unassigned");
  return { wave: WAVE[wp] ?? 9, wp, ...row };
}).sort((a, b) => a.wave - b.wave || a.wp.localeCompare(b.wp, "en") || a.area.localeCompare(b.area, "en") || a.path.localeCompare(b.path, "en"));

const header = ["wave", "wp", "area", "status", "added", "removed", "python_path", "ts_modules"];
writeFileSync(".audit/ts-native/work-packages.tsv", [header.join("\t"), ...out.map(r => [r.wave, r.wp, r.area, r.status, r.added, r.removed, r.path, r.tsModules].join("\t"))].join("\n") + "\n");

const summary = new Map();
for (const r of out) {
  const key = `${r.wave} ${r.wp}`;
  const s = summary.get(key) ?? { code: 0, codeLines: 0, tests: 0, testLines: 0 };
  if (r.area === "test") { s.tests += 1; s.testLines += r.added; } else { s.code += 1; s.codeLines += r.added; }
  summary.set(key, s);
}
console.log("wave wp            product files/lines   test files/lines");
for (const [key, s] of [...summary.entries()].sort()) console.log(`${key.padEnd(18)} ${String(s.code).padStart(4)} ${String(s.codeLines).padStart(7)}   ${String(s.tests).padStart(4)} ${String(s.testLines).padStart(7)}`);
console.log(`unassigned: ${out.filter(r => r.wp === "unassigned").length}   total rows: ${out.length}`);
