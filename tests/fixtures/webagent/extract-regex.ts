// 사용법: node tests/fixtures/webagent/extract-regex.ts <77aad3e 기록 폴더>
// 77aad3e에서 웹 에이전트 파일에 새로 생긴 정규식 자리(같은 식이 다른 파일에 있던 것도)의 Python 일치 구간을 regex.json에 옮긴다.
// tests/fixtures/regex는 통합 담당이 한 번에 바꾸므로 그때까지 이 파일이 새 정규식의 기준이다.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const source = process.argv[2];
if (source === undefined) throw new Error("77aad3e 기록 폴더를 주세요");
const owned = /^src\/cheongeum\/(agents\/web\/|speech\/(screen|picture)\.py$)/u;
const row = z.object({ id: z.string(), sites: z.array(z.tuple([z.string(), z.int()])) }).loose();
const rows = (path: string) => readFileSync(path, "utf8").trimEnd().split("\n").map(line => row.parse(JSON.parse(line)));
const known = new Set(rows(fileURLToPath(new URL("../regex/patterns.jsonl", import.meta.url)))
  .flatMap(pattern => pattern.sites.map(([file]) => `${pattern.id} ${file}`)));
const corpus: unknown = JSON.parse(readFileSync(join(source, "regex", "corpus.json"), "utf8"));
const patterns = rows(join(source, "regex", "patterns.jsonl"))
  .filter(pattern => pattern.sites.some(([file]) => owned.test(file) && !known.has(`${pattern.id} ${file}`)));
writeFileSync(new URL("regex.json", import.meta.url), JSON.stringify({ corpus, patterns }) + "\n");
