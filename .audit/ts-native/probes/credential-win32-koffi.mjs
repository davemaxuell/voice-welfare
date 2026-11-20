// Candidate fix for the Windows credential-store mismatch: direct Win32 CredReadW/CredWriteW through koffi,
// targeting the same entry name Python's keyring uses. koffi is NOT yet a dependency of this repo (unit U4 decides that).
// Run from the repo root with koffi installed somewhere, for example:
//   mkdir %TEMP%\koffi && cd %TEMP%\koffi && npm init -y && npm i koffi
//   set KOFFI_DIR=%TEMP%\koffi && node .audit/ts-native/probes/credential-win32-koffi.mjs        (needs `uv` on PATH)
// Every entry uses a random throwaway service name. The real "cheongeum-voice-welfare" entry is never read or written.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") { console.log(JSON.stringify({ skipped: "Windows only" })); process.exit(0); }
const koffiDir = process.env["KOFFI_DIR"] ?? fileURLToPath(new URL("../../../", import.meta.url));
const koffi = createRequire(join(koffiDir, "package.json"))("koffi");
const advapi32 = koffi.load("advapi32.dll");
const FILETIME = koffi.struct("FILETIME", { dwLowDateTime: "uint32", dwHighDateTime: "uint32" });
const CREDENTIALW = koffi.struct("CREDENTIALW", {
  Flags: "uint32", Type: "uint32", TargetName: "str16", Comment: "str16", LastWritten: FILETIME,
  CredentialBlobSize: "uint32", CredentialBlob: "uint8_t *", Persist: "uint32", AttributeCount: "uint32",
  Attributes: "void *", TargetAlias: "str16", UserName: "str16",
});
const CredReadW = advapi32.func("bool __stdcall CredReadW(str16 TargetName, uint32 Type, uint32 Flags, _Out_ CREDENTIALW **Credential)");
const CredWriteW = advapi32.func("bool __stdcall CredWriteW(CREDENTIALW *Credential, uint32 Flags)");
const CredDeleteW = advapi32.func("bool __stdcall CredDeleteW(str16 TargetName, uint32 Type, uint32 Flags)");
const CredFree = advapi32.func("void __stdcall CredFree(void *Buffer)");
const GENERIC = 1;
const PERSIST_ENTERPRISE = 3;

function readPassword(target) {
  const out = [null];
  if (!CredReadW(target, GENERIC, 0, out)) return null;
  try {
    const cred = koffi.decode(out[0], CREDENTIALW);
    const bytes = cred.CredentialBlobSize === 0 ? [] : koffi.decode(cred.CredentialBlob, "uint8_t", cred.CredentialBlobSize);
    return Buffer.from(bytes).toString("utf16le");
  } finally {
    CredFree(out[0]);
  }
}
function writePassword(target, user, value) {
  const blob = Buffer.from(value, "utf16le");
  return CredWriteW({
    Flags: 0, Type: GENERIC, TargetName: target, Comment: "cheongeum", LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 },
    CredentialBlobSize: blob.length, CredentialBlob: blob, Persist: PERSIST_ENTERPRISE, AttributeCount: 0, Attributes: null,
    TargetAlias: null, UserName: user,
  }, 0);
}
const py = (code, ...args) => {
  const r = spawnSync("uv", ["run", "--no-project", "--quiet", "--with", "keyring==25.7.0", "python", "-I", "-c", code, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr.slice(-300));
  return r.stdout.trim();
};
const pyGet = (service, user) => JSON.parse(py("import sys,json,keyring; print(json.dumps(keyring.get_password(sys.argv[1],sys.argv[2])))", service, user));

const user = "data-key";
const a = `cheongeum-compat-probe-${randomBytes(4).toString("hex")}`;
const b = `cheongeum-compat-probe-${randomBytes(4).toString("hex")}`;
const valueA = randomBytes(32).toString("hex");
const valueB = randomBytes(32).toString("hex");
const out = { koffi: koffi.version ?? "unknown" };
try {
  py("import sys,keyring; keyring.set_password(sys.argv[1],sys.argv[2],sys.argv[3])", a, user, valueA);
  out.koffiReadsPythonEntry = readPassword(a) === valueA;
  readPassword(a);
  readPassword(a);
  out.koffiReadLeavesEntryIntact = pyGet(a, user) === valueA;
  out.koffiWriteReturned = writePassword(b, user, valueB);
  out.pythonReadsKoffiEntry = pyGet(b, user) === valueB;
  out.koffiReadsItsOwn = readPassword(b) === valueB;
  out.controlMissingEntryIsNull = readPassword(`cheongeum-compat-probe-missing-${randomBytes(3).toString("hex")}`) === null;
  out.koffiOverwritesPythonEntryAndPythonSeesIt = (() => { writePassword(a, user, valueB); return pyGet(a, user) === valueB; })();
} finally {
  for (const t of [a, b]) { try { CredDeleteW(t, GENERIC, 0); } catch {} try { py("import sys,keyring; keyring.delete_password(sys.argv[1],sys.argv[2])", t, user); } catch {} }
  out.leftover = spawnSync("cmd.exe", ["/c", "cmdkey /list"], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(l => l.includes("compat-probe")).length;
}
console.log(JSON.stringify(out, null, 2));
process.exitCode = out.koffiReadsPythonEntry && out.koffiReadLeavesEntryIntact && out.pythonReadsKoffiEntry && out.koffiReadsItsOwn && out.controlMissingEntryIsNull && out.leftover === 0 ? 0 : 1;
