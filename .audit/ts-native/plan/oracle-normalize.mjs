// Drops recorded oracle calls whose recordings contradict each other: the same function and arguments with different results.
// The recorder does not capture hidden state, so such a call cannot be replayed faithfully.
//   node .audit/ts-native/plan/oracle-normalize.mjs --check <dir>          list conflicts, write nothing
//   node .audit/ts-native/plan/oracle-normalize.mjs <from.jsonl> <to.jsonl> copy a file without the conflicting calls
// Every dropped call is appended to .audit/ts-native/oracle-conflicts.tsv with the file, the line numbers and both results.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])])) : value);

function scan(path) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(line => line !== "");
  const groups = new Map();
  lines.forEach((line, index) => {
    const row = JSON.parse(line);
    const key = `${row.fn}\u0000${JSON.stringify(sortKeys(row.args))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ index, result: JSON.stringify(sortKeys(row.result)) });
  });
  const conflicts = [...groups.entries()].filter(([, rows]) => new Set(rows.map(row => row.result)).size > 1);
  return { lines, conflicts };
}

const [first, second, third] = process.argv.slice(2);
if (first === "--check") {
  let total = 0;
  for (const file of readdirSync(second).filter(name => name.endsWith(".jsonl")).sort()) {
    const { lines, conflicts } = scan(join(second, file));
    total += conflicts.length;
    console.log(`${file.padEnd(36)} ${String(lines.length).padStart(6)} rows, ${conflicts.length} conflicting calls`);
  }
  console.log(`total conflicting calls: ${total}`);
} else if (first !== undefined && second !== undefined && third === undefined) {
  const { lines, conflicts } = scan(first);
  const drop = new Set(conflicts.flatMap(([, rows]) => rows.map(row => row.index)));
  writeFileSync(second, `${lines.filter((_, index) => !drop.has(index)).join("\n")}\n`);
  const log = ".audit/ts-native/oracle-conflicts.tsv";
  if (!existsSync(log)) writeFileSync(log, "file\tfunction\tlines\treason\n");
  for (const [key, rows] of conflicts) {
    appendFileSync(log, `${second}\t${key.split("\u0000")[0]}\t${rows.map(row => row.index + 1).join(",")}\tsame arguments recorded with ${new Set(rows.map(row => row.result)).size} different results, dropped\n`);
  }
  console.log(`${second}: kept ${lines.length - drop.size} of ${lines.length} rows, dropped ${drop.size} rows in ${conflicts.length} conflicting calls`);
} else {
  console.error("usage: oracle-normalize.mjs --check <dir> | <from.jsonl> <to.jsonl>");
  process.exit(2);
}
