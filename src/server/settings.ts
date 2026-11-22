// 이용 설정은 PC에 원자적으로 저장하고, 직접 입력한 키만 OS 자격 증명 키로 봉인한다.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { provinceName } from "../core/region.ts";
import { KNOWN_SITES } from "../core/sites.ts";
import { strip } from "../core/text.ts";
import { Seal } from "../personal/seal.ts";
import { DEFAULT_SPEED } from "../voice/config.ts";

const codePoints = (text: string) => Array.from(text).length;
const preferenceFields = {
  language: z.enum(["ko", "en", "zh", "ja"]).default("ko"),
  region: z.string().refine(value => codePoints(value) <= 20).transform((value, ctx) => {
    if (value !== "" && provinceName(value) === "") {
      ctx.addIssue({ code: "custom", message: "시·도를 선택해 주세요." });
      return z.NEVER;
    }
    return provinceName(value);
  }).default(""),
  speed: z.number().min(0.75).max(2).default(DEFAULT_SPEED),
  rememberService: z.boolean().default(false),
  deviceUse: z.enum(["unidentified", "personal", "shared"]).default("unidentified"),
  // 평소 쓰는 크롬(로그인 유지) 또는 따로 쓰는 브라우저. 개인 PC에서만 크롬을 고를 수 있다.
  browser: z.enum(["separate", "chrome"]).default("separate"),
};
export const Preferences = z.strictObject(preferenceFields);
export type Preferences = z.output<typeof Preferences>;

export const SettingsInput = z.strictObject({
  ...preferenceFields,
  soundSetupComplete: z.literal(true).optional(),
  apiKey: z.string().default("").transform((secret, ctx) => {
    const key = strip(secret);
    if (key !== "" && (key.length > 512 || !/^[\x21-\x7e]*$/.test(key))) {
      ctx.addIssue({ code: "custom", message: "API 키를 확인해 주세요." });
      return z.NEVER;
    }
    return key;
  }),
});
export type SettingsInput = z.output<typeof SettingsInput>;

// 소리와 속도를 다 정하면 대화를 열기 전에도 그 진행을 보관한다.
export const FIRST_RUN_STEPS = ["stage2", "sound-complete", "mic", "name", "stop", "intro", "practice", "done"] as const;
export type FirstRunStep = typeof FIRST_RUN_STEPS[number];
function firstRunStep(value: unknown): FirstRunStep | undefined {
  return FIRST_RUN_STEPS.find(step => step === value);
}

export interface Sealer { seal(plain: Uint8Array): Uint8Array; open(blob: Uint8Array): Uint8Array }
export type LastService = readonly [agency: string, topic: string];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Python base64.b64decode(validate=True). */
function strictBase64(text: string): Buffer {
  if (!BASE64.test(text) || text.length % 4 !== 0) throw new Error("invalid base64");
  return Buffer.from(text, "base64");
}
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function knownService(agency: string, topic: string) {
  return KNOWN_SITES.some(site => site.label === agency && (topic === "" || site.services.includes(topic)));
}

export class SettingsStore {
  readonly path: string;
  readonly #sealFactory: () => Sealer;
  #preferences: Preferences = Preferences.parse({});
  #key = "";
  // 손으로 고친 파일의 값도 그대로 다시 쓴다. 보통은 봉인한 키의 base64 글이다.
  #credential: unknown = "";
  #lastService: LastService | undefined;
  #completed = false;
  #loadError = false;
  // 파일이 없으면 1단계를 저장한 뒤 이어 갈 곳. 이 기능 전에 만든 파일은 이미 끝난 것으로 본다.
  #firstRun: FirstRunStep = "stage2";

  constructor(path: string, sealFactory: () => Sealer = () => new Seal()) {
    this.path = path;
    this.#sealFactory = sealFactory;
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) this.#loadError = true;
      return;
    }
    try {
      this.#load(bytes);
    } catch {
      // 자격 증명이 사라졌을 때에도 새 키를 입력할 수 있게 한다.
      this.#loadError = true;
    }
  }

  #load(bytes: Buffer) {
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(data) || !("preferences" in data)) throw new TypeError("settings file");
    this.#preferences = Preferences.parse(data.preferences);
    if (!("credential" in data)) throw new TypeError("settings file");
    const credential = data.credential;
    if (truthy(credential)) {
      if (typeof credential !== "string") throw new TypeError("credential");
      const plain = this.#sealFactory().open(strictBase64(credential));
      if (plain.some(byte => byte > 0x7f)) throw new TypeError("credential is not ASCII");
      this.#key = Buffer.from(plain).toString("latin1");
    }
    this.#credential = credential;
    this.#firstRun = "firstRun" in data ? firstRunStep(data.firstRun) ?? "done" : "done";
    const saved = data.lastService;
    if (this.#preferences.deviceUse === "personal" && this.#preferences.rememberService && Array.isArray(saved) && saved.length === 2) {
      const [agency, topic]: unknown[] = saved;
      if (typeof agency === "string" && typeof topic === "string" && knownService(agency, topic)) this.#lastService = [agency, topic];
    }
    this.#completed = true;
  }

  get preferences(): Preferences { return this.#preferences; }
  get key(): string { return this.#key; }
  get lastService(): LastService | undefined { return this.#lastService; }
  get completed(): boolean { return this.#completed; }
  get loadError(): boolean { return this.#loadError; }
  get firstRun(): FirstRunStep { return this.#firstRun; }

  save(values: SettingsInput): void {
    let prefs = Preferences.parse({
      language: values.language, region: values.region, speed: values.speed, rememberService: values.rememberService,
      deviceUse: values.deviceUse, browser: values.browser,
    });
    if (prefs.deviceUse !== "personal") prefs = { ...prefs, rememberService: false, browser: "separate" };
    const key = values.apiKey !== "" ? values.apiKey : this.#key;
    const credential = key !== "" ? Buffer.from(this.#sealFactory().seal(Buffer.from(key, "ascii"))).toString("base64") : "";
    const lastService = prefs.rememberService ? this.#lastService : undefined;
    const firstRun = values.soundSetupComplete === true && this.#firstRun === "stage2" ? "sound-complete" : this.#firstRun;
    this.#write(prefs, credential, lastService, firstRun);
    this.#firstRun = firstRun;
    this.#preferences = prefs;
    this.#key = key;
    this.#completed = true;
    this.#loadError = false;
    this.#credential = credential;
    this.#lastService = lastService;
  }

  rememberService(agency: string, topic: string): void {
    const last = this.#lastService;
    if (this.#preferences.deviceUse !== "personal" || !this.#preferences.rememberService || (last !== undefined && last[0] === agency && last[1] === topic)) return;
    if (!knownService(agency, topic)) return;
    this.#write(this.#preferences, this.#credential, [agency, topic], this.#firstRun);
    this.#lastService = [agency, topic];
  }

  /** 첫 실행 설정을 어디까지 했는지 적는다(앱을 닫았다 열면 그 단계부터 한 번 이어 간다). */
  setFirstRun(step: string): void {
    const known = firstRunStep(step);
    if (known === undefined) throw new RangeError(step);
    this.#write(this.#preferences, this.#credential, this.#lastService, known);
    this.#firstRun = known;
  }

  #write(prefs: Preferences, credential: unknown, lastService: LastService | undefined, firstRun: FirstRunStep): void {
    const payload = JSON.stringify({ preferences: prefs, credential, lastService: lastService ?? null, firstRun });
    const folder = dirname(this.path);
    mkdirSync(folder, { recursive: true });
    const temporary = join(folder, ".preferences-" + randomUUID() + ".tmp");
    try {
      writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** 새 창이나 다음날 켠 앱도 한 사용자 설정에서 최초 한 번만 자동 안내한다. */
  claimStartupGuide(): boolean | undefined {
    try {
      closeSync(openSync(join(dirname(this.path), "startup-guide-seen"), "wx"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
      return undefined; // 저장소가 읽기 전용이면 화면의 로컬 기록으로 결정한다.
    }
    return true;
  }
}
