// Which @napi-rs/keyring readers can see an entry Python's keyring wrote, and which of them damage it?
// Each reader runs on a FRESH Python-written entry. Python re-reads afterwards, and the raw Windows blob size is read again.
// Each reader also runs on a name nobody wrote, to see whether the read creates an entry.
// Run from the repo root after `npm ci`, with `uv` on PATH (koffi is used too when KOFFI_DIR points at a folder that has it):
//   node .audit/ts-native/probes/credential-readers.mjs
// Throwaway names only. The real "cheongeum-voice-welfare" entry is never read or written.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") { console.log(JSON.stringify({ skipped: "Windows only" })); process.exit(0); }
const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const { Entry, AsyncEntry, findCredentials, findCredentialsAsync } = createRequire(`${root}package.json`)("@napi-rs/keyring");
const user = "data-key";
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });
const py = (code, ...args) => {
  const r = run("uv", ["run", "--no-project", "--quiet", "--with", "keyring==25.7.0", "python", "-I", "-c", code, ...args]);
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr.slice(-300)}`);
  return r.stdout.trim();
};
const pyGet = (s) => JSON.parse(py("import sys,json,keyring; print(json.dumps(keyring.get_password(sys.argv[1],sys.argv[2])))", s, user));
const blobBytes = (target) => { const b = JSON.parse(run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${here}credread.ps1`, "-Target", target]).stdout.trim()); return b.found ? b.blobSize : "no entry"; };
const exists = (name) => run("cmd.exe", ["/c", "cmdkey /list"]).stdout.split(/\r?\n/).some(l => l.includes(name));

let win32Read = null;
try {
  const koffi = createRequire(join(process.env["KOFFI_DIR"] ?? root, "package.json"))("koffi");
  const advapi32 = koffi.load("advapi32.dll");
  const FILETIME = koffi.struct("FILETIME", { dwLowDateTime: "uint32", dwHighDateTime: "uint32" });
  const CREDENTIALW = koffi.struct("CREDENTIALW", { Flags: "uint32", Type: "uint32", TargetName: "str16", Comment: "str16", LastWritten: FILETIME, CredentialBlobSize: "uint32", CredentialBlob: "uint8_t *", Persist: "uint32", AttributeCount: "uint32", Attributes: "void *", TargetAlias: "str16", UserName: "str16" });
  const CredReadW = advapi32.func("bool __stdcall CredReadW(str16 TargetName, uint32 Type, uint32 Flags, _Out_ CREDENTIALW **Credential)");
  const CredFree = advapi32.func("void __stdcall CredFree(void *Buffer)");
  win32Read = (target) => { const o = [null]; if (!CredReadW(target, 1, 0, o)) return null; try { const c = koffi.decode(o[0], CREDENTIALW); return Buffer.from(c.CredentialBlobSize === 0 ? [] : koffi.decode(c.CredentialBlob, "uint8_t", c.CredentialBlobSize)).toString("utf16le"); } finally { CredFree(o[0]); } };
} catch { win32Read = null; }

const find = (list) => list.find(c => c.account === user)?.password ?? null;
const cases = {
  entryDefault: (s) => new Entry(s, user).getPassword(),
  entryPinned: (s) => Entry.withTarget(s, s, user).getPassword(),
  asyncEntryPinned: async (s) => await AsyncEntry.withTarget(s, s, user).getPassword(),
  findCredentialsServiceOnly: (s) => find(findCredentials(s)),
  findCredentialsServiceAndTarget: (s) => find(findCredentials(s, s)),
  findCredentialsAsyncServiceAndTarget: async (s) => find(await findCredentialsAsync(s, s)),
  ...(win32Read === null ? {} : { win32CredRead: (s) => win32Read(s) }),
};

const value = randomBytes(32).toString("hex");
const tag = (got) => got === null || got === undefined ? "NULL" : got === value ? "OK" : got === "" ? "EMPTY" : "OTHER";
const made = [];
const result = { node: process.version, win32ViaKoffi: win32Read !== null, readers: {} };
try {
  for (const [name, read] of Object.entries(cases)) {
    const s = `cheongeum-compat-probe-${randomBytes(4).toString("hex")}`;
    made.push(s);
    py("import sys,keyring; keyring.set_password(sys.argv[1],sys.argv[2],sys.argv[3])", s, user, value);
    const precondition = pyGet(s) === value && blobBytes(s) === value.length * 2;
    const returned = tag(await (async () => { try { return await read(s); } catch (e) { return `ERR ${e}`; } })());
    const missing = `cheongeum-compat-probe-missing-${randomBytes(3).toString("hex")}`;
    made.push(missing);
    const onMissing = tag(await (async () => { try { return await read(missing); } catch (e) { return `ERR ${e}`; } })());
    result.readers[name] = {
      precondition,
      returnedOnPythonEntry: returned,
      pythonStillReadsAfter: pyGet(s) === value,
      blobBytesAfter: blobBytes(s),
      onNameNobodyWrote: { returned: onMissing, createdAnEntry: exists(missing) },
    };
  }
} finally {
  for (const t of made) {
    try { py("import sys,keyring; keyring.delete_password(sys.argv[1],sys.argv[2])", t, user); } catch {}
    for (const n of [t, `${user}.${t}`]) run("cmd.exe", ["/c", `cmdkey /delete:${n}`]);
  }
  result.leftover = run("cmd.exe", ["/c", "cmdkey /list"]).stdout.split(/\r?\n/).filter(l => l.includes("compat-probe")).length;
}
const rows = Object.values(result.readers);
const safeAndWorks = (r) => r.returnedOnPythonEntry === "OK" && r.pythonStillReadsAfter && !r.onNameNobodyWrote.createdAnEntry;
result.safeReaders = Object.entries(result.readers).filter(([, r]) => safeAndWorks(r)).map(([n]) => n);
result.destructiveReaders = Object.entries(result.readers).filter(([, r]) => !r.pythonStillReadsAfter || r.onNameNobodyWrote.createdAnEntry).map(([n]) => n);
console.log(JSON.stringify(result, null, 2));
const valid = rows.every(r => r.precondition) && result.leftover === 0;
process.exitCode = !valid ? 2 : result.safeReaders.length > 0 ? 0 : 1;
