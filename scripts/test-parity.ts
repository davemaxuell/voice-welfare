import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { REPO_ROOT } from "../src/core/assets.ts";

const collect = execFileSync("uv", ["run", "pytest", "--collect-only", "-q"], {
  cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
});
const python = new Set<string>();
for (const line of collect.split(/\r?\n/u)) {
  const match = /^tests[\\/].*?::(?:[A-Za-z_][\w]*::)*(test_\w+)(?:\[.*\])?$/u.exec(line);
  if (match?.[1] !== undefined) python.add(match[1]);
}
if (python.size === 0) throw new Error("pytest 수집 결과에 테스트 이름이 없습니다.");

const ported = new Set<string>();
for (const file of globSync("tests/**/*.test.ts", { cwd: REPO_ROOT })) {
  const source = ts.createSourceFile(file, readFileSync(join(REPO_ROOT, file), "utf8"), ts.ScriptTarget.Latest);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const title = node.arguments[0];
      if (title !== undefined && ts.isStringLiteralLike(title) &&
          /^(?:it|test)(?:\.each\([\s\S]*\))?$/u.test(node.expression.getText(source))) ported.add(title.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
for (const missing of [...python].filter((name) => !ported.has(name)).sort((a, b) => a.localeCompare(b, "en"))) console.log(missing);
