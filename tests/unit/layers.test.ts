import { globSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
const openData = join(src, "agents", "welfare", "open_data") + sep;
const openDataIndex = openData + "index.ts";
function layer(path: string): string {
  const [folder, sub, section] = relative(src, path).split(sep);
  if (folder === "agents") {
    if (sub === "web" && section === "skills") return "agents.web.skills";
    return sub === "web" || sub === "welfare" ? "agents." + sub : "agents";
  }
  if (folder === "speech") return sub === "screen.ts" ? "speech.screen" : "speech.phrasing";
  return sub === undefined ? "cheongeum" : folder ?? "cheongeum";
}

interface Import {
  specifier: string;
  names: readonly string[];
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
}

/** 불러오는 글자와 이름. 타입만 가져오는 것은 includeTypes일 때만 센다(Python의 TYPE_CHECKING 안 가져오기). */
function imports(file: string, { includeTypes }: { includeTypes: boolean }): Import[] {
  const found: Import[] = [];
  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly === true : node.isTypeOnly;
      const clause = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause;
      const bindings = clause !== undefined && (ts.isNamedImports(clause) || ts.isNamedExports(clause)) ? clause.elements : [];
      const allTypes = bindings.length > 0 && bindings.every((item) => item.isTypeOnly) &&
        !(ts.isImportDeclaration(node) && node.importClause?.name !== undefined);
      if ((includeTypes || (!typeOnly && !allTypes)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push({ specifier: node.moduleSpecifier.text, names: bindings.map((item) => (item.propertyName ?? item.name).text) });
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const path = node.arguments[0];
      if (path !== undefined && ts.isStringLiteralLike(path)) found.push({ specifier: path.text, names: [] });
    }
    ts.forEachChild(node, visit);
  }
  visit(parse(file));
  return found;
}

/** 파일이 내보내는 이름(Python의 __all__ 에 해당한다). */
function exportedNames(file: string): Set<string> {
  const names = new Set<string>();
  for (const statement of parse(file).statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) names.add(item.name.text);
      }
    } else if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) === true) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      } else if ((ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) && statement.name !== undefined) {
        names.add(statement.name.text);
      }
    }
  }
  return names;
}

function relativeImports(includeTypes: boolean) {
  return globSync("**/*.ts", { cwd: src }).flatMap((rel) => {
    const file = join(src, rel);
    return imports(file, { includeTypes })
      .filter(({ specifier }) => specifier.startsWith("."))
      .map(({ specifier, names }) => ({ rel, file, specifier, names, target: resolve(dirname(file), specifier) }));
  });
}

it("test_imports_follow_pipeline_layers", () => {
  const errors: string[] = [];
  for (const rel of globSync("**/*.ts", { cwd: src })) expect(allowed[layer(join(src, rel))], rel).toBeDefined();
  for (const { rel, file, specifier, target } of relativeImports(false)) {
    const from = layer(file);
    const to = layer(target);
    if (from !== to && allowed[from]?.includes(to) !== true) errors.push(`${rel}: ${from} → ${to} (${specifier})`);
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

it("test_only_sync_command_imports_snapshot_writer", () => {
  const importers = relativeImports(true).filter(({ target }) => target === openData + "sync.ts");
  expect(importers.map(({ rel }) => rel)).toEqual([]);
});

it("test_snapshot_consumers_use_public_interface", () => {
  const exported = exportedNames(openDataIndex);
  expect(exported.has("OpenData")).toBe(true);
  const consumers = relativeImports(true).filter(({ file }) => !file.startsWith(openData) && resolve(file) !== openDataIndex);
  const deep = consumers.filter(({ target }) => target.startsWith(openData) && target !== openDataIndex);
  expect(deep.map(({ rel, specifier }) => `${rel}: ${specifier}`)).toEqual([]);
  const notPublic = consumers.filter(({ target }) => target === openDataIndex)
    .flatMap(({ rel, names }) => names.filter((name) => !exported.has(name)).map((name) => `${rel}: ${name}`));
  expect(notPublic).toEqual([]);
});
