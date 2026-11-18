import childProcess from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { REPO_ROOT } from "../core/assets.ts";
import { pythonCommand, pythonProject } from "../core/python.ts";
import { privacyPatterns, type SecretSpan, type SensitiveKind } from "./privacy.ts";

const tier1 = new Map<string, SensitiveKind>([
  ["SECRET", "password"], ["RRN", "rrn"], ["ALIEN_ID", "rrn"], ["ACCOUNT_NUMBER", "account"],
  ["CARD_NUMBER", "card"], ["CARD_EXPIRY", "card"], ["CVC", "card"], ["PASSPORT", "idnum"],
  ["DRIVER_LICENSE", "idnum"], ["IPIN", "idnum"],
]);
const tagSchema = z.tuple([z.string(), z.number().min(0).max(1), z.int().nonnegative(), z.int().positive()]);
const responseSchema = z.array(z.array(z.array(tagSchema)).nullable());

export type BioTag = readonly [tag: string, probability: number, start: number, end: number];
export interface PiiSpan { label: string; start: number; end: number; score: number }

export function mergeBio(tags: readonly BioTag[]): PiiSpan[] {
  const spans: PiiSpan[] = [];
  let current: PiiSpan | undefined;
  let count = 0;
  const finish = () => {
    if (current !== undefined) {
      current.score /= count;
      spans.push(current);
      current = undefined;
    }
  };
  for (const [tag, score, start, end] of tags) {
    const separator = tag.indexOf("-");
    if (separator < 0) {
      finish();
      continue;
    }
    const label = tag.slice(separator + 1);
    if (current !== undefined && current.label === label && tag.slice(0, separator) === "I") {
      current.end = end;
      current.score += score;
      count++;
    } else {
      finish();
      current = { label, score, start, end };
      count = 1;
    }
  }
  finish();
  return spans;
}

export interface PiiBatchModel {
  secretSpans(texts: readonly string[]): Promise<readonly (readonly SecretSpan[] | null)[]>;
}

function openWorker(directory: string) {
  const [command, ...args] = pythonCommand("-u", join(pythonProject, "cheongeum_stt", "pii.py"), directory);
  const child = childProcess.spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], cwd: REPO_ROOT, windowsHide: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = lines[Symbol.asyncIterator]();
  child.on("error", () => lines.close());
  child.stdin.on("error", () => lines.close());
  const closed = new Promise<void>(done => child.once("close", () => done()));
  return { child, responses, closed };
}

function envThreshold(): number {
  const value = Number(process.env.PII_THRESHOLD);
  return Number.isFinite(value) && value !== 0 ? value : 0.5;
}

export class PiiModel implements PiiBatchModel {
  readonly #directory: string;
  readonly #threshold: number;
  #worker?: ReturnType<typeof openWorker>;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(directory: string, threshold = envThreshold()) {
    this.#directory = resolve(directory);
    this.#threshold = threshold;
  }

  static available(directory: string): boolean {
    const file = (name: string) => statSync(join(directory, name), { throwIfNoEntry: false })?.isFile() === true;
    return file("tokenizer.json") && file("config.json") && ["model_int8.onnx", "model_quantized.onnx", "model.onnx"].some(file);
  }

  secretSpans(texts: readonly string[]): Promise<(SecretSpan[] | null)[]> {
    const request = this.#tail.then(() => this.#exchange(texts));
    this.#tail = request.then(() => {}, () => {});
    return request;
  }

  async #exchange(texts: readonly string[]): Promise<(SecretSpan[] | null)[]> {
    if (this.#closed) throw new Error("PII model is closed");
    if (this.#worker === undefined || this.#worker.child.exitCode !== null || this.#worker.child.signalCode !== null) {
      this.#worker = openWorker(this.#directory);
    }
    const worker = this.#worker;
    try {
      await new Promise<void>((done, fail) => worker.child.stdin.write(JSON.stringify(texts) + "\n", error => {
        if (error != null) fail(error);
        else done();
      }));
      const line = await worker.responses.next();
      if (line.done === true) throw new Error("PII sidecar exited before sending a response");
      const batch = responseSchema.parse(JSON.parse(line.value));
      if (batch.length !== texts.length) throw new Error("PII sidecar returned an incomplete batch");
      return batch.map((windows, index) => {
        if (windows === null) return null;
        const size = Array.from(texts[index]!).length;
        const spans: SecretSpan[] = [];
        for (const tags of windows) {
          for (const [, , start, end] of tags) {
            if (end <= start || end > size) throw new Error("PII sidecar returned invalid code-point offsets");
          }
          for (const { label, start, end, score } of mergeBio(tags)) {
            const kind = tier1.get(label);
            if (kind !== undefined && score >= this.#threshold) spans.push([kind, start, end]);
          }
        }
        return spans;
      });
    } catch (error) {
      this.#worker = undefined;
      worker.child.kill();
      await worker.closed;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const worker = this.#worker;
    if (worker !== undefined) {
      worker.child.stdin.end();
      await worker.closed;
    }
    await this.#tail;
    this.#worker = undefined;
  }
}

/** 마지막으로 검사한 묶음의 결과를 다시 쓴다. 모델을 쓰는 경계에서만 기다린다. */
export class PiiScanner {
  readonly #model?: PiiBatchModel;
  #cache = new Map<string, readonly SecretSpan[]>();
  #tail: Promise<void> = Promise.resolve();

  constructor(model?: PiiBatchModel) { this.#model = model; }

  scan(texts: readonly string[]): Promise<(readonly SecretSpan[])[]> {
    const request = this.#tail.then(() => this.#scan(texts));
    this.#tail = request.then(() => {}, () => {});
    return request;
  }

  async #scan(texts: readonly string[]): Promise<(readonly SecretSpan[])[]> {
    const model = this.#model;
    if (model === undefined) return texts.map(() => []);
    const korean = new Set(texts.filter(text => privacyPatterns.hangul.test(text)));
    const missing = [...korean].filter(text => !this.#cache.has(text));
    if (missing.length > 0) {
      try {
        const result = await model.secretSpans(missing);
        if (result.length !== missing.length) throw new Error("Incomplete PII batch");
        const next = new Map([...this.#cache].filter(([text]) => korean.has(text)));
        for (const [index, spans] of result.entries()) {
          if (spans !== null) next.set(missing[index]!, spans);
        }
        this.#cache = next;
      } catch {
        // 발화나 예외 메시지에 가릴 내용이 들어 있을 수 있어 고정된 문구만 기록한다.
        process.stderr.write("[privacy] 개인정보 모델 오류 → 규칙만 사용\n");
      }
    }
    return texts.map(text => this.#cache.get(text) ?? []);
  }
}
