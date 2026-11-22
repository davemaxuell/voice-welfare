import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { GuardianContact } from "../core/dialogue.ts";
import { RememberedRouteSchema, type RememberedRoute } from "../core/plan.ts";
import { omitAbsent } from "../core/schema.ts";
import { hasText } from "../core/text.ts";
import { SpeechPrefsSchema, type SpeechPrefs } from "../core/turn.ts";
import { writePrivate } from "./atomic.ts";
import { readPrivateFile, type Seal } from "./seal.ts";

export const VAULT_LABELS = { name: "이름", address: "주소", phone: "연락처", email: "이메일", birth: "생년월일" } as const;
export type VaultKey = keyof typeof VAULT_LABELS;
export type Vault = Partial<Record<VaultKey, string>>;
export const SECRET = /(비밀\p{White_Space}*번호|패스워드|주민|계좌|카드\p{White_Space}*번호|인증\p{White_Space}*번호|\[비공개\])/u;
export const MOBILE = /(?:010[0-9]{8}|01[16789][0-9]{7,8})/u;
const WHOLE_MOBILE = new RegExp(`^${MOBILE.source}$`, "u");
/** Python의 MOBILE.fullmatch(phone) */
export function isMobile(phone: string): boolean { return WHOLE_MOBILE.test(phone); }
const VaultSchema = z.partialRecord(z.enum(["name", "address", "phone", "email", "birth"]), z.string());
const ApplicationSchema = z.object({
  id: z.string(), service: z.string(), appliedAt: z.string(), receiptNo: z.string().optional(),
  dueDate: z.string().optional(), dueNote: z.string().optional(), done: z.boolean().optional(),
});
export type Application = z.infer<typeof ApplicationSchema>;
export type SpeechPatch = Partial<Omit<SpeechPrefs, "voice">> & { voice?: string | null };
// 보호자와 부르는 이름은 파일에 적힌 그대로 두고, 읽는 쪽(guardian·callName)이 모양을 확인한다. 깨진 값도 다음 저장에 지워지지 않는다.
const StoreSchema = z.object({
  vault: VaultSchema.default({}), guardian: z.json().default(null), callName: z.json().default(null),
  applications: z.array(ApplicationSchema).default([]), routes: z.array(RememberedRouteSchema).max(40).optional().catch(undefined),
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
    const previous = readPrivateFile(path, seal, data => StoreSchema.parse(data));
    if (previous === undefined) return;
    this.#data = previous.data;
    // 봉인하기 전에 이미 평문 파일에 있던 경로는 믿지 않는다.
    if (!previous.sealed) delete this.#data.routes;
    if (seal !== undefined && !previous.sealed) this.#save(this.#data);
  }
  #save(data: Stored) {
    if (this.path !== undefined) {
      const payload = Buffer.from(JSON.stringify({ ...data, speech: { ...data.speech, voice: data.speech.voice ?? null } }, null, 2));
      writePrivate(this.path, this.#seal?.seal(payload) ?? payload);
    }
    this.#data = data;
  }
  get persistent() { return this.path !== undefined; }
  get canRememberRoutes() { return this.path !== undefined && this.#seal !== undefined; }
  rememberedRoute(site: string, goalKey: string): RememberedRoute | undefined {
    if (!this.canRememberRoutes) return undefined;
    const found = this.#data.routes?.find(route => route.site === site && route.goalKey === goalKey);
    return found && structuredClone(found);
  }
  saveRoute(route: RememberedRoute, eligible: (route: RememberedRoute, values: readonly string[]) => boolean) {
    if (!this.canRememberRoutes || !eligible(route, Object.values(this.#data.vault))) return;
    const keep = this.#data.routes?.filter(item => item.site !== route.site || item.goalKey !== route.goalKey) ?? [];
    this.#save({...this.#data, routes: [...keep.slice(-39), RememberedRouteSchema.parse(route)]});
  }
  vault(): Vault { return { ...this.#data.vault }; }
  saveVault(values: Vault) { this.#save({ ...this.#data, vault: { ...this.#data.vault, ...values } }); }
  clearVault() { this.#save({ ...this.#data, vault: {}, guardian: null, callName: null, routes: undefined }); }
  /** 청음이 사용자를 부르는 이름(첫 실행에서 물음). 금고의 법적 이름(name)과 따로 둔다. */
  callName(): string | undefined {
    const name = this.#data.callName;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  }
  setCallName(name: string | null | undefined) { this.#save({ ...this.#data, callName: hasText(name) ? name : null }); }
  guardian(): GuardianContact | undefined {
    const contact = this.#data.guardian;
    if (typeof contact !== "object" || contact === null || Array.isArray(contact)) return undefined;
    const { name, phone } = contact;
    if (typeof name !== "string" || name.length === 0) return undefined;
    if (typeof phone !== "string" || !isMobile(phone)) return undefined;
    return { name, phone };
  }
  setGuardian(contact: GuardianContact | undefined) { this.#save({ ...this.#data, guardian: contact === undefined ? null : { ...contact } }); }
  speech(): SpeechPrefs {
    const { voice: _legacy, ...prefs } = this.#data.speech;
    return prefs;
  }
  saveSpeech(patch: SpeechPatch) {
    const { voice: _legacy, ...changes } = patch;
    const speech = SpeechPrefsSchema.parse({ ...this.#data.speech, ...changes });
    this.#save({ ...this.#data, speech });
    return this.speech();
  }
  clearSpeech() {
    this.#save({ ...this.#data, speech: SpeechPrefsSchema.parse({}) });
    return this.speech();
  }
  siteAllowed(origin: string) { return this.#data.siteAllow[origin] === true; }
  allowSite(origin: string) { this.#save({ ...this.#data, siteAllow: { ...this.#data.siteAllow, [origin]: true } }); }
  /** origin이 없으면(Python은 빈 문자열도) 사이트 허용을 모두 지운다. */
  revokeSite(origin?: string) {
    const only = origin !== undefined && origin.length > 0;
    const siteAllow = only ? Object.fromEntries(Object.entries(this.#data.siteAllow).filter(([site]) => site !== origin)) : {};
    this.#save({ ...this.#data, siteAllow });
  }
  allowedSites() { return Object.keys(this.#data.siteAllow).filter(origin => this.siteAllowed(origin)); }
  applications() { return this.#data.applications.map(app => ({ ...app })); }
  addApplication(record: Omit<Application, "id">) {
    const app = omitAbsent({ ...record, id: randomUUID() });
    this.#save({ ...this.#data, applications: [...this.#data.applications, app] });
    return { ...app };
  }
  updateApplication(id: string, patch: Partial<Omit<Application, "id">>) {
    this.#save({ ...this.#data, applications: this.#data.applications.map(app => app.id === id ? { ...app, ...patch } : app) });
  }
}
