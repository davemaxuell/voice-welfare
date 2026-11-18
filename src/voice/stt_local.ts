import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { raceAbort } from "../core/abort.ts";
import { REPO_ROOT } from "../core/assets.ts";
import { pythonCommand, pythonProject } from "../core/python.ts";
import { strip } from "../core/text.ts";
import { STT_PROMPT, isHallucination, isPromptEcho, type SttProvider, type VoiceInput } from "./stt.ts";

const replySchema = z.object({ id: z.int(), text: z.string().optional(), ok: z.boolean().optional(), error: z.string().optional() });
type Command = { op: "available" | "warm" } | { op: "transcribe"; audioPath: string; language: string; prompt: string | null };
interface Worker {
  child: ChildProcessWithoutNullStreams; lines: AsyncIterator<string>; closed: Promise<void>;
}
interface LocalOptions {
  threads?: number; beamSize?: number; usePrompt?: boolean;
  workerCommand?: readonly [string, ...string[]];
}
export class LocalWhisperStt implements SttProvider {
  readonly supported = true;
  readonly name: string;
  readonly modelDir: string;
  readonly #opts: LocalOptions;
  #worker?: Worker;
  #tail: Promise<void> = Promise.resolve();
  #id = 0;
  #closed = false;
  constructor(modelDir: string, options: LocalOptions = {}) {
    this.modelDir = modelDir;
    this.#opts = options;
    this.name = "local(" + basename(modelDir).replace(/-ct2$/u,"") + ")";
  }
  static available(modelDir: string) {
    return ["model.bin","tokenizer.json"].every(f => statSync(join(modelDir,f), { throwIfNoEntry: false })?.isFile() === true);
  }
  #open(): Worker {
    if (this.#closed) throw Error("받아쓰기 서비스를 종료했습니다.");
    if (this.#worker !== undefined) return this.#worker;
    const [command, ...args] = this.#opts.workerCommand ?? pythonCommand(
      "-u", join(pythonProject, "cheongeum_stt", "sidecar.py"), this.modelDir,
      String(Math.max(0, this.#opts.threads ?? 0)), String(Math.max(1, this.#opts.beamSize ?? 1)),
    );
    const child = spawn(command, args, { cwd: REPO_ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.on("error", () => reader.close());
    child.stdin.on("error", () => reader.close());
    const worker = { child, lines: reader[Symbol.asyncIterator](), closed: new Promise<void>(done => child.once("close", () => done())) };
    this.#worker = worker;
    void worker.closed.then(() => { if (this.#worker === worker) this.#worker = undefined; });
    return worker;
  }
  async #request(cmd: Command) {
    const worker = this.#open();
    const id = ++this.#id;
    let reply;
    try {
      await new Promise<void>((resolve,reject) => worker.child.stdin.write(JSON.stringify({id,...cmd}) + "\n", e => e == null ? resolve() : reject(e)));
      const line = await worker.lines.next();
      if (line.done === true) throw Error("로컬 받아쓰기 연결을 종료했습니다.");
      reply = replySchema.parse(JSON.parse(line.value));
      if (reply.id !== id) throw Error("로컬 받아쓰기 응답 번호가 다릅니다.");
    } catch (cause) {
      if (this.#worker === worker) this.#worker = undefined;
      worker.child.stdin.end();
      worker.child.kill();
      throw new Error("로컬 받아쓰기 응답을 읽지 못했습니다.", { cause });
    }
    if (reply.error !== undefined) throw Error("로컬 받아쓰기 실패: " + reply.error);
    return reply;
  }
  #queue<T>(work: () => Promise<T>) {
    if (this.#closed) return Promise.reject<T>(Error("받아쓰기 서비스를 종료했습니다."));
    const run = this.#tail.then(work);
    this.#tail = run.then(() => {}, () => {});
    return run;
  }
  async probe() {
    try { return (await this.#queue(() => this.#request({op:"available"}))).ok === true; } catch { return false; }
  }
  async warm() { await this.#queue(() => this.#request({op:"warm"})); }
  transcribe(audio: Uint8Array, { language, signal }: VoiceInput) {
    return raceAbort(() => this.#queue(async () => {
      signal?.throwIfAborted();
      const folder = await mkdtemp(join(tmpdir(),"cheongeum-speech-"));
      try {
        const path = join(folder, "speech");
        await writeFile(path, audio, { flag: "wx", mode: 0o600 });
        signal?.throwIfAborted();
        const { text } = await this.#request({ op: "transcribe", audioPath: path, language,
          prompt: this.#opts.usePrompt === true && language === "ko" ? STT_PROMPT : null });
        if (text === undefined) throw Error("받아쓰기 결과가 없습니다.");
        const clean = strip(text);
        return { text: isPromptEcho(clean) || isHallucination(clean) ? "" : clean };
      } finally { await rm(folder, { recursive: true, force: true }); }
    }), signal);
  }
  async close() {
    this.#closed = true;
    const worker = this.#worker;
    if (worker !== undefined) {
      worker.child.stdin.end();
      const timer = setTimeout(() => worker.child.kill(), 3000);
      timer.unref();
      try { await worker.closed; } finally { clearTimeout(timer); }
    }
    await this.#tail;
  }
}
export class LanguageRoutedStt implements SttProvider {
  readonly supported = true;
  readonly name: string;
  readonly localLanguages: readonly string[];
  readonly #local: SttProvider;
  readonly #other?: SttProvider;
  constructor(local: SttProvider, other?: SttProvider, localLanguages: readonly string[] = ["ko"], allLanguages?: readonly string[]) {
    this.#local = local; this.#other = other;
    this.localLanguages = other === undefined ? allLanguages ?? localLanguages : localLanguages;
    this.name = other === undefined ? local.name : local.name + "+" + other.name;
  }
  pick(language: string) { return this.#other === undefined || this.localLanguages.includes(language) ? this.#local : this.#other; }
  async warm() { await this.#local.warm?.(); }
  async close() { await this.#local.close?.(); await this.#other?.close?.(); }
  transcribe(audio: Uint8Array, input: VoiceInput) { return this.pick(input.language).transcribe(audio,input); }
}
