import { z } from "zod";
import { LangSchema, SessionStateSchema, SpeechPrefsSchema, TurnResultSchema, type Lang } from "../../src/core/turn.ts";

const provider = z.object({ provider: z.string(), supported: z.boolean() });
const health = z.object({
  llmRoles: z.record(z.string(), z.string()).optional(),
  stt: provider.extend({ localLanguages: z.array(LangSchema).optional() }), tts: provider,
});
const session = z.object({
  sessionId: z.string(), state: SessionStateSchema, llmProvider: z.string(),
  consentRequired: z.boolean(), speechPrefs: SpeechPrefsSchema.nullish(),
});
const progress = z.object({ running: z.boolean(), seq: z.number(), spoken: z.boolean(), latest: z.string().nullish() });
export type ProgressReport = z.infer<typeof progress>;

async function checked(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  if (!response.ok) {
    const error = z.object({ message: z.string() }).safeParse(await response.json().catch(() => undefined));
    throw new Error(error.success ? error.data.message : `요청 실패 (${response.status})`);
  }
  return response;
}
async function request<T>(schema: z.ZodType<T>, path: string, init?: RequestInit) {
  return schema.parse(await (await checked(path, init)).json());
}
const post = (body?: unknown) => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const audioPost = (body: Blob) => ({ method: "POST", headers: { "Content-Type": body.type.length > 0 ? body.type : "audio/webm" }, body });
const endpoint = (id: string) => `/api/session/${encodeURIComponent(id)}`;

export const api = {
  health: () => request(health, "/api/health"),
  createSession: () => request(session, "/api/session", post()),
  turn: (id: string, text: string) => request(TurnResultSchema, "/api/turn", post({ sessionId: id, text, clientPlatform: "pc" })),
  audioTurn: (id: string, audio: Blob) => request(TurnResultSchema, `/api/audio/turn?sessionId=${encodeURIComponent(id)}`, audioPost(audio)),
  audioStop: (id: string, audio: Blob) => request(z.object({ stopped: z.boolean(), result: TurnResultSchema.optional() }), `/api/audio/stop?sessionId=${encodeURIComponent(id)}`, audioPost(audio)),
  confirm: (id: string, approve: boolean) => request(TurnResultSchema, endpoint(id)+"/confirm", post({ approve })),
  consent: (id: string, granted: boolean) => request(TurnResultSchema, endpoint(id)+"/consent", post({ granted })),
  language: (id: string, lang: Lang) => request(TurnResultSchema, endpoint(id)+"/language", post({ lang })),
  cancel: (id: string) => request(TurnResultSchema, endpoint(id)+"/cancel", post()),
  reminders: (id: string) => request(z.object({ text: z.string().nullish() }), endpoint(id)+"/reminders"),
  progress: (id: string) => request(progress, endpoint(id)+"/progress"),
  state: async (id: string): Promise<unknown> => (await checked(endpoint(id)+"/state")).json(),
  speak: async (text: string, lang: Lang, signal?: AbortSignal) => (await checked("/api/audio/speak", { ...post({ text, lang }), signal })).blob(),
  close(id: string) { void fetch(endpoint(id), { method: "DELETE", keepalive: true }).catch(() => undefined); },
};
