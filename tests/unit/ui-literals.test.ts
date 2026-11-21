import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import allowed from "./ui-literals.allow.json" with { type: "json" };
import { loadWorkspaceLanguage, workspaceText } from "../../web/src/workspace-language.ts";
import { onboardingText } from "../../web/src/onboarding.ts";

const hangul = /[ᄀ-ᇿ㄰-㆏가-힯]/u;
const catalogs = new Set(["web/src/workspace-language.ts", "web/src/workspace-extra-text.ts", "web/src/onboarding-text.ts", "web/src/first-run-text.ts",
  "web/src/workflows-text.ts", "web/src/recording-review-text.ts", "apps/desktop/src/text.ts"]);
const matchCalls = new Set(["includes", "startsWith", "endsWith", "match", "test", "indexOf", "exec", "split"]);
const keyTables = new Set(["STARTERS", "EXAMPLES", "PHASE_LABELS", "APPROVE_PROMPTS", "APPROVE_LABELS", "AUTH_PROMPTS", "MODES", "UNSUPPORTED", "ROLE_LABELS", "ORIGIN_LABELS"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = dir + "/" + entry.name;
    return entry.isDirectory() ? sourceFiles(file) : /(?<!\.d)\.tsx?$/u.test(file) ? [file] : [];
  });
}

function isCatalogKey(text: string) {
  return ["en", "zh", "ja"].every(lang => workspaceText(text, lang) !== text);
}

function routed(node: ts.Node, text: string) {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isPropertyAssignment(parent) && parent.name.getText() === "ko") return true;
    if (ts.isCallExpression(parent)) {
      const name = parent.expression.getText().split(".").at(-1) ?? "";
      if (["t", "workspaceText"].includes(name)) return isCatalogKey(text);
      if (name === "o" || name === "onboardingText") {
        const key = parent.arguments[name === "o" ? 0 : 1];
        return key !== undefined && ts.isStringLiteral(key) && ["en", "zh", "ja"].every(lang => onboardingText(lang, key.text, text) !== text);
      }
      if (matchCalls.has(name) || name === "send" || name === "submitCommand") return true;
      break;
    }
    if (ts.isBinaryExpression(parent) && ["===", "!==", "==", "!="].includes(parent.operatorToken.getText())) return true;
    if (ts.isCaseClause(parent) && parent.expression === node) return true;
    if (ts.isVariableDeclaration(parent)) {
      const name = parent.name.getText();
      if (keyTables.has(name)) return isCatalogKey(text);
      if (["BROWSERS", "DEVICES", "SPEEDS"].includes(name) && ts.isArrayLiteralExpression(node.parent)) {
        const key = node.parent.elements[1];
        return key !== undefined && ts.isStringLiteral(key) && ["en", "zh", "ja"].every(lang => onboardingText(lang, key.text, text) !== text);
      }
    }
  }
  return false;
}

it("화면·음성 문구는 네 언어의 번역표를 거치며 예외는 실제로 남아 있다", async () => {
  await loadWorkspaceLanguage("en");
  const hits: { file: string; text: string }[] = [];
  const record = (file: string, text: string) => hits.push({ file, text: text.replace(/\s+/gu, " ").trim() });
  for (const file of [...sourceFiles("web/src"), ...sourceFiles("apps/desktop/src"), "web/index.html", "web/avatar/index.html"]) {
    if (catalogs.has(file)) continue;
    const source = readFileSync(join(process.cwd(), file), "utf8");
    if (file.endsWith(".html")) {
      for (const match of source.replace(/<!--[\s\S]*?-->/gu, "").matchAll(/>([^<>]+)<|[\w:-]+="([^"]+)"/gu)) {
        const text = match[1] ?? match[2] ?? "";
        if (hangul.test(text)) record(file, text);
      }
      continue;
    }
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const text = ts.isStringLiteralLike(node) || ts.isJsxText(node) ? node.text
        : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map(span => "${…}" + span.literal.text).join("") : "";
      if (hangul.test(text) && !routed(node, text)) record(file, text);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const id = (v: { file: string; text: string }) => v.file + " | " + v.text;
  expect(hits.map(id).sort((a, b) => a.localeCompare(b))).toEqual(allowed.map(id).sort((a, b) => a.localeCompare(b)));
  expect(allowed).toHaveLength(7);
});
