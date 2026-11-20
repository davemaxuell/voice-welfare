// End-to-end upgrade simulation on Windows with the TypeScript app's production Seal, readPrivateFile and writePrivateFile.
// Only the service name is swapped for a random throwaway one, so the real "cheongeum-voice-welfare" entry is never touched.
// Run from the repo root with `uv` on PATH (koffi is used too when KOFFI_DIR points at a folder that has it):
//   node .audit/ts-native/probes/upgrade-flow.mjs
// Scenarios, each on its own throwaway service and temp folder:
//   asShipped        a Python vault, opened with the key lookup the reviewed port ships (new Entry(service, user))
//   production       the same vault, key found by the production createKeyEntry (findCredentials read, Entry.withTarget(...).setPassword write)
//   freshInstall     no entry yet: the TypeScript app creates the key and a vault, then Python opens that vault
//   legacyTsBuild    an earlier TypeScript build made its own key at the default name and sealed a vault with it; a naive Python-name-only lookup is shown for contrast
//   win32 (optional) the Python vault again, key read with Win32 CredRead through koffi
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.platform !== "win32") { console.log(JSON.stringify({ skipped: "Windows only" })); process.exit(0); }
const root = fileURLToPath(new URL("../../../", import.meta.url)).split(sep).join("/");
const { Seal, readPrivateFile, writePrivateFile } = await import(pathToFileURL(`${root}src/personal/seal.ts`).href);
const { Entry, findCredentials } = createRequire(`${root}package.json`)("@napi-rs/keyring");
const { createKeyEntry } = await import(pathToFileURL(`${root}src/personal/credential_store.ts`).href);
const user = "data-key";
const data = { name: "홍길동", memo: "한국어 ✓" };

const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const py = (code, ...args) => {
  const r = run("uv", ["run", "--no-project", "--quiet", "--with", "keyring==25.7.0", "--with", "cryptography", "python", "-I", "-c", code, ...args]);
  if (r.status !== 0) throw new Error(r.stderr.slice(-300));
  return r.stdout.trim();
};
const pyGet = (service) => JSON.parse(py("import sys,json,keyring; print(json.dumps(keyring.get_password(sys.argv[1],sys.argv[2])))", service, user));
const pyShim = [
  "import importlib.util, sys, keyring",
  `spec = importlib.util.spec_from_file_location('seal', '${root}src/cheongeum/personal/seal.py')`,
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "svc, mode, path, text = sys.argv[1:5]",
  "class Shim:",
  "    def get_password(self, service, username): return keyring.get_password(svc, username)",
  "    def set_password(self, service, username, password): keyring.set_password(svc, username, password)",
  "s = m.Seal(store=Shim())",
  "if mode == 'seal':",
  "    open(path, 'wb').write(s.seal(text.encode('utf-8')))",
  "else:",
  "    sys.stdout.buffer.write(s.open(open(path, 'rb').read()))",
].join("\n");
const pySeal = (service, path) => py(pyShim, service, "seal", path, JSON.stringify(data));
const pyOpen = (service, path) => py(pyShim, service, "open", path, "");

const libraryEntry = (service) => ({
  getPassword: () => findCredentials(service, service).find(c => c.account === user)?.password ?? null,
  setPassword: (value) => Entry.withTarget(service, service, user).setPassword(value),
});

let win32Entry = null;
try {
  const koffi = createRequire(join(process.env["KOFFI_DIR"] ?? root, "package.json"))("koffi");
  const advapi32 = koffi.load("advapi32.dll");
  const FILETIME = koffi.struct("FILETIME", { dwLowDateTime: "uint32", dwHighDateTime: "uint32" });
  const CREDENTIALW = koffi.struct("CREDENTIALW", { Flags: "uint32", Type: "uint32", TargetName: "str16", Comment: "str16", LastWritten: FILETIME, CredentialBlobSize: "uint32", CredentialBlob: "uint8_t *", Persist: "uint32", AttributeCount: "uint32", Attributes: "void *", TargetAlias: "str16", UserName: "str16" });
  const CredReadW = advapi32.func("bool __stdcall CredReadW(str16 TargetName, uint32 Type, uint32 Flags, _Out_ CREDENTIALW **Credential)");
  const CredFree = advapi32.func("void __stdcall CredFree(void *Buffer)");
  win32Entry = (service) => ({
    getPassword: () => { const o = [null]; if (!CredReadW(service, 1, 0, o)) return null; try { const c = koffi.decode(o[0], CREDENTIALW); return Buffer.from(c.CredentialBlobSize === 0 ? [] : koffi.decode(c.CredentialBlob, "uint8_t", c.CredentialBlobSize)).toString("utf16le"); } finally { CredFree(o[0]); } },
    setPassword: () => { throw new Error("read-only in this probe"); },
  });
} catch { win32Entry = null; }

const services = [];
const dirs = [];
const fresh = () => { const service = `cheongeum-compat-probe-${randomBytes(4).toString("hex")}`; services.push(service); const dir = mkdtempSync(join(tmpdir(), "upgrade-flow-")); dirs.push(dir); return { service, dir, vault: join(dir, "personal.json") }; };
const moved = (dir) => readdirSync(dir).filter(f => f.includes("unreadable")).length;
const sameData = (r) => r !== undefined && JSON.stringify(r.data) === JSON.stringify(data);

const out = {};
try {
  {
    const { service, vault } = fresh();
    pySeal(service, vault);
    const pythonKey = pyGet(service);
    const r = readPrivateFile(vault, new Seal({ entry: new Entry(service, user) }), (d) => d);
    out.asShipped = { vaultOpened: r !== undefined, vaultMovedAside: !existsSync(vault), pythonsKeyUntouched: pyGet(service) === pythonKey };
  }
  {
    const { service, dir, vault } = fresh();
    pySeal(service, vault);
    const before = pyGet(service);
    const r = readPrivateFile(vault, new Seal({ entry: createKeyEntry(service, user) }), (d) => d);
    out.production = { vaultOpened: sameData(r), vaultStayedPut: existsSync(vault) && moved(dir) === 0, pythonsKeyUntouched: pyGet(service) === before };
  }
  {
    const { service, vault } = fresh();
    const seal = new Seal({ entry: createKeyEntry(service, user) });
    writePrivateFile(vault, data, seal);
    out.freshInstall = { pythonOpensTypescriptVault: JSON.stringify(JSON.parse(pyOpen(service, vault))) === JSON.stringify(data), typescriptReopens: sameData(readPrivateFile(vault, new Seal({ entry: createKeyEntry(service, user) }), (d) => d)) };
  }
  {
    const a = fresh();
    writePrivateFile(a.vault, data, new Seal({ entry: new Entry(a.service, user) }));
    const pythonNameOnly = readPrivateFile(a.vault, new Seal({ entry: libraryEntry(a.service) }), (d) => d);
    const b = fresh();
    writePrivateFile(b.vault, data, new Seal({ entry: new Entry(b.service, user) }));
    const bothNames = readPrivateFile(b.vault, new Seal({ entry: createKeyEntry(b.service, user) }), (d) => d);
    out.legacyTsBuild = {
      pythonNameOnlyOpensIt: sameData(pythonNameOnly),
      pythonNameOnlyMovedItAside: moved(a.dir) === 1,
      tryingBothNamesOpensIt: sameData(bothNames),
      tryingBothNamesLeftItInPlace: existsSync(b.vault) && moved(b.dir) === 0,
      pythonCanReadTheAdoptedKey: pyGet(b.service) !== null,
    };
  }
  if (win32Entry !== null) {
    const { service, dir, vault } = fresh();
    pySeal(service, vault);
    const before = pyGet(service);
    const r = readPrivateFile(vault, new Seal({ entry: win32Entry(service) }), (d) => d);
    out.win32ViaKoffi = { vaultOpened: sameData(r), vaultStayedPut: existsSync(vault) && moved(dir) === 0, pythonsKeyUntouched: pyGet(service) === before };
  } else {
    out.win32ViaKoffi = "skipped (koffi not found)";
  }
} finally {
  for (const s of services) {
    try { py("import sys,keyring; keyring.delete_password(sys.argv[1],sys.argv[2])", s, user); } catch {}
    try { new Entry(s, user).deletePassword(); } catch {}
    run("cmd.exe", ["/c", `cmdkey /delete:${s}`]);
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  out.leftover = run("cmd.exe", ["/c", "cmdkey /list"]).stdout.split(/\r?\n/).filter(l => l.includes("compat-probe")).length;
}
console.log(JSON.stringify(out, null, 2));
const ok = out.asShipped?.vaultOpened === false && out.production?.vaultOpened === true && out.production?.pythonsKeyUntouched === true
  && out.freshInstall?.pythonOpensTypescriptVault === true && out.freshInstall?.typescriptReopens === true
  && out.legacyTsBuild?.pythonNameOnlyMovedItAside === true && out.legacyTsBuild?.tryingBothNamesOpensIt === true && out.legacyTsBuild?.pythonCanReadTheAdoptedKey === true && out.leftover === 0;
process.exitCode = ok ? 0 : 1;
