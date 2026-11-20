import { createRequire } from "node:module";

export interface KeyEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  /** Keys an earlier build stored under another name. Opening a file may try them after the primary key. */
  legacyPasswords?(): readonly string[];
}

export interface KeyringApi {
  Entry: {
    new (service: string, username: string): { getPassword(): string | null; setPassword(password: string): void };
    withTarget(target: string, service: string, username: string): { setPassword(password: string): void };
  };
  findCredentials(service: string, target?: string | null): ReadonlyArray<{ account: string; password: string }>;
}

export function loadKeyring(): KeyringApi {
  return createRequire(import.meta.url)("@napi-rs/keyring");
}

export function createKeyEntry(service: string, user: string, options: { platform?: NodeJS.Platform; keyring?: KeyringApi } = {}): KeyEntry {
  const keyring = options.keyring ?? loadKeyring();
  if ((options.platform ?? process.platform) !== "win32") return new keyring.Entry(service, user);
  return new WindowsKeyEntry(service, user, keyring);
}

/**
 * The Python app keeps the vault key in the Windows credential store under the service name alone. The library's default
 * name is `${user}.${service}`, which an earlier TypeScript build used. Reads go through findCredentials because reading a
 * pinned-target entry (Entry.withTarget, then getPassword) empties an existing entry and creates empty ones. Writes use
 * Python's name so both apps share one key.
 */
class WindowsKeyEntry implements KeyEntry {
  readonly #service: string;
  readonly #user: string;
  readonly #keyring: KeyringApi;

  constructor(service: string, user: string, keyring: KeyringApi) {
    this.#service = service;
    this.#user = user;
    this.#keyring = keyring;
  }

  getPassword(): string | null {
    const stored = this.#stored();
    if (stored !== null) return stored;
    const legacy = this.#legacy();
    if (legacy === null) return null;
    this.setPassword(legacy);
    return legacy;
  }

  setPassword(password: string): void {
    this.#keyring.Entry.withTarget(this.#service, this.#service, this.#user).setPassword(password);
  }

  legacyPasswords(): readonly string[] {
    const legacy = this.#legacy();
    return legacy === null ? [] : [legacy];
  }

  #stored(): string | null {
    const found = this.#keyring.findCredentials(this.#service, this.#service).find(credential => credential.account === this.#user)?.password;
    return found === undefined || found === "" ? null : found;
  }

  #legacy(): string | null {
    const found = new this.#keyring.Entry(this.#service, this.#user).getPassword();
    return found === null || found === "" ? null : found;
  }
}
