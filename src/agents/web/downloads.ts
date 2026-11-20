import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { strip } from "../../core/text.ts";
import { chunkText } from "../../speech/phrasing.ts";
import { readDocument } from "./docs.ts";

export interface Download { name: string; path: string; at: number }
export class DownloadStore {
  readonly folder?: string;
  readonly #files: Download[] = [];
  #offset = 0;
  constructor(folder?: string) {
    this.folder = folder;
    if (folder !== undefined && folder.length > 0) mkdirSync(folder, { recursive: true });
  }
  remember(path: string, name?: string): Download {
    const record = { name: name === undefined || name === "" ? basename(path) : name, path, at: Date.now() / 1000 };
    this.#files.push(record);
    this.#offset = 0;
    return record;
  }
  latest() { return this.#files.at(-1); }
  listNames() { return this.#files.map(file => file.name); }
  speakList() {
    const names = this.listNames();
    if (names.length === 0) return "받은 파일이 없어요.";
    return `받은 파일은 ${names.length}개예요. ${names.slice(-5).join(", ")}${names.length > 5 ? " 등이에요." : "이에요."}`;
  }
  async readLatest({ more = false, maxChars = 1200 }: { more?: boolean; maxChars?: number } = {}) {
    const last = this.latest();
    if (last === undefined) return "받은 파일이 없어요. 사이트에서 파일을 받은 뒤 다시 말씀해 주세요.";
    const offset = more ? this.#offset : 0;
    const out = await readDocument(last.path, { name: last.name, maxChars: offset + maxChars + 1 });
    if (!out.ok) return out.speech;
    const characters = Array.from(out.text);
    const head = chunkText(out.text, offset, maxChars);
    if (head.length === 0) return "파일의 끝까지 읽었어요.";
    const at = out.text.indexOf(head, characters.slice(0, offset).join("").length);
    const end = Array.from(out.text.slice(0, at)).length + Array.from(head).length;
    if (this.latest() === last) this.#offset = end;
    const hint = strip(characters.slice(end).join("")).length > 0 ? " 이어서 들으려면 '받은 파일 더 읽어줘'라고 하세요." : "";
    return `'${last.name}'을 읽어요. ${head}${hint}`;
  }
}
