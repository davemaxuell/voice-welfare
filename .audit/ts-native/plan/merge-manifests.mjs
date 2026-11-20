// Folds the manifest fragments the delegates wrote into port-manifest.json and points the reference at 77aad3e.
// Run from the repo root:  node .audit/ts-native/plan/merge-manifests.mjs
// Each fragment is .audit/ts-native/manifest/<package>.json: {"src/x/y.ts": {"python": ["src/cheongeum/x/y.py"], "sha": "<40 hex>", "partial": true?}}
// Stops without writing when any fragment entry is malformed or names a TypeScript file that is not on disk.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE = { commit: "77aad3e88704e55be257d443664582a39e23861d", collection: ".audit/ts-native/collect-77aad3e.txt" };
const DIR = ".audit/ts-native/manifest";
const SAFE_PATH = /^(?!\/)(?!.*\.\.)(?!.*[\\:*?[]).+$/u;

const manifest = JSON.parse(readFileSync("port-manifest.json", "utf8"));
const problems = [];
let merged = 0;
const fragments = existsSync(DIR) ? readdirSync(DIR).filter(file => file.endsWith(".json")).sort() : [];
for (const file of fragments) {
  const fragment = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  for (const [ts, entry] of Object.entries(fragment)) {
    const where = `${file}: ${ts}`;
    if (!SAFE_PATH.test(ts)) { problems.push(`${where} is not a safe repo path`); continue; }
    if (!existsSync(ts)) { problems.push(`${where} does not exist on disk`); continue; }
    if (!Array.isArray(entry.python) || entry.python.length === 0 || !entry.python.every(path => typeof path === "string" && SAFE_PATH.test(path))) { problems.push(`${where} needs a non-empty python list of safe paths`); continue; }
    if (typeof entry.sha !== "string" || !/^[0-9a-f]{7,40}$/u.test(entry.sha)) { problems.push(`${where} needs a hex sha`); continue; }
    if (entry.partial !== undefined && entry.partial !== true) { problems.push(`${where} partial may only be true`); continue; }
    manifest.modules[ts] = entry.partial === true ? { python: entry.python, sha: entry.sha, partial: true } : { python: entry.python, sha: entry.sha };
    merged += 1;
  }
}
const removed = Object.keys(manifest.modules).filter(ts => !existsSync(ts));
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(2);
}
for (const ts of removed) delete manifest.modules[ts];
manifest.reference = REFERENCE;
writeFileSync("port-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`merged ${merged} entries from ${fragments.length} fragments, dropped ${removed.length} entries whose TypeScript file is gone, reference ${REFERENCE.commit.slice(0, 7)}`);
for (const ts of removed) console.log(`  dropped ${ts}`);
