import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/core/assets.ts";
import { buildLedger, classify, diffRoutes, parseChanges, pythonRoutes, toTsv, tsRoutes, type Area, type Manifest } from "../../scripts/port-ledger.ts";

const manifest: Manifest = {
  "src/core/actions.ts": { python: ["src/cheongeum/core/actions.py"] },
  "src/safety/guard.ts": { python: ["src/cheongeum/safety/guard.py", "src/cheongeum/safety/policy.py"] },
  "src/voice/stt_local.ts": { python: ["src/cheongeum/voice/stt_local.py"] },
};
const nameStatus = (...pairs: readonly (readonly [string, string])[]) => `${pairs.flatMap(([status, path]) => [status, path]).join("\0")}\0`;
const numstat = (...rows: readonly (readonly [string, string, string])[]) => `${rows.map(row => row.join("\t")).join("\0")}\0`;

describe("parseChanges", () => {
  it("reads git -z output with Korean paths, spaces and binary files", () => {
    const changes = parseChanges(
      nameStatus(["A", "docs/기획요약.md"], ["M", "graphics/a b.png"]),
      numstat(["10", "0", "docs/기획요약.md"], ["-", "-", "graphics/a b.png"]),
    );
    expect(changes).toEqual([
      { kind: "added", path: "docs/기획요약.md", added: 10, removed: 0 },
      { kind: "modified", path: "graphics/a b.png", added: 0, removed: 0 },
    ]);
  });

  it("returns nothing for an empty range", () => {
    expect(parseChanges("", "")).toEqual([]);
  });

  it("refuses a rename status instead of guessing a path", () => {
    expect(() => parseChanges("R100\0old.py\0", "1\t1\told.py\0")).toThrow(/rename detection must be off/u);
  });

  it("refuses a path that has no line counts", () => {
    expect(() => parseChanges(nameStatus(["M", "a.py"]), "")).toThrow(/without line counts/u);
  });
});

describe("classify", () => {
  it.each<[string, Area]>([
    [".audit/evidence/x.json", "audit"],
    [".github/workflows/release-windows.yml", "ci"],
    ["welfare_catalog_checkpoint_2026-11-17/a.json", "data"],
    ["tests/fixtures/picture_cases.json", "fixture"],
    ["tests/unit/test_policy.py", "test"],
    ["apps/desktop/test/avatar.e2e.cjs", "test"],
    ["apps/desktop/main.cjs", "desktop"],
    ["scripts/eval_stt.py", "script"],
    ["docs/architecture.png", "doc"],
    ["README.md", "doc"],
    ["graphics/animations/idle.webm", "asset"],
    ["src/cheongeum/web/static/avatar/cheongeum-avatar.glb", "asset"],
    ["src/cheongeum/agents/welfare/data/centers.json", "data"],
    ["src/cheongeum/agents/welfare/open_data/snapshots/15059715.json", "data"],
    ["src/cheongeum/agents/welfare/data/__init__.py", "code"],
    ["welfare_catalog_checkpoint_2026-11-17/tools/collect_previews.py", "script"],
    ["welfare_catalog_checkpoint_2026-11-17/sample_provenance/15024967.json", "data"],
    ["apps/desktop/package-lock.json", "config"],
    ["src/cheongeum/web/static/avatar/vendor/three/GLTFLoader.js", "vendor"],
    ["src/cheongeum/web/static/avatar/vendor/README.md", "vendor"],
    ["pyproject.toml", "config"],
    ["src/cheongeum/web/static/app.js", "web"],
    ["src/cheongeum/orchestrator/session.py", "code"],
    ["LICENSE", "other"],
  ])("%s is %s", (path, area) => {
    expect(classify(path)).toBe(area);
  });
});

describe("buildLedger", () => {
  const rows = buildLedger(
    [
      { kind: "modified", path: "src/cheongeum/core/actions.py", added: 3, removed: 1 },
      { kind: "modified", path: "src/cheongeum/core/lexicon.py", added: 5, removed: 0 },
      { kind: "added", path: "src/cheongeum/orchestrator/first_run.py", added: 200, removed: 0 },
      { kind: "deleted", path: "src/cheongeum/voice/stt_local.py", added: 0, removed: 90 },
      { kind: "deleted", path: "src/cheongeum/safety/pii_model.py", added: 0, removed: 120 },
      { kind: "added", path: "welfare_catalog_checkpoint_2026-11-17/a.json", added: 9, removed: 0 },
      { kind: "added", path: ".audit/run.tsv", added: 1, removed: 0 },
      { kind: "modified", path: "docs/install.md", added: 2, removed: 2 },
      { kind: "modified", path: "src/cheongeum/safety/guard.py", added: 4, removed: 0 },
    ],
    manifest,
  );
  const status = (path: string) => rows.find(row => row.path === path)?.status;

  it("marks a changed file the manifest ports as drift and names its TypeScript module", () => {
    expect(status("src/cheongeum/core/actions.py")).toBe("drift");
    expect(rows.find(row => row.path === "src/cheongeum/safety/guard.py")?.tsModules).toEqual(["src/safety/guard.ts"]);
  });

  it("marks a changed file nothing ports as unmapped and a new one as new", () => {
    expect(status("src/cheongeum/core/lexicon.py")).toBe("unmapped");
    expect(status("src/cheongeum/orchestrator/first_run.py")).toBe("new");
  });

  it("marks a deleted file as retired only when its TypeScript counterpart exists", () => {
    expect(status("src/cheongeum/voice/stt_local.py")).toBe("retired");
    expect(status("src/cheongeum/safety/pii_model.py")).toBe("none");
  });

  it("sends a vendored library to review instead of counting it as a port", () => {
    const vendored = buildLedger([{ kind: "added", path: "src/cheongeum/web/static/avatar/vendor/three/GLTFLoader.js", added: 4727, removed: 0 }], manifest);
    expect(vendored[0]).toMatchObject({ area: "vendor", handling: "review", status: "none" });
  });

  it("does not ask to port data, audit files or docs", () => {
    expect(rows.find(row => row.area === "data")).toMatchObject({ handling: "copy", status: "none" });
    expect(rows.find(row => row.area === "audit")).toMatchObject({ handling: "skip", status: "none" });
    expect(rows.find(row => row.area === "doc")).toMatchObject({ handling: "review", status: "none" });
  });

  it("lists only changed files, so an unchanged mapped file never shows as drift", () => {
    expect(rows.some(row => row.path === "src/cheongeum/safety/policy.py")).toBe(false);
    expect(rows).toHaveLength(9);
  });

  it("sorts by area then path so a rerun gives the same file", () => {
    expect(rows.map(row => row.area)).toEqual([...rows.map(row => row.area)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("toTsv", () => {
  it("writes a header and one line per change", () => {
    const tsv = toTsv(buildLedger([{ kind: "modified", path: "src/cheongeum/core/actions.py", added: 3, removed: 1 }], manifest));
    expect(tsv).toBe("path\tchange\tarea\thandling\tstatus\tadded\tremoved\tts_modules\nsrc/cheongeum/core/actions.py\tmodified\tcode\tport\tdrift\t3\t1\tsrc/core/actions.ts\n");
  });

  it("refuses a path with a tab instead of corrupting the columns", () => {
    expect(() => toTsv(buildLedger([{ kind: "added", path: "a\tb.py", added: 1, removed: 0 }], manifest))).toThrow(/control character/u);
  });
});

describe("route parity", () => {
  const python = pythonRoutes([
    '@app.get("/api/session/{sid}/state")',
    "@app.post('/api/settings')",
    '@app.websocket("/api/session/{sid}/audio/live")',
    '@router.delete("/api/session/{sid}")',
  ].join("\n"));
  const typescript = tsRoutes([
    'app.get("/api/session/:sid/state", handler)',
    'api.delete("/api/session/:sid", handler)',
    'app.get("/api/health", handler)',
  ].join("\n"));

  it("normalizes methods and path parameters on both sides", () => {
    expect(python).toEqual(["GET /api/session/:sid/state", "POST /api/settings", "WEBSOCKET /api/session/:sid/audio/live", "DELETE /api/session/:sid"]);
  });

  it("reports exactly the planted python-only, ts-only and shared routes", () => {
    expect(diffRoutes(python, typescript)).toEqual({
      shared: ["DELETE /api/session/:sid", "GET /api/session/:sid/state"],
      pythonOnly: ["POST /api/settings", "WEBSOCKET /api/session/:sid/audio/live"],
      tsOnly: ["GET /api/health"],
    });
  });
});

describe("command line", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["scripts/port-ledger.ts", ...args], { cwd: REPO_ROOT, encoding: "utf8" });

  it("refuses to run without both revisions", () => {
    const result = run("--head", "HEAD");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--base");
  });

  it("refuses a revision that is not a commit", () => {
    const result = run("--base", "no-such-revision-9999", "--head", "HEAD", "--out", ".audit/ts-native/should-not-exist");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a commit");
  });
});
