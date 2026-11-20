// Splits the Python test names that still have no TypeScript title into one list per work package.
// Run from the repo root after:  node scripts/test-parity.ts .audit/ts-native/collect-77aad3e.txt > <missing file>
//   node .audit/ts-native/plan/parity-lists.mjs <missing file>
// Writes .audit/ts-native/parity/<package>.txt with lines "file::name", and prints counts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const missingFile = process.argv[2];
if (missingFile === undefined) throw new Error("usage: node .audit/ts-native/plan/parity-lists.mjs <missing names file>");
const missing = new Set(readFileSync(missingFile, "utf8").split(/\r?\n/).filter(line => line !== ""));
const filesOf = new Map();
for (const line of readFileSync(".audit/ts-native/collect-77aad3e.txt", "utf8").split(/\r?\n/)) {
  const m = /^(tests[\\/][^:]*)::(?:[A-Za-z_]\w*::)*(test_\w+)(?:\[.*\])?$/u.exec(line);
  if (m === null || m[1] === undefined || m[2] === undefined) continue;
  const file = m[1].split("\\").join("/");
  if (!filesOf.has(m[2])) filesOf.set(m[2], new Set());
  filesOf.get(m[2]).add(file);
}
const wpOfFile = new Map(readFileSync(".audit/ts-native/work-packages.tsv", "utf8").trim().split("\n").slice(1).map(line => {
  const cells = line.split("\t");
  return [cells[6], cells[1]];
}));

const byWp = new Map();
const orphans = [];
for (const name of [...missing].sort()) {
  const files = [...(filesOf.get(name) ?? [])];
  const wp = files.map(file => wpOfFile.get(file)).find(owner => owner !== undefined);
  if (wp === undefined) { orphans.push(`${files.join(",") || "?"}::${name}`); continue; }
  if (!byWp.has(wp)) byWp.set(wp, []);
  byWp.get(wp).push(`${files[0]}::${name}`);
}
mkdirSync(".audit/ts-native/parity", { recursive: true });
for (const [wp, lines] of byWp) writeFileSync(`.audit/ts-native/parity/${wp}.txt`, `${lines.join("\n")}\n`);
if (orphans.length > 0) writeFileSync(".audit/ts-native/parity/unassigned.txt", `${orphans.join("\n")}\n`);
for (const [wp, lines] of [...byWp.entries()].sort((a, b) => b[1].length - a[1].length)) console.log(`${wp.padEnd(10)} ${String(lines.length).padStart(4)} names`);
console.log(`unassigned ${String(orphans.length).padStart(4)} names   total ${missing.size}`);
