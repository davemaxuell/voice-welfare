import { existsSync, globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import { REPO_ROOT } from "../src/core/assets.ts";
import { reference } from "./port-manifest.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { exceptions: { type: "string" }, extra: { type: "boolean" } } });
const collect = readFileSync(positionals[0] === undefined ? join(REPO_ROOT, reference.collection) : resolve(positionals[0]), "utf8");
const python = new Set<string>();
for (const line of collect.split(/\r?\n/u)) {
  const match = /^tests[\\/].*?::(?:[A-Za-z_][\w]*::)*(test_\w+)(?:\[.*\])?$/u.exec(line);
  if (match?.[1] !== undefined) python.add(match[1]);
}
if (python.size === 0) throw new Error("pytest 수집 결과에 테스트 이름이 없습니다.");

// 소유자가 뺀 동작의 Python 테스트 이름과 이유. 줄마다 이름, 탭, 이유이고 #으로 시작하는 줄은 설명이다.
const exceptionsPath = values.exceptions === undefined ? join(REPO_ROOT, "scripts/migration/parity-exceptions.tsv") : resolve(values.exceptions);
const excepted = new Set<string>();
if (existsSync(exceptionsPath)) {
  for (const line of readFileSync(exceptionsPath, "utf8").split(/\r?\n/u)) {
    const name = line.split("\t")[0];
    if (name !== undefined && name !== "" && !name.startsWith("#")) excepted.add(name);
  }
}
const unknown = [...excepted].filter(name => !python.has(name));
if (unknown.length > 0) throw new Error(`예외 목록에 pytest 수집 결과에 없는 이름이 있습니다: ${unknown.join(", ")}`);

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
const byName = (a: string, b: string) => a.localeCompare(b, "en");
if (values.extra === true) {
  for (const title of [...ported].filter(name => /^test_\w+$/u.test(name) && !python.has(name)).sort(byName)) console.log(title);
} else {
  const missing = [...python].filter(name => !ported.has(name) && !excepted.has(name)).sort(byName);
  for (const name of missing) console.log(name);
  if (missing.length > 0) process.exitCode = 1;
}
