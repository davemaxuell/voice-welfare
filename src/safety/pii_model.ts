import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import type { InferenceSession, Tensor } from "onnxruntime-node";
import { z } from "zod";
import { privacyPatterns, type SecretSpan, type SensitiveKind } from "./privacy.ts";

const tier1 = new Map<string, SensitiveKind>([
  ["SECRET", "password"], ["RRN", "rrn"], ["ALIEN_ID", "rrn"], ["ACCOUNT_NUMBER", "account"],
  ["CARD_NUMBER", "card"], ["CARD_EXPIRY", "card"], ["CVC", "card"], ["PASSPORT", "idnum"],
  ["DRIVER_LICENSE", "idnum"], ["IPIN", "idnum"],
]);
const ONNX_FILES = ["model_int8.onnx", "model_quantized.onnx", "model.onnx"];
// 한 번에 보는 글 길이(코드 포인트). 토큰 한도(512)를 넘지 않도록 넉넉히 자른다.
const WINDOW_CHARS = 200;

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

// The Rust BertNormalizer and BertPreTokenizer classify characters with older Unicode tables than Node's ICU.
// These sets are the differences, read from tokenizers 0.23.3. tests/fixtures/pii/char-classes.json checks every code point.
const keptFormat = /[\u{0890}\u{0891}\u{08E2}\u{110CD}\u{13430}-\u{1343F}]/u;
const newerPunctuation = /[\u{061D}\u{09FD}\u{0A76}\u{0C77}\u{0C84}\u{1B4E}-\u{1B4F}\u{1B7D}-\u{1B7F}\u{2E43}-\u{2E4F}\u{2E52}-\u{2E5D}\u{10D6E}\u{10EAD}\u{10ED0}\u{10F55}-\u{10F59}\u{10F86}-\u{10F89}\u{113D4}-\u{113D5}\u{113D7}-\u{113D8}\u{1144B}-\u{1144F}\u{1145A}-\u{1145B}\u{1145D}\u{11660}-\u{1166C}\u{116B9}\u{1183B}\u{11944}-\u{11946}\u{119E2}\u{11A3F}-\u{11A46}\u{11A9A}-\u{11A9C}\u{11A9E}-\u{11AA2}\u{11B00}-\u{11B09}\u{11BE1}\u{11C41}-\u{11C45}\u{11C70}-\u{11C71}\u{11EF7}-\u{11EF8}\u{11F43}-\u{11F4F}\u{11FFF}\u{12FF1}-\u{12FF2}\u{16D6D}-\u{16D6F}\u{16E97}-\u{16E9A}\u{16FE2}\u{1E5FF}\u{1E95E}-\u{1E95F}]/u;
const olderPunctuation = /[\u{166D}\u{111C9}]/u;
const asciiPunctuation = /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/u;
// Rust's is_chinese_char ranges, including its 0x2B920 start for extension E.
const chinese = /[\u{4E00}-\u{9FFF}\u{3400}-\u{4DBF}\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u{2B920}-\u{2CEAF}\u{F900}-\u{FAFF}\u{2F800}-\u{2FA1F}]/u;

/** What the model's tokenizer does with one character: drop it, end a word, stand as its own word, or join the word. */
export type BertCharClass = "removed" | "space" | "alone" | "char";

export function bertCharClass(char: string): BertCharClass {
  if (char === "\u{FFFD}" || (/[\p{Cc}\p{Cf}\p{Co}]/u.test(char) && !/[\t\n\r]/u.test(char) && !keptFormat.test(char))) return "removed";
  if (/\s/u.test(char)) return "space";
  if (chinese.test(char) || asciiPunctuation.test(char) || olderPunctuation.test(char)) return "alone";
  return /\p{P}/u.test(char) && !newerPunctuation.test(char) ? "alone" : "char";
}

const templateSpecial = z.object({ SpecialToken: z.object({ id: z.string(), type_id: z.literal(0) }) });
const tokenizerFile = z.looseObject({
  added_tokens: z.array(z.object({
    id: z.int().nonnegative(), content: z.string().min(1),
    single_word: z.literal(false), lstrip: z.literal(false), rstrip: z.literal(false), normalized: z.literal(false),
  })),
  normalizer: z.object({
    type: z.literal("BertNormalizer"), clean_text: z.literal(true), handle_chinese_chars: z.literal(true),
    strip_accents: z.literal(false).nullable(), lowercase: z.literal(false),
  }),
  pre_tokenizer: z.object({ type: z.literal("BertPreTokenizer") }),
  post_processor: z.object({
    type: z.literal("TemplateProcessing"),
    single: z.tuple([templateSpecial, z.object({ Sequence: z.object({ id: z.literal("A"), type_id: z.literal(0) }) }), templateSpecial]),
    special_tokens: z.record(z.string(), z.object({ ids: z.tuple([z.int().nonnegative()]) })),
  }),
  model: z.looseObject({ type: z.literal("WordPiece"), unk_token: z.string(), continuing_subword_prefix: z.string().min(1) }),
});
const configFile = z.object({ id2label: z.record(z.string().regex(/^\d+$/u), z.string()) });

/** Code-point offsets inside one window, as Python's tokenizers reports them. */
interface Token { readonly id: number; readonly start: number; readonly end: number }
// @huggingface/tokenizers ships declarations that do not resolve under NodeNext, so its results are checked here.
interface TokenizersJs { readonly model?: { encode(words: string[]): unknown } | null; token_to_id(token: string): unknown }
const pieceList = z.array(z.string()).min(1);

function windowEncoder(file: z.infer<typeof tokenizerFile>) {
  const tokenizer: TokenizersJs = new Tokenizer(file, {});
  const wordPiece = tokenizer.model;
  if (wordPiece === undefined || wordPiece === null) throw new Error("tokenizer.json has no model");
  const idOf = (token: string) => {
    const id = tokenizer.token_to_id(token);
    if (typeof id !== "number") throw new Error("token is not in the vocabulary");
    return id;
  };
  const { unk_token: unk, continuing_subword_prefix: prefix } = file.model;
  const unkId = idOf(unk);
  const specialId = (template: z.infer<typeof templateSpecial>) => {
    const entry = file.post_processor.special_tokens[template.SpecialToken.id];
    if (entry === undefined) throw new Error("template names an unknown special token");
    return entry.ids[0];
  };
  const [first, , last] = file.post_processor.single;
  // Rust matches added tokens in the raw text before normalizing, leftmost and then longest.
  const added = file.added_tokens.map(token => ({ id: token.id, points: Array.from(token.content) }))
    .sort((a, b) => b.points.length - a.points.length);

  const encode = (chunk: readonly string[]): Token[] => {
    const tokens: Token[] = [];
    let word: number[] = [];
    const flush = () => {
      const start = word[0], end = word.at(-1);
      if (start === undefined || end === undefined) return;
      const pieces = pieceList.parse(wordPiece.encode([word.map(at => chunk[at]).join("")]));
      if (pieces.length === 1 && pieces[0] === unk) {
        tokens.push({ id: unkId, start, end: end + 1 });
      } else {
        let covered = 0;
        for (const [index, piece] of pieces.entries()) {
          if (index > 0 && !piece.startsWith(prefix)) throw new Error("WordPiece continuation has no prefix");
          const size = Array.from(index === 0 ? piece : piece.slice(prefix.length)).length;
          const from = word[covered], to = word[covered + size - 1];
          if (from === undefined || to === undefined || size === 0) throw new Error("WordPiece pieces do not cover the word");
          tokens.push({ id: idOf(piece), start: from, end: to + 1 });
          covered += size;
        }
        if (covered !== word.length) throw new Error("WordPiece pieces do not cover the word");
      }
      word = [];
    };
    for (let at = 0; at < chunk.length;) {
      const match = added.find(token => token.points.every((point, k) => chunk[at + k] === point));
      if (match !== undefined) {
        flush();
        tokens.push({ id: match.id, start: at, end: at + match.points.length });
        at += match.points.length;
        continue;
      }
      const char = chunk[at] ?? "";
      // Python's tokenizers cannot encode a lone surrogate either, so that text falls back to the rules.
      if (/\p{Cs}/u.test(char)) throw new Error("lone surrogate");
      const kind = bertCharClass(char);
      if (kind === "space" || kind === "alone") flush();
      if (kind === "alone" || kind === "char") word.push(at);
      if (kind === "alone") flush();
      at++;
    }
    flush();
    return tokens;
  };
  return { encode, first: specialId(first), last: specialId(last) };
}

/** Python str.rfind(" ", start, end). */
function lastSpace(points: readonly string[], start: number, end: number): number {
  for (let at = end - 1; at >= start; at--) if (points[at] === " ") return at;
  return -1;
}

/** (시작 위치, 조각). 가능하면 공백에서 자른다. 위치는 코드 포인트다. */
function windows(points: readonly string[]): Array<readonly [number, readonly string[]]> {
  const out: Array<readonly [number, readonly string[]]> = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(points.length, start + WINDOW_CHARS);
    if (end < points.length) {
      const space = lastSpace(points, start + Math.floor(WINDOW_CHARS / 2), end);
      end = space > start ? space : end;
    }
    out.push([start, points.slice(start, end)]);
    start = end;
  }
  return out;
}

type Runtime = typeof import("onnxruntime-node");
interface Loaded {
  readonly runtime: Runtime;
  readonly session: InferenceSession;
  readonly labels: ReadonlyMap<number, string>;
  readonly encoder: ReturnType<typeof windowEncoder>;
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

function runtimeInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
}

async function open(directory: string): Promise<Loaded> {
  const onnx = ONNX_FILES.map(name => join(directory, name)).find(isFile);
  if (onnx === undefined) throw new Error("no ONNX model file");
  const encoder = windowEncoder(tokenizerFile.parse(JSON.parse(await readFile(join(directory, "tokenizer.json"), "utf8"))));
  const config = configFile.parse(JSON.parse(await readFile(join(directory, "config.json"), "utf8")));
  const labels = new Map(Object.entries(config.id2label).map(([id, label]) => [Number(id), label]));
  const runtime = await import("onnxruntime-node");
  const session = await runtime.InferenceSession.create(onnx, { logSeverityLevel: 3, executionProviders: ["cpu"] });
  return { runtime, session, labels, encoder };
}

async function allSpans(model: Loaded, text: string): Promise<PiiSpan[]> {
  const { runtime, session, labels, encoder } = model;
  const spans: PiiSpan[] = [];
  for (const [base, chunk] of windows(Array.from(text))) {
    const tokens = encoder.encode(chunk);
    const ids = [encoder.first, ...tokens.map(token => token.id), encoder.last];
    const shape = [1, ids.length];
    const feeds: Record<string, Tensor> = { input_ids: new runtime.Tensor("int64", BigInt64Array.from(ids, BigInt), shape) };
    if (session.inputNames.includes("attention_mask")) feeds.attention_mask = new runtime.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape);
    if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new runtime.Tensor("int64", new BigInt64Array(ids.length), shape);
    const output = (await session.run(feeds))[session.outputNames[0] ?? ""];
    const width = output?.dims[2];
    if (output === undefined || !(output.data instanceof Float32Array) || width === undefined || output.data.length !== ids.length * width) {
      throw new Error("unexpected logits");
    }
    const logits = output.data;
    const tags = tokens.map((token, index): BioTag => {
      const row = logits.subarray((index + 1) * width, (index + 2) * width);
      let best = 0, top = -Infinity;
      for (const [label, value] of row.entries()) if (value > top) [best, top] = [label, value];
      let sum = 0;
      for (const value of row) sum += Math.exp(value - top);
      return [labels.get(best) ?? "O", 1 / sum, base + token.start, base + token.end];
    });
    spans.push(...mergeBio(tags));
  }
  return spans;
}

function envThreshold(): number {
  const value = Number(process.env.PII_THRESHOLD);
  return Number.isFinite(value) && value !== 0 ? value : 0.5;
}

/** onnxruntime-node + tokenizer.json. 처음 쓸 때 불러온다(load()로 미리 불러올 수 있다). 불러오지 못하면 규칙만 쓴다. */
export class PiiModel implements PiiBatchModel {
  readonly #directory: string;
  readonly #threshold: number;
  #loaded?: Promise<Loaded>;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(directory: string, threshold = envThreshold()) {
    this.#directory = resolve(directory);
    this.#threshold = threshold;
  }

  /** 모델 파일이 있고 onnxruntime-node가 설치돼 있을 때만 true. 아니면 규칙만 쓴다. */
  static available(directory: string): boolean {
    const file = (name: string) => isFile(join(directory, name));
    return file("tokenizer.json") && file("config.json") && ONNX_FILES.some(file) && runtimeInstalled();
  }

  load(): Promise<void> {
    return this.#serial(async () => { await this.#model(); });
  }

  /** 모든 개체(2등급 포함). 위치는 text의 코드 포인트 기준. */
  find(text: string): Promise<PiiSpan[]> {
    return this.#serial(async () => this.#find(await this.#model(), text));
  }

  /** 1등급만 (종류, 시작, 끝). 글 하나가 실패하면 그 글만 null(규칙만 쓴다). */
  secretSpans(texts: readonly string[]): Promise<(SecretSpan[] | null)[]> {
    return this.#serial(async () => {
      const model = await this.#model();
      const out: (SecretSpan[] | null)[] = [];
      for (const text of texts) {
        try {
          out.push((await this.#find(model, text)).flatMap(({ label, start, end }): SecretSpan[] => {
            const kind = tier1.get(label);
            return kind === undefined ? [] : [[kind, start, end]];
          }));
        } catch {
          out.push(null);
        }
      }
      return out;
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    const loaded = this.#loaded;
    this.#loaded = undefined;
    if (loaded !== undefined) await loaded.then(model => model.session.release(), () => {});
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("PII model is closed"));
    const request = this.#tail.then(work);
    this.#tail = request.then(() => {}, () => {});
    return request;
  }

  #model(): Promise<Loaded> {
    this.#loaded ??= open(this.#directory);
    return this.#loaded;
  }

  async #find(model: Loaded, text: string): Promise<PiiSpan[]> {
    return (await allSpans(model, text)).filter(span => span.score >= this.#threshold);
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
