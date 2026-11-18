import { z } from "zod";
import { SpeechPrefsSchema, type SpeechPrefs } from "../core/turn.ts";
import { readPrivateFile, type Seal, writePrivateFile } from "./seal.ts";

export const VAULT_LABELS = { name: "이름", address: "주소", phone: "연락처", email: "이메일", birth: "생년월일" } as const;
export type VaultKey = keyof typeof VAULT_LABELS;
export type Vault = Partial<Record<VaultKey, string>>;
export const SECRET = /(비밀\p{White_Space}*번호|패스워드|주민|계좌|카드\p{White_Space}*번호|인증\p{White_Space}*번호|\[비공개\])/u;
const VaultSchema = z.partialRecord(z.enum(["name", "address", "phone", "email", "birth"]), z.string());
const ApplicationSchema = z.object({
  id: z.string(), service: z.string(), appliedAt: z.string(), receiptNo: z.string().optional(),
  dueDate: z.string().optional(), dueNote: z.string().optional(), done: z.boolean().optional(),
});
export type Application = z.infer<typeof ApplicationSchema>;
export type SpeechPatch = Partial<Omit<SpeechPrefs, "voice">> & { voice?: string | null };
const StoreSchema = z.object({
  vault: VaultSchema.default({}), applications: z.array(ApplicationSchema).default([]),
  speech: SpeechPrefsSchema.prefault({}), siteAllow: z.record(z.string(), z.boolean()).default({}),
});
type Stored = z.infer<typeof StoreSchema>;

export class PersonalStore {
  readonly path?: string;
  readonly #seal?: Seal;
  #data: Stored = StoreSchema.parse({});
  constructor(path?: string, seal?: Seal) {
    this.path = path;
    this.#seal = seal;
    if (path === undefined) return;
    let previous;
    try { previous = readPrivateFile(path, seal); }
    catch { return; }
    if (previous === undefined) return;
    const parsed = StoreSchema.safeParse(previous.data);
    if (!parsed.success) return;
    this.#data = parsed.data;
    if (seal !== undefined && !previous.sealed) this.#save(this.#data);
  }
  #save(data: Stored) {
    if (this.path !== undefined) {
      writePrivateFile(this.path, { ...data, speech: { ...data.speech, voice: data.speech.voice ?? null } }, this.#seal);
    }
    this.#data = data;
  }
  get persistent() { return this.path !== undefined; }
  vault(): Vault { return { ...this.#data.vault }; }
  saveVault(values: Vault) { this.#save({ ...this.#data, vault: { ...this.#data.vault, ...values } }); }
  clearVault() { this.#save({ ...this.#data, vault: {} }); }
  speech(): SpeechPrefs { return { ...this.#data.speech }; }
  saveSpeech(patch: SpeechPatch) {
    const speech = SpeechPrefsSchema.parse({ ...this.#data.speech, ...patch });
    this.#save({ ...this.#data, speech });
    return this.speech();
  }
  clearSpeech() {
    this.#save({ ...this.#data, speech: SpeechPrefsSchema.parse({}) });
    return this.speech();
  }
  siteAllowed(origin: string) { return this.#data.siteAllow[origin] === true; }
  allowSite(origin: string) { this.#save({ ...this.#data, siteAllow: { ...this.#data.siteAllow, [origin]: true } }); }
  revokeSite(origin?: string) {
    const siteAllow = origin === undefined ? {} : { ...this.#data.siteAllow };
    if (origin !== undefined) delete siteAllow[origin];
    this.#save({ ...this.#data, siteAllow });
  }
  allowedSites() { return Object.keys(this.#data.siteAllow).filter(origin => this.siteAllowed(origin)); }
  applications() { return this.#data.applications.map(app => ({ ...app })); }
  addApplication(record: Omit<Application, "id">) {
    const apps = this.#data.applications;
    let id = Date.now();
    while (apps.some(app => app.id === String(id))) id++;
    const app = { ...record, id: String(id) };
    this.#save({ ...this.#data, applications: [...apps, app] });
    return { ...app };
  }
  updateApplication(id: string, patch: Partial<Omit<Application, "id">>) {
    this.#save({ ...this.#data, applications: this.#data.applications.map(app => app.id === id ? { ...app, ...patch } : app) });
  }
}
