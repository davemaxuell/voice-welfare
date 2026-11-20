/**
 * 데스크톱 앱 빌드: node apps/desktop/scripts/build.ts <app|dir|dist>
 * - app: 메인 프로세스와 preload만 묶는다(out/app). 개발 실행은 이것과 저장소의 서비스 원본을 쓴다.
 * - dir: 설치본에 넣을 서비스(out/runtime)를 만들고 압축하지 않은 앱(dist/win-unpacked)까지. 서명·배포 없음.
 * - dist: dir에 더해 설치 파일(NSIS)과 업데이트 파일. 배포하지 않는다.
 * 설치본의 서비스는 Electron에 들어 있는 Node로 돈다. 사용자 PC에 Python·uv·Node가 없어도 된다.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { build as bundle, type BuildOptions, type Plugin } from "esbuild";
import { Arch, build as packageApp, Platform, type AfterPackContext, type Configuration, type FileSet } from "electron-builder";
import { build as buildWeb } from "vite";
import { z } from "zod";

const DESKTOP = resolve(import.meta.dirname, "..");
const ROOT = resolve(DESKTOP, "..", "..");
const NODE_MODULES = join(ROOT, "node_modules");
const APP_OUT = join(DESKTOP, "out", "app");
const RUNTIME_OUT = join(DESKTOP, "out", "runtime");
const ICON = "../../graphics/mascot-original-refined.png";
// Loaded from the runtime folder at run time: native bindings, and Playwright, which reads its own package files.
const EXTERNAL = ["playwright", "playwright-core", "@napi-rs/keyring", "onnxruntime-node"];
const OPTIONAL = new Set(["onnxruntime-node"]);
const PII_MODEL = { dir: "koelectra-ko-pii-ner", files: ["model_int8.onnx", "config.json", "tokenizer.json", "README.md"] };
const GPU_ONLY = new Set(["DirectML.dll", "dxcompiler.dll"]);
/** What a run-time package leaves out: dependencies only its install script uses, and files the app never loads. */
const TRIM: Record<string, { installOnly: readonly string[]; skip: (parts: readonly string[]) => boolean }> = {
  "onnxruntime-node": {
    installOnly: ["adm-zip", "global-agent"],
    // bin/napi-v*/<platform>/<arch>/ holds every platform's build and the DirectML GPU provider, which the CPU session never loads.
    skip: ([top, , platform, arch, file]) =>
      top === "script" ||
      (top === "bin" &&
        ((platform !== undefined && platform !== process.platform) ||
          (arch !== undefined && arch !== process.arch) ||
          (file !== undefined && GPU_ONLY.has(file)))),
  },
};

const AppManifest = z.object({ name: z.string(), version: z.string(), description: z.string(), author: z.string() });
const PackageManifest = z.object({
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
});
const readJson = (dir: string): unknown => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

const NODE_TARGET: BuildOptions = { bundle: true, platform: "node", target: "node24", logLevel: "warning", legalComments: "none" };

// main.cjs loads updates.cjs at run time, so the release test can reach the shipped updater.
const separateUpdates: Plugin = {
  name: "separate-updates",
  setup(build) {
    build.onResolve({ filter: /^\.\/updates\.ts$/ }, () => ({ path: "./updates.cjs", external: true }));
  },
};

function ensureElectron() {
  const electron = join(NODE_MODULES, "electron");
  if (!existsSync(join(electron, "path.txt"))) execFileSync(process.execPath, [join(electron, "install.js")], { stdio: "inherit" });
}

async function bundleApp() {
  rmSync(APP_OUT, { recursive: true, force: true });
  const src = (name: string) => join(DESKTOP, "src", name + ".ts");
  const cjs: BuildOptions = { ...NODE_TARGET, format: "cjs", external: ["electron"], outdir: APP_OUT, outExtension: { ".js": ".cjs" } };
  await bundle({ ...cjs, entryPoints: { main: src("main") }, plugins: [separateUpdates] });
  await bundle({ ...cjs, entryPoints: { updates: src("updates"), preload: src("preload"), "overlay-preload": src("overlay-preload") } });
  const { name, version, description, author } = AppManifest.parse(readJson(DESKTOP));
  writeFileSync(join(APP_OUT, "package.json"), JSON.stringify({ name, version, description, author, main: "main.cjs" }, null, 2) + "\n");
}

function copyTree(from: string, to: string, keep: (file: string) => boolean = () => true) {
  cpSync(from, to, { recursive: true, filter: (file) => keep(file) });
}

/** src/ 아래의 TypeScript가 아닌 파일(모의 사이트, 복지 자료, 브라우저 대기 화면)을 같은 자리에 둔다. */
function copySourceAssets(dir = join(ROOT, "src")) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (file !== join(ROOT, "src", "cheongeum")) copySourceAssets(file);
    } else if (extname(entry.name) !== ".ts") {
      const target = join(RUNTIME_OUT, relative(ROOT, file));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
    }
  }
}

function copyModels() {
  const source = join(ROOT, "models", PII_MODEL.dir);
  if (!existsSync(source)) {
    console.log(`[build] models/${PII_MODEL.dir} is absent; the installer will not include the redaction model.`);
    return;
  }
  for (const file of PII_MODEL.files) {
    if (!existsSync(join(source, file))) throw new Error(`Missing models/${PII_MODEL.dir}/${file}.`);
    const target = join(RUNTIME_OUT, "models", PII_MODEL.dir, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(source, file), target);
  }
  if (existsSync(join(ROOT, "models", "MODELS.md"))) cpSync(join(ROOT, "models", "MODELS.md"), join(RUNTIME_OUT, "models", "MODELS.md"));
}

function packageDir(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === ROOT || dirname(dir) === dir) return undefined;
  }
}

/** 실행 때 불러오는 패키지와 그 의존 패키지를, 설치된 위치(중첩 포함) 그대로 runtime/node_modules에 둔다. */
function copyExternalPackages() {
  const found = new Map<string, string>();
  const visit = (name: string, from: string, optional: boolean) => {
    const dir = packageDir(name, from);
    if (dir === undefined) {
      if (optional) return;
      throw new Error(`${name} is not installed. Run npm ci at the repository root.`);
    }
    if (found.has(dir)) return;
    found.set(dir, name);
    const { dependencies, optionalDependencies } = PackageManifest.parse(readJson(dir));
    const installOnly = TRIM[name]?.installOnly ?? [];
    for (const dep of Object.keys(dependencies)) if (!installOnly.includes(dep)) visit(dep, dir, false);
    for (const dep of Object.keys(optionalDependencies)) visit(dep, dir, true);
  };
  for (const name of EXTERNAL) visit(name, ROOT, OPTIONAL.has(name));
  for (const [dir, name] of found) {
    copyTree(dir, join(RUNTIME_OUT, relative(ROOT, dir)), (file) => {
      const parts = relative(dir, file).split(sep);
      return parts[0] !== "node_modules" && TRIM[name]?.skip(parts) !== true;
    });
  }
}

async function stageRuntime() {
  rmSync(RUNTIME_OUT, { recursive: true, force: true });
  await buildWeb({ configFile: join(ROOT, "vite.config.ts"), logLevel: "warn" });
  const desktop = join(RUNTIME_OUT, "src", "desktop");
  await bundle({
    ...NODE_TARGET,
    format: "esm",
    entryPoints: [join(DESKTOP, "src", "service.ts")],
    outfile: join(desktop, "service.mjs"),
    external: EXTERNAL,
    // Bundled CommonJS packages call require() for Node built-ins.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  // The bundle contains the server's own command-line entry, which runs when the process entry is the bundle itself.
  writeFileSync(join(desktop, "start.mjs"), 'import "./service.mjs";\n');
  copySourceAssets();
  copyTree(join(ROOT, "dist", "web"), join(RUNTIME_OUT, "dist", "web"));
  copyModels();
  copyExternalPackages();
}

/** Playwright가 쓰는 Chromium(헤드리스 셸 제외)과 보조 도구의 설치 위치. */
function browsers(): FileSet[] {
  const command = [join(NODE_MODULES, "playwright", "cli.js"), "install", "--no-shell", "chromium"];
  execFileSync(process.execPath, [...command, "--no-remove"], { stdio: "inherit" });
  const plan = execFileSync(process.execPath, [...command, "--dry-run"], { encoding: "utf8" });
  const sources = plan
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Install location:"))
    .map((line) => line.slice("Install location:".length).trim());
  if (!sources.some((source) => basename(source).startsWith("chromium-"))) {
    throw new Error("Playwright did not report a Chromium install location.");
  }
  return sources.map((from) => ({ from, to: `runtime/browsers/${basename(from)}` }));
}

function afterPack(context: AfterPackContext) {
  // Native modules, Chromium and Electron must all match the machine that runs the build.
  if (context.electronPlatformName !== process.platform || Arch[context.arch] !== process.arch) {
    throw new Error("Build the installer on a machine matching the target OS and architecture.");
  }
  // The local Electron distribution still carries Electron's sample app.
  rmSync(join(context.packager.getResourcesDir(context.appOutDir), "default_app.asar"), { force: true });
}

function builderConfig(): Configuration {
  return {
    appId: "kr.cheongeum.app",
    productName: "청음",
    copyright: "Copyright © 청음",
    electronVersion: PackageManifest.parse(readJson(join(NODE_MODULES, "electron"))).version,
    electronDist: join(NODE_MODULES, "electron", "dist"),
    npmRebuild: false,
    directories: { app: "out/app", output: "dist", buildResources: "build" },
    afterPack,
    toolsets: { winCodeSign: "1.1.0" },
    files: ["main.cjs", "updates.cjs", "preload.cjs", "overlay-preload.cjs", "package.json", "!**/*.map"],
    extraResources: [
      { from: "../../docs/install.md", to: "install.md" },
      { from: ICON, to: "icon.png" },
      { from: "out/runtime", to: "runtime" },
      // electron-builder never copies a node_modules folder at the root of a file set.
      { from: "out/runtime/node_modules", to: "runtime/node_modules" },
      ...browsers(),
    ],
    win: {
      publish: { provider: "github", owner: "davemaxuell", repo: "voice-welfare" },
      icon: ICON,
      // 서명 없음(주인 결정). SmartScreen 경고는 docs/install.md 참고.
      signExecutable: false,
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: "Cheongeum-Setup-${version}.${ext}",
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: true,
      include: "build/installer.nsh",
      allowToChangeInstallationDirectory: true,
      shortcutName: "청음",
      installerLanguages: ["ko_KR", "en_US"],
    },
    mac: {
      target: "dmg",
      icon: ICON,
      artifactName: "청음-${version}-${arch}.${ext}",
      // 서명·공증 없음. Gatekeeper는 docs/install.md 참고.
      identity: null,
      category: "public.app-category.utilities",
      extendInfo: { NSMicrophoneUsageDescription: "청음이 말로 요청을 받을 때 마이크를 사용합니다." },
    },
    dmg: { title: "청음" },
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "app" && mode !== "dir" && mode !== "dist") throw new Error("Usage: node apps/desktop/scripts/build.ts <app|dir|dist>");
  ensureElectron();
  await bundleApp();
  if (mode === "app") return;
  await stageRuntime();
  const arch = process.arch === "arm64" ? Arch.arm64 : Arch.x64;
  await packageApp({
    projectDir: DESKTOP,
    config: builderConfig(),
    publish: "never",
    targets: Platform.current().createTarget(mode === "dir" ? "dir" : null, arch),
  });
}

await main();
