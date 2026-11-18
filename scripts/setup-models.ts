import { spawnSync } from "node:child_process";
import { pythonCommand, pythonProject } from "../src/core/python.ts";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT, models } from "../src/core/assets.ts";
import { PiiModel } from "../src/safety/pii_model.ts";
import { LocalWhisperStt } from "../src/voice/stt_local.ts";

const stt = {
  repo: "seastar105/whisper-small-komixv2", revision: "bb0a94da846d5d1b7001bb90810dea630a333084",
  files: ["config.json", "generation_config.json", "preprocessor_config.json", "model.safetensors", "vocab.json", "merges.txt",
    "added_tokens.json", "special_tokens_map.json", "tokenizer_config.json", "normalizer.json"],
};
const pii = {repo: "atonlee/koelectra-ko-pii-ner", revision: "1e75c01e707232401883cf364151bbe2e560c708",
  files: ["onnx/model_int8.onnx", "tokenizer.json", "config.json", "README.md"]};
const sttDir = "whisper-small-komixv2-ct2", piiDir = "koelectra-ko-pii-ner";
const downloads = join(models, ".download");

async function download(model: typeof stt, dest: string, work: string) {
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
  if (PiiModel.available(dest)) { console.log("✓ 개인정보 인식 모델이 이미 있습니다: models/" + piiDir); return; }
  const src = join(work, "pii-source");
  await download(pii, src, work);
  const stage = join(work, "pii");
  await mkdir(stage);
  for (const file of pii.files) await copyFile(join(src, file), join(stage, basename(file)));
  const model = new PiiModel(stage);
  try { await model.secretSpans(["모델 확인"]); }
  finally { await model.close(); }
  await publish(stage, dest, "model_int8.onnx");
  console.log("✓ 개인정보 인식 모델 준비: models/" + piiDir);
}

async function setupStt(work: string, keep: boolean): Promise<void> {
  const dest = join(models, sttDir);
  if (LocalWhisperStt.available(dest)) { console.log("✓ 받아쓰기 모델이 이미 있습니다: models/" + sttDir); return; }
  const src = keep ? join(downloads, "whisper-small-komixv2", stt.revision) : join(work, "whisper-small-komixv2");
  await download(stt, src, work);
  const [command, ...args] = pythonCommand("-c", "from importlib.metadata import version;print(version('ctranslate2'))");
  const probe = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  if (probe.error) throw probe.error;
  if (probe.status !== 0 || probe.stdout.trim().length === 0) throw new Error("받아쓰기 실행 환경의 CTranslate2 판을 확인할 수 없습니다.");
  const version = probe.stdout.trim();
  console.log(`변환 중(CTranslate2 ${version}, int8). 처음에는 transformers·torch를 임시로 받느라 몇 분 걸립니다…`);
  const stage = join(work, "stt");
  const converter = join(pythonProject, "convert_whisper_ct2.py");
  const converted = spawnSync("uv", ["run", "--no-project", "--with", "ctranslate2==" + version, "--with", "transformers",
    "--with", "torch", "python", converter, src, stage], {cwd: REPO_ROOT, stdio: "inherit", windowsHide: true});
  if (converted.error) throw converted.error;
  if (converted.status !== 0 || !LocalWhisperStt.available(stage)) throw new Error("받아쓰기 모델 변환에 실패했습니다.");
  await publish(stage, dest, "model.bin");
  console.log("✓ 받아쓰기 모델 준비: models/" + sttDir);
}

async function main(): Promise<number> {
  const usage = "사용법: node scripts/setup-models.ts [--only stt|pii] [--keep-download]";
  let args;
  try {
    args = parseArgs({options: {only: {type: "string"}, "keep-download": {type: "boolean"}, help: {type: "boolean", short: "h"}}}).values;
  } catch { console.error(usage); return 2; }
  if (args.help === true) { console.log(usage); return 0; }
  if (args.only !== undefined && args.only !== "stt" && args.only !== "pii") { console.error(usage); return 2; }
  await mkdir(downloads, {recursive: true});
  const work = await mkdtemp(join(downloads, "setup-"));
  try {
    if (args.only !== "stt") await setupPii(work);
    if (args.only !== "pii") await setupStt(work, args["keep-download"] === true);
    await writeFile(join(models, "MODELS.md"), [
      "# 로컬 모델 (scripts/setup-models.ts가 만든 폴더, git에 넣지 않음)", "",
      "| 폴더 | 원본 | 판(commit) | 라이선스·비고 |", "| --- | --- | --- | --- |",
      `| ${sttDir} | [${stt.repo}](https://huggingface.co/${stt.repo}) → CTranslate2 int8 | \`${stt.revision}\` | 프로젝트 팀이 함께 만든 모델(사용 확인됨). 학습 데이터: AI Hub 한국어 음성 |`,
      `| ${piiDir} | [${pii.repo}](https://huggingface.co/${pii.repo}) onnx/model_int8.onnx | \`${pii.revision}\` | Apache-2.0(학습 데이터 CC BY 4.0) |`, "",
    ].join("\n"));
  } finally {
    await rm(work, {recursive: true, force: true});
  }
  console.log(`\n.env에 다음을 넣고 서버를 다시 시작하세요:\nSTT_PROVIDER=local\nSTT_LOCAL_MODEL=models/${sttDir}\nSTT_MODEL=gpt-4o-mini-transcribe   # 한국어 외 언어(영어·중국어·일본어)만 OpenAI로\nPII_MODEL=models/${piiDir}`);
  return 0;
}

try { process.exitCode = await main(); }
catch (error) { console.error("✗", error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
