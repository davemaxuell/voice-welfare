// Launch the unpacked build the way a fresh Windows PC would: no Python, uv or Node, a new profile and a new home folder.
// node apps/desktop/test/packaged.ts [path to win-unpacked]
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { _electron, type ElectronApplication } from "playwright";
import { z } from "zod";

const UNPACKED = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "dist", "win-unpacked"));
const EXE = join(UNPACKED, "청음.exe");
const RUNTIME = join(UNPACKED, "resources", "runtime");
const FORBIDDEN = /^(python[\d.]*|pythonw[\d.]*|py|pyw|uv|uvx|node)\.exe$/i;
const TRIPWIRES = ["python.exe", "python3.exe", "pythonw.exe", "py.exe", "uv.exe", "uvx.exe", "node.exe"];
const PORTS = { first: 18000, last: 18999 };
// The app checks the release feed 15 seconds after start. A dead proxy keeps Electron's own requests off GitHub.
const NO_UPDATE_FEED = ["--proxy-server=http://127.0.0.1:9"];

const CimProcess = z.object({
  ProcessId: z.number(),
  ParentProcessId: z.number(),
  Name: z.string(),
  ExecutablePath: z.string().nullable(),
  CreationDate: z.string(),
  CommandLine: z.string().nullable(),
});
type Proc = z.infer<typeof CimProcess>;
const Snapshot = z.union([z.array(CimProcess), CimProcess.transform((p) => [p])]);
const LIST =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,@{n='CreationDate';e={[string]$_.CreationDate.Ticks}},CommandLine | ConvertTo-Json -Compress";
const identity = (p: Proc) => `${p.ProcessId}@${p.CreationDate}`;
const created = (p: Proc) => BigInt(p.CreationDate === "" ? "0" : p.CreationDate);

function processes(): Proc[] {
  return Snapshot.parse(JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", LIST], { encoding: "utf8", maxBuffer: 64 << 20 })));
}

/**
 * Every process seen while the app ran, from snapshots a few hundred milliseconds apart, starting before the launch.
 * Playwright starts the app through cmd.exe. That shell is the root and is not counted.
 */
class ProcessWatch {
  readonly #all = new Map<string, Proc>();
  readonly #watcher;
  readonly #first: Promise<void>;
  #stopped = false;
  constructor() {
    const loop = `while ($true) { ${LIST}; Start-Sleep -Milliseconds 100 }`;
    this.#watcher = spawn("powershell.exe", ["-NoProfile", "-Command", loop], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const lines = createInterface({ input: this.#watcher.stdout });
    this.#first = new Promise((ready) => lines.once("line", () => ready()));
    lines.on("line", (line) => {
      // Stopping the watcher can cut its last line short.
      if (this.#stopped || line.trim() === "") return;
      for (const p of Snapshot.parse(JSON.parse(line))) {
        // A process that is exiting no longer reports its path or command line, so keep what an earlier snapshot saw.
        const earlier = this.#all.get(identity(p));
        this.#all.set(identity(p), { ...p, ExecutablePath: earlier?.ExecutablePath ?? p.ExecutablePath, CommandLine: earlier?.CommandLine ?? p.CommandLine });
      }
    });
  }
  started() {
    return this.#first;
  }
  descendants(root: number): Proc[] {
    const shell = [...this.#all.values()].find((p) => p.ProcessId === root);
    const since = shell === undefined ? 0n : created(shell);
    const tree = new Map<string, Proc>();
    const pids = new Set([root]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of this.#all.values()) {
        if (p.ProcessId !== root && pids.has(p.ParentProcessId) && created(p) >= since && !tree.has(identity(p))) {
          tree.set(identity(p), p);
          pids.add(p.ProcessId);
          grew = true;
        }
      }
    }
    return [...tree.values()];
  }
  stop() {
    this.#stopped = true;
    this.#watcher.kill();
  }
}

/** Stand-ins for Python, uv and Node on PATH. Each records how it was called and fails. */
function tripwires(dir: string) {
  const log = join(dir, "tripwire.log");
  const source = `using System.IO; public static class Tripwire { public static int Main() { File.AppendAllText(@"${log}", System.Environment.CommandLine + "\\n"); return 9; } }`;
  const [first, ...others] = TRIPWIRES.map((name) => join(dir, name));
  assert.ok(first !== undefined);
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -TypeDefinition $env:TRIPWIRE_SOURCE -OutputAssembly '${first}' -OutputType ConsoleApplication`], {
    env: { ...process.env, TRIPWIRE_SOURCE: source },
  });
  for (const file of others) copyFileSync(first, file);
  assert.equal(spawnSync(first, ["--probe"]).status, 9);
  assert.match(readFileSync(log, "utf8"), /--probe/, "the tripwire records calls");
  return log;
}

async function freePort(): Promise<number> {
  for (let port = PORTS.first + Math.floor(Math.random() * 900); port <= PORTS.last; port++) {
    const server = createServer();
    const free = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (free) {
      await new Promise((done) => server.close(done));
      return port;
    }
  }
  throw new Error("no free port in 18000-18999");
}

async function until<T>(check: () => Promise<T | undefined> | T | undefined, what: string, timeout = 90_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function scrubbedEnv(home: string, bin: string) {
  const env: Record<string, string> = {};
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const temp = join(home, "AppData", "Local", "Temp");
  mkdirSync(temp, { recursive: true });
  return {
    ...env,
    PATH: [join(env.SystemRoot ?? "C:\\Windows", "System32"), bin].join(";"),
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: temp,
    TMP: temp,
    // Keeps the vault in memory, so the run never reads or writes the Windows credential store.
    CHEONGEUM_DATA_DIR: "",
    PRACTICE_MODE: "true",
    PILOT_PROFILE: "shared",
    LLM_PROVIDER: "mock",
    VOICE_BASE_URL: "http://127.0.0.1:1/v1",
    VOICE_API_KEY: "test-packaged-loopback",
  };
}

const Health = z.object({ ok: z.literal(true), welfareData: z.string() });
const Session = z.object({ sessionId: z.string(), consentRequired: z.boolean() });
const Turn = z.object({ state: z.string(), speech: z.string() });

async function post(origin: string, path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200, `${path} answered ${response.status}`);
  const data: unknown = await response.json();
  return data;
}

async function serviceOrigin(app: ElectronApplication) {
  const page = await until(() => app.windows().find((w) => w.url().includes("desktop=1")), "the conversation window");
  return new URL(page.url()).origin;
}

async function refused(origin: string) {
  try {
    await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1000) });
    return false;
  } catch (error) {
    return error instanceof Error && error.cause instanceof Error && "code" in error.cause && error.cause.code === "ECONNREFUSED";
  }
}

function loadedModules(pid: number): string[] {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).Modules | ForEach-Object { $_.FileName }`], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim().toLowerCase()).filter((line) => line !== "");
}

/** With the model in the package, the service loads it from there before it reports ready. Without it, rules alone redact. */
async function redactionModel(watch: ProcessWatch, shell: number) {
  const model = join(RUNTIME, "models", "koelectra-ko-pii-ner");
  if (!existsSync(join(model, "model_int8.onnx"))) return "redaction model not packaged";
  const service = await until(
    () => watch.descendants(shell).find((p) => p.Name === "청음.exe" && /node\.mojom\.NodeService/.test(p.CommandLine ?? "")),
    "the service process",
    10_000,
  );
  const onnx = join(RUNTIME, "node_modules", "onnxruntime-node", "bin").toLowerCase() + sep;
  const loaded = loadedModules(service.ProcessId).filter((file) => file.startsWith(onnx)).map((file) => basename(file));
  assert.ok(loaded.includes("onnxruntime.dll"), `the service loaded onnxruntime from the package at startup: ${loaded.join(", ")}`);
  return `redaction model from ${model} (${loaded.join(", ")})`;
}

function nativeModulesLoad(env: Record<string, string>) {
  const modules = ["@napi-rs/keyring", "playwright", "onnxruntime-node"].filter((name) => existsSync(join(RUNTIME, "node_modules", name)));
  const from = JSON.stringify(join(RUNTIME, "src", "desktop", "service.mjs"));
  const script = `const r = require("node:module").createRequire(${from}); for (const m of ${JSON.stringify(modules)}) r(m); console.log("loaded " + ${JSON.stringify(modules.join(", "))});`;
  const out = execFileSync(EXE, ["-e", script], { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
  assert.match(out, /loaded @napi-rs\/keyring, playwright/);
  return out.trim();
}

async function scenario(name: string, options: { occupyPreferred: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "cheongeum-packaged-"));
  const home = join(dir, "home");
  const profile = join(dir, "profile");
  const bin = join(dir, "bin");
  for (const folder of [profile, bin]) mkdirSync(folder, { recursive: true });
  const tripwireLog = tripwires(bin);
  rmSync(tripwireLog, { force: true });
  const env = scrubbedEnv(home, bin);
  const preferred = await freePort();
  writeFileSync(join(profile, "service-port"), String(preferred));
  const busy = createServer((socket) => socket.destroy());
  if (options.occupyPreferred) {
    busy.listen(preferred, "127.0.0.1");
    await once(busy, "listening");
  }
  const watch = new ProcessWatch();
  let app: ElectronApplication | undefined;
  let root: number | undefined;
  try {
    await watch.started();
    app = await _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${profile}`, ...NO_UPDATE_FEED], cwd: home, env, timeout: 90_000 });
    root = app.process().pid;
    assert.ok(root !== undefined);
    const shell = root;
    assert.equal(await app.evaluate(({ app: electron }) => electron.isPackaged), true);
    assert.equal(await app.evaluate(({ app: electron }) => electron.getName()), "cheongeum-desktop", "keeps the %APPDATA% folder name that existing installs use");

    const origin = await serviceOrigin(app);
    const port = Number(new URL(origin).port);
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    if (options.occupyPreferred) {
      assert.notEqual(port, preferred, "moves off an occupied preferred port");
      assert.equal(readFileSync(join(profile, "service-port"), "ascii"), String(port), "remembers the new port");
    } else {
      assert.equal(port, preferred, "reuses the saved port");
    }
    const health = Health.parse(await (await fetch(origin + "/api/health")).json());
    const redaction = await redactionModel(watch, shell);
    const page = await fetch(origin + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/, "serves the packaged web UI");

    const initial = await fetch(origin + "/api/session", { method: "POST" });
    assert.equal(initial.status, 409);
    assert.equal(z.object({ error: z.string() }).parse(await initial.json()).error, "SETUP_REQUIRED");
    await post(origin, "/api/settings", { deviceUse: "shared" });
    const session = Session.parse(await post(origin, "/api/session"));
    assert.equal(session.consentRequired, true);
    await post(origin, `/api/session/${session.sessionId}/consent`, { granted: true });
    const answer = Turn.parse(await post(origin, "/api/turn", { sessionId: session.sessionId, text: "장애인연금 지원 대상이 누구야?" }));
    assert.match(answer.speech, /18세|십팔\s*세|열여덟/, "answers from the packaged welfare data");
    const practice = Turn.parse(await post(origin, "/api/turn", { sessionId: session.sessionId, text: "장애인연금 신청 도와줘" }));
    assert.equal(practice.state, "APPLICATION_OPEN", `opens the practice site: ${practice.speech}`);
    const browsers = join(RUNTIME, "browsers") + sep;
    const chromium = await until(
      () => watch.descendants(shell).find((p) => p.Name === "chrome.exe" && (p.ExecutablePath ?? "").startsWith(browsers)),
      "the bundled Chromium in the process tree",
      10_000,
    );
    const loaded = nativeModulesLoad(env);

    await app.close();
    app = undefined;
    await until(async () => ((await refused(origin)) ? true : undefined), "the service to stop listening", 15_000);
    const alive = () => {
      const now = new Set(processes().map(identity));
      return watch.descendants(shell).filter((p) => now.has(identity(p)));
    };
    const survivors = await until(() => (alive().length === 0 ? [] : undefined), "every app process to exit", 15_000).catch(() => alive());
    assert.deepEqual(survivors.map((p) => `${p.Name} ${p.ProcessId}`), [], "no service, browser or helper process outlives the app");
    watch.stop();
    const tree = watch.descendants(shell);
    const names = [...new Set(tree.map((p) => p.Name))];
    assert.deepEqual(names.filter((n) => FORBIDDEN.test(n)), [], "the process tree never ran Python, uv or Node");
    assert.equal(existsSync(tripwireLog) ? readFileSync(tripwireLog, "utf8") : "", "", "nothing called python, uv or node through PATH");
    assert.deepEqual(new Set(names), new Set(["chrome.exe", "청음.exe"]), "only the app and its browser ran");
    const foreign = tree.filter((p) => p.Name === "chrome.exe" && p.ExecutablePath !== null && !p.ExecutablePath.startsWith(browsers));
    assert.deepEqual(foreign.map((p) => p.ExecutablePath), [], "every browser came from the installer");
    const service = tree.some((p) => p.Name === "청음.exe" && /--type=utility\b.*node\.mojom\.NodeService/.test(p.CommandLine ?? ""));
    assert.ok(service, "the service ran as an Electron utility process");
    console.log(
      `PASS ${name}: port ${port} (preferred ${preferred}), welfare data ${health.welfareData}, practice site in ${chromium.ExecutablePath ?? ""}, ${loaded}, ${redaction}, clean quit, ${tree.length} processes (${names.join(", ")})`,
    );
  } finally {
    watch.stop();
    busy.close();
    if (app !== undefined) await app.close().catch(() => undefined);
    if (root !== undefined) {
      const now = new Set(processes().map(identity));
      for (const p of watch.descendants(root).filter((q) => now.has(identity(q)))) {
        try {
          process.kill(p.ProcessId);
        } catch {
          /* already gone */
        }
      }
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

assert.equal(process.platform, "win32", "Windows only");
assert.ok(existsSync(EXE), `Build the unpacked app first: npm run build:desktop (${EXE} is missing)`);
// Process snapshots can miss a process that lives under a tenth of a second, so also prove the package has nothing to start.
const shipped = readdirSync(UNPACKED, { recursive: true, encoding: "utf8" }).filter((file) => FORBIDDEN.test(basename(file)));
assert.deepEqual(shipped, [], "the package contains no Python, uv or Node executable");
await scenario("fresh profile", { occupyPreferred: false });
await scenario("preferred port occupied", { occupyPreferred: true });
