// Two-way check of the sealed-file envelope between Python's seal.py and the TypeScript Seal.
// Run from the repo root while the Python tree is still in the checkout:
//   node .audit/ts-native/probes/envelope-compat.mjs        (needs `uv` on PATH)
// Fixed throwaway key and temp files only. No credential store is touched.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const root = fileURLToPath(new URL("../../../", import.meta.url)).split(sep).join("/");
const { Seal, readPrivateFile } = await import(pathToFileURL(`${root}src/personal/seal.ts`).href);
const dir = mkdtempSync(join(tmpdir(), "envelope-probe-"));
const key = randomBytes(32);
const wrongKey = randomBytes(32);
const plaintext = JSON.stringify({ name: "홍길동", memo: "한국어 ✓ 😀", n: [1, 2, 3] });

const py = (mode, keyHex, file, text = "") => {
  const code = [
    "import importlib.util, sys",
    `spec = importlib.util.spec_from_file_location('seal', '${root}src/cheongeum/personal/seal.py')`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "mode, key_hex, path, text = sys.argv[1:5]",
    "s = m.Seal(key=bytes.fromhex(key_hex))",
    "if mode == 'seal':",
    "    open(path, 'wb').write(s.seal(text.encode('utf-8')))",
    "else:",
    "    sys.stdout.buffer.write(s.open(open(path, 'rb').read()))",
  ].join("\n");
  const r = spawnSync("uv", ["run", "--no-project", "--quiet", "--with", "cryptography", "python", "-I", "-c", code, mode, keyHex, file, text], { encoding: "buffer" });
  return { status: r.status, out: r.stdout.toString("utf8") };
};

const out = { plaintextBytes: Buffer.byteLength(plaintext) };
try {
  const pySealed = join(dir, "py.sealed");
  const tsSealed = join(dir, "ts.sealed");
  const made = py("seal", key.toString("hex"), pySealed, plaintext);
  out.pythonSealed = made.status === 0 && readFileSync(pySealed).subarray(0, 4).toString("latin1") === "CE1\0";
  out.tsOpensPythonSealed = new Seal({ key }).open(readFileSync(pySealed)).toString("utf8") === plaintext;
  writeFileSync(tsSealed, new Seal({ key }).seal(Buffer.from(plaintext, "utf8")));
  const reopened = py("open", key.toString("hex"), tsSealed);
  out.pythonOpensTsSealed = reopened.status === 0 && reopened.out === plaintext;
  out.controlTsWrongKeyThrows = (() => { try { new Seal({ key: wrongKey }).open(readFileSync(pySealed)); return false; } catch { return true; } })();
  out.controlPythonWrongKeyFails = py("open", wrongKey.toString("hex"), tsSealed).status !== 0;
  const vault = join(dir, "personal.json");
  writeFileSync(vault, readFileSync(pySealed));
  const result = readPrivateFile(vault, new Seal({ key: wrongKey }), (data) => data);
  out.wrongKeyReadReturns = result === undefined ? "undefined (treated as no vault)" : "data";
  out.vaultFileStillAtOriginalPath = existsSync(vault);
  out.filesInDirAfter = readdirSync(dir).map(f => f.replace(/\d{4}-\d\d-\d\dT[\d-]+Z/u, "<timestamp>")).sort();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 2));
const ok = out.pythonSealed && out.tsOpensPythonSealed && out.pythonOpensTsSealed && out.controlTsWrongKeyThrows && out.controlPythonWrongKeyFails;
process.exitCode = ok ? 0 : 1;
