import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const MAGIC = Buffer.from("CE1\0");
export const SERVICE = "cheongeum-voice-welfare";
export const KEY_NAME = "data-key";
interface KeyEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
}

export class Seal {
  readonly #key: Buffer;
  constructor({ key, entry }: { key?: Uint8Array; entry?: KeyEntry } = {}) {
    if (key !== undefined) {
      if (key.length !== 32) throw Error("key must be 32 bytes");
      this.#key = Buffer.from(key);
      return;
    }
    if (entry === undefined) {
      const { Entry } = createRequire(import.meta.url)("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
      entry = new Entry(SERVICE, KEY_NAME);
    }
    const raw = entry.getPassword();
    if (raw === null) {
      this.#key = randomBytes(32);
      entry.setPassword(this.#key.toString("hex"));
    } else {
      if (!/^[0-9a-f]{64}$/iu.test(raw)) throw Error("invalid data key");
      this.#key = Buffer.from(raw, "hex");
    }
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
    const decipher = createDecipheriv("aes-256-gcm", this.#key, blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(-16));
    return Buffer.concat([decipher.update(blob.subarray(16, -16)), decipher.final()]);
  }
}

export function readPrivateFile(path: string, seal?: Seal) {
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  const sealed = seal?.isSealed(bytes) === true;
  const text = sealed ? seal!.open(bytes).toString("utf8") : bytes.toString("utf8");
  return { data: JSON.parse(text) as unknown, sealed };
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
