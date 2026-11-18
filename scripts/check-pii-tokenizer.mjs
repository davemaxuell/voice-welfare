import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pythonCommand } from "../src/core/python.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Tokenizer } from "@huggingface/tokenizers";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const corpusPath = join(root, "tests/fixtures/regex/corpus.json");
const model = resolve(process.env.PII_MODEL ?? join(root, "models/koelectra-ko-pii-ner"), "tokenizer.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const [command, ...args] = pythonCommand("-c", `
import json, sys
from pathlib import Path
from tokenizers import Tokenizer
tokenizer = Tokenizer.from_file(sys.argv[1])
tokenizer.no_padding()
tokenizer.enable_truncation(max_length=512)
texts = json.loads(Path(sys.argv[2]).read_text(encoding="utf8"))
print(json.dumps([[e.ids, e.offsets] for e in tokenizer.encode_batch(texts)]))
`, model, corpusPath);
const reference = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, cwd: root });
if (reference.error) throw reference.error;
if (reference.status !== 0) throw new Error(reference.stderr);
const expected = JSON.parse(reference.stdout);
const js = new Tokenizer(JSON.parse(readFileSync(model, "utf8")), {});
let idDifferences = 0;
let offsetDifferences = 0;
let missingOffsets = 0;
for (const [index, text] of corpus.entries()) {
  const actual = js.encode(text, { return_offsets_mapping: true });
  const offsets = actual.offsets ?? actual.offset_mapping;
  const [ids, spans] = expected[index];
  if (!isDeepStrictEqual(actual.ids, ids)) idDifferences++;
  if (!isDeepStrictEqual(offsets, spans)) offsetDifferences++;
  if (offsets === undefined) missingOffsets++;
}
const result = { inputs: corpus.length, idDifferences, offsetDifferences, missingOffsets };
console.log(JSON.stringify(result));
if (idDifferences || offsetDifferences) {
  const decisions = JSON.parse(readFileSync(join(root, "tests/fixtures/oracle/adopt-js.json"), "utf8"));
  const adopted = decisions.find(entry => entry.kind === "pii-tokenizer");
  if (!isDeepStrictEqual(adopted?.comparison, result) || adopted.runtime !== "python-sidecar") {
    process.exitCode = 1;
  }
}
