import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { models } from "../src/core/assets.ts";
import { PiiModel } from "../src/safety/pii_model.ts";

const pii = {repo: "atonlee/koelectra-ko-pii-ner", revision: "1e75c01e707232401883cf364151bbe2e560c708",
  files: ["onnx/model_int8.onnx", "tokenizer.json", "config.json", "README.md"]};
const piiDir = "koelectra-ko-pii-ner";
const downloads = join(models, ".download");

async function download(model: typeof pii, dest: string, work: string) {
  console.log(`내려받는 중: ${model.repo}@${model.revision.slice(0,8)} (${model.files.length}개 파일)`);
  const token = process.env.HF_TOKEN;
  const headers: HeadersInit = token === undefined || token === "" ? {} : {Authorization: "Bearer " + token};
  // snapshot_download's allow_patterns selects only files present in this exact revision.
  const metadata = await fetch(`https://huggingface.co/api/models/${model.repo}/revision/${model.revision}`, {headers});
  if (!metadata.ok) throw new Error(`${model.repo}@${model.revision}: HTTP ${metadata.status}`);
  const manifest = z.object({sha: z.literal(model.revision), siblings: z.array(z.object({rfilename: z.string()}))}).parse(await metadata.json());
  const available = new Set(manifest.siblings.map(row => row.rfilename));
  for (const file of model.files.filter(name => available.has(name))) {
    const target = join(dest, file);
    if (existsSync(target)) continue;
    await mkdir(dirname(target), {recursive: true});
    const res = await fetch(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`, {headers});
    if (!res.ok || res.body === null) throw new Error(`${model.repo}/${file}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const temporary = join(work, "fetch-" + basename(file));
    const output = await open(temporary, "w");
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await output.writeFile(chunk.value);
      }
    } finally { await output.close(); reader.releaseLock(); }
    await rename(temporary, target);
  }
}

async function publish(directory: string, dest: string, weights: string) {
  await mkdir(dest, {recursive: true});
  const files = await readdir(directory);
  for (const name of [...files.filter(f => f !== weights), weights]) {
    await rename(join(directory, name), join(dest, name));
  }
}

async function setupPii(work: string): Promise<void> {
  const dest = join(models, piiDir);
  if (pii.files.every(file => existsSync(join(dest, basename(file))))) {
    console.log("✓ 개인정보 인식 모델이 이미 있습니다: models/" + piiDir);
    return;
  }
  const src = join(work, "pii-source");
  await download(pii, src, work);
  const stage = join(work, "pii");
  await mkdir(stage);
  for (const file of pii.files) await copyFile(join(src, file), join(stage, basename(file)));
  const model = new PiiModel(stage);
  try { await model.find("모델 확인"); }
  finally { await model.close(); }
  await publish(stage, dest, "model_int8.onnx");
  console.log("✓ 개인정보 인식 모델 준비: models/" + piiDir);
}

async function main(): Promise<number> {
  const usage = "사용법: node scripts/setup-models.ts";
  let args;
  try {
    args = parseArgs({options: {help: {type: "boolean", short: "h"}}}).values;
  } catch { console.error(usage); return 2; }
  if (args.help === true) { console.log(usage); return 0; }
  await mkdir(downloads, {recursive: true});
  const work = await mkdtemp(join(downloads, "setup-"));
  try {
    await setupPii(work);
    await writeFile(join(models, "MODELS.md"), [
      "# 로컬 모델 (scripts/setup-models.ts가 만든 폴더, git에 넣지 않음)", "",
      "| 폴더 | 원본 | 판(commit) | 라이선스·비고 |", "| --- | --- | --- | --- |",
      `| ${piiDir} | [${pii.repo}](https://huggingface.co/${pii.repo}) onnx/model_int8.onnx | \`${pii.revision}\` | Apache-2.0(학습 데이터 CC BY 4.0) |`, "",
    ].join("\n"));
  } finally {
    await rm(work, {recursive: true, force: true});
  }
  console.log(`\n.env에 다음을 넣고 서버를 다시 시작하세요:\nPII_MODEL=models/${piiDir}`);
  return 0;
}

try { process.exitCode = await main(); }
catch (error) { console.error("✗", error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
