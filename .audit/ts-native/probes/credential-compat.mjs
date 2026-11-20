// Windows credential-store compatibility between the Python app (keyring 25.7.0) and the TypeScript port (@napi-rs/keyring).
// Run from the repo root after `npm ci`, with `uv` on PATH:
//   node .audit/ts-native/probes/credential-compat.mjs
// Every entry uses a random throwaway service name. The real "cheongeum-voice-welfare" entry is never read or written.
// Only non-destructive readers are used. Entry.withTarget(...).getPassword() empties the entry, see credential-readers.mjs.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") { console.log(JSON.stringify({ skipped: "Windows only" })); process.exit(0); }
const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const { Entry, findCredentials } = createRequire(`${root}package.json`)("@napi-rs/keyring");
const user = "data-key";
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const py = (code, ...args) => {
  const r = run("uv", ["run", "--no-project", "--quiet", "--with", "keyring==25.7.0", "python", "-I", "-c", code, ...args]);
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr.slice(-300)}`);
  return r.stdout.trim();
};
const win32 = (target) => JSON.parse(run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${here}credread.ps1`, "-Target", target]).stdout.trim());
const targets = (name) => run("cmd.exe", ["/c", "cmdkey /list"]).stdout.split(/\r?\n/).filter(l => l.includes(name)).map(l => l.trim().replace(/^Target: LegacyGeneric:target=/, ""));
const classify = (got, want) => got === null ? "NULL" : got === want ? "OK" : got === "" ? "EMPTY" : "OTHER";
const writers = {
  python: (s, v) => py("import sys,keyring; keyring.set_password(sys.argv[1],sys.argv[2],sys.argv[3])", s, user, v),
  rustDefault: (s, v) => new Entry(s, user).setPassword(v),
  rustPinned: (s, v) => Entry.withTarget(s, s, user).setPassword(v),
};
const readers = {
  python: (s) => JSON.parse(py("import sys,json,keyring; print(json.dumps(keyring.get_password(sys.argv[1],sys.argv[2])))", s, user)),
  rustDefault: (s) => new Entry(s, user).getPassword(),
  rustFind: (s) => findCredentials(s, s).find(c => c.account === user)?.password ?? null,
};

const made = [];
const result = { node: process.version, keyringNpm: JSON.parse(readFileSync(`${root}node_modules/@napi-rs/keyring/package.json`, "utf8")).version, matrix: {}, storedTargets: {}, blob: {} };
try {
  for (const [w, write] of Object.entries(writers)) {
    const service = `cheongeum-compat-probe-${randomBytes(4).toString("hex")}`;
    const value = randomBytes(32).toString("hex");
    made.push(service);
    write(service, value);
    result.storedTargets[w] = targets(service);
    const t = result.storedTargets[w][0];
    if (t !== undefined) { const b = win32(t); result.blob[w] = { bytes: b.blobSize, persist: b.persist, utf16leDecodesToWrittenValue: Buffer.from(b.fullHex, "hex").toString("utf16le") === value }; }
    result.matrix[w] = Object.fromEntries(Object.entries(readers).map(([r, read]) => [r, classify((() => { try { return read(service); } catch (e) { return `ERR ${e}`; } })(), value)]));
  }
} finally {
  for (const s of made) {
    try { py("import sys,keyring; keyring.delete_password(sys.argv[1],sys.argv[2])", s, user); } catch {}
    for (const t of [s, `${user}.${s}`]) run("cmd.exe", ["/c", `cmdkey /delete:${t}`]);
  }
  result.leftoverAfterCleanup = targets("compat-probe");
}
const m = result.matrix;
result.controls = {
  pythonReadsItsOwn: m.python?.python === "OK",
  rustDefaultReadsItsOwn: m.rustDefault?.rustDefault === "OK",
  pythonReadsPinnedWrite: m.rustPinned?.python === "OK",
  findReadsPinnedWrite: m.rustPinned?.rustFind === "OK",
  noLeftover: result.leftoverAfterCleanup.length === 0,
};
result.verdict = {
  tsAsWrittenCanReadPythonKey: m.python?.rustDefault === "OK",
  tsWithFindCredentialsCanReadPythonKey: m.python?.rustFind === "OK",
  pythonCanReadKeyTsAsWrittenCreates: m.rustDefault?.python === "OK",
};
console.log(JSON.stringify(result, null, 2));
const controlsOk = Object.values(result.controls).every(ok => ok);
process.exitCode = !controlsOk ? 2 : result.verdict.tsAsWrittenCanReadPythonKey ? 0 : 1;
