import { globSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { REPO_ROOT } from "../../src/core/assets.ts";

const allowed: Record<string, readonly string[]> = {
  cheongeum: [], agents: [], core: [], practice_site: [],
  safety: ["core"], voice: ["core"], understanding: ["core"],
  language: ["core", "safety"], "speech.phrasing": ["core", "safety"],
  personal: ["core", "speech.phrasing"],
  "agents.web": ["core", "safety", "speech.phrasing"],
  "speech.screen": ["agents.web", "core", "safety", "speech.phrasing"],
  "agents.web.skills": ["agents.web", "core", "safety", "speech.phrasing", "speech.screen", "understanding"],
  "agents.welfare": ["core", "safety", "speech.phrasing"],
  evaluation: ["agents.welfare", "core", "safety"],
  orchestrator: ["agents.web", "agents.web.skills", "agents.welfare", "core", "language", "personal", "safety", "speech.phrasing", "speech.screen", "understanding"],
  server: ["agents.web", "agents.welfare", "core", "orchestrator", "personal", "practice_site", "safety", "understanding", "voice"],
};

const src = join(REPO_ROOT, "src");
function layer(path: string): string {
  const [folder, sub, section] = relative(src, path).split(sep);
  if (folder === "agents") {
    if (sub === "web" && section === "skills") return "agents.web.skills";
    return sub === "web" || sub === "welfare" ? "agents." + sub : "agents";
  }
  if (folder === "speech") return sub === "screen.ts" ? "speech.screen" : "speech.phrasing";
  return sub === undefined ? "cheongeum" : folder ?? "cheongeum";
}

function runtimeSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) return;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
      const names = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      if (names !== undefined && (ts.isNamedImports(names) || ts.isNamedExports(names)) &&
          names.elements.length > 0 && names.elements.every((item) => item.isTypeOnly) &&
          !(ts.isImportDeclaration(node) && node.importClause?.name !== undefined)) return;
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const path = node.arguments[0];
      if (path !== undefined && ts.isStringLiteralLike(path)) imports.push(path.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}

it("test_imports_follow_pipeline_layers", () => {
  const errors: string[] = [];
  const openData = join(src, "agents", "welfare", "open_data") + sep;
  for (const rel of globSync("**/*.ts", { cwd: src, exclude: ["cheongeum/**"] })) {
    const file = join(src, rel);
    const from = layer(file);
    expect(allowed[from], rel).toBeDefined();
    for (const spec of runtimeSpecifiers(file).filter((path) => path.startsWith("."))) {
      const target = resolve(dirname(file), spec);
      const to = layer(target);
      if (from !== to && allowed[from]?.includes(to) !== true) errors.push(`${rel}: ${from} → ${to}`);
      if (target === openData + "sync.ts" ||
          (target.startsWith(openData) && !file.startsWith(openData) && basename(target) !== "index.ts")) {
        errors.push(`${rel}: ${spec}`);
      }
    }
  }
  expect(errors).toEqual([]);
});

it("test_layer_table_has_no_cycle", () => {
  const seen = new Set<string>();
  function visit(name: string, trail: string[]) {
    expect(trail, [...trail, name].join(" → ")).not.toContain(name);
    if (seen.has(name)) return;
    for (const dep of allowed[name] ?? []) visit(dep, [...trail, name]);
    seen.add(name);
  }
  for (const name of Object.keys(allowed)) visit(name, []);
});
