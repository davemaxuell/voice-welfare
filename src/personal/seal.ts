import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createKeyEntry, type KeyEntry } from "./credential_store.ts";

const MAGIC = Buffer.from("CE1\0");
export const SERVICE = "cheongeum-voice-welfare";
export const KEY_NAME = "data-key";
const KEY_PATTERN = /^[0-9a-f]{64}$/iu;

export class Seal {
  readonly #key: Buffer;
  readonly #legacyKeys: readonly Buffer[];
  constructor({ key, entry }: { key?: Uint8Array; entry?: KeyEntry } = {}) {
    if (key !== undefined) {
      if (key.length !== 32) throw Error("key must be 32 bytes");
      this.#key = Buffer.from(key);
      this.#legacyKeys = [];
      return;
    }
    const keyEntry = entry ?? createKeyEntry(SERVICE, KEY_NAME);
    const raw = keyEntry.getPassword();
    if (raw === null) {
      this.#key = randomBytes(32);
      keyEntry.setPassword(this.#key.toString("hex"));
    } else {
      if (!KEY_PATTERN.test(raw)) throw Error("invalid data key");
      this.#key = Buffer.from(raw, "hex");
    }
    this.#legacyKeys = (keyEntry.legacyPasswords?.() ?? [])
      .filter(text => KEY_PATTERN.test(text))
      .map(text => Buffer.from(text, "hex"))
      .filter(other => !other.equals(this.#key));
  }
  isSealed(blob: Uint8Array) {
    return MAGIC.equals(blob.subarray(0, MAGIC.length));
  }
  seal(plain: Uint8Array): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    return Buffer.concat([MAGIC, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  }
  open(blob: Uint8Array): Buffer {
    if (!this.isSealed(blob) || blob.length < 32) throw Error("not a cheongeum sealed blob");
    let failure: unknown;
    for (const key of [this.#key, ...this.#legacyKeys]) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(4, 16));
        decipher.setAuthTag(blob.subarray(-16));
        return Buffer.concat([decipher.update(blob.subarray(16, -16)), decipher.final()]);
      } catch (error) {
        failure ??= error;
      }
    }
    throw failure;
  }
}

export function readPrivateFile<T>(path: string, seal: Seal | undefined, parse: (data: unknown) => T) {
  if (!existsSync(path)) return undefined;
  try {
    const bytes = readFileSync(path);
    const sealed = seal?.isSealed(bytes) === true;
    const text = sealed ? seal!.open(bytes).toString("utf8") : bytes.toString("utf8");
    return { data: parse(JSON.parse(text)), sealed };
  } catch {
    // 맞는 키가 돌아오면 다시 열 수 있게 덮어쓰지 않고 옆으로 옮긴다. 오류 문구는 파일 내용을 담을 수 있어 남기지 않는다.
    const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
    renameSync(path, aside);
    process.stderr.write(`[personal] 읽을 수 없는 파일을 ${aside}(으)로 옮기고 새로 시작합니다.\n`);
    return undefined;
  }
}

export function writePrivateFile(path: string, data: unknown, seal?: Seal) {
  const payload = Buffer.from(JSON.stringify(data, null, 2));
  const blob = seal?.seal(payload) ?? payload;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, blob, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
