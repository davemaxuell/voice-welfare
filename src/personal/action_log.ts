import { createHash } from "node:crypto";
import { z } from "zod";
import type { Redacted } from "../core/llm.ts";
import { hasText } from "../core/text.ts";
import { writePrivate } from "./atomic.ts";
import { type Seal, readPrivateFile } from "./seal.ts";

export const KEEP_DAYS = 30;
export const GENESIS = "0".repeat(64);
const RowSchema = z.object({
  seq: z.number().int(), day: z.string(), at: z.string(), host: z.string(), pageKind: z.string(),
  actionType: z.string(), label: z.string(), approvalId: z.string().nullable(),
  phase: z.enum(["before", "after", "refused"]), ok: z.boolean().nullable(), prev: z.string(),
  reasonCode: z.string().optional(), actor: z.string().optional(), hash: z.string(),
});
type Row = z.infer<typeof RowSchema>;
type Fields = Partial<Pick<Row, "host" | "pageKind" | "actionType" | "approvalId" | "ok">> & { label?: Redacted };
/** 거절한 조작(refused)은 이유(reasonCode)와 요청한 쪽(actor)을 꼭 적는다. */
export type AuditEntry = (Fields & { phase?: "before" | "after" }) | (Fields & { phase: "refused"; reasonCode: string; actor: string });

export function localDay(date = new Date()) {
  return [String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
}
export class ActionLog {
  readonly path?: string;
  readonly #seal?: Seal;
  readonly #now: () => Date;
  #rows: Row[] = [];
  constructor(path?: string, seal?: Seal, now: () => Date = () => new Date()) {
    this.path = path;
    this.#seal = seal;
    this.#now = now;
    if (path === undefined) return;
    const existing = readPrivateFile(path, seal, data => z.object({ rows: z.array(RowSchema) }).parse(data));
    if (existing === undefined) return;
    const cutoff = new Date(now());
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const firstDay = localDay(cutoff);
    this.#rows = existing.data.rows.filter(row => row.day >= firstDay);
  }
  append(entry: AuditEntry): Row {
    const now = this.#now();
    const row = {
      seq: (this.#rows.at(-1)?.seq ?? 0) + 1, day: localDay(now), at: now.toISOString(), host: entry.host ?? "",
      pageKind: entry.pageKind ?? "", actionType: entry.actionType ?? "", label: Array.from(entry.label ?? "").slice(0,120).join(""),
      approvalId: entry.approvalId ?? null, phase: entry.phase ?? "before", ok: entry.ok ?? null,
    };
    const refusal = entry.phase === "refused" ? { reasonCode: entry.reasonCode, actor: entry.actor } : {};
    const prev = this.#rows.at(-1)?.hash ?? GENESIS;
    const hashed = { ...row, ...refusal };
    const body = JSON.stringify(hashed, Object.keys(hashed).sort((a,b) => a < b ? -1 : a > b ? 1 : 0));
    const hash = createHash("sha256").update(prev + body).digest("hex");
    const full = { ...row, prev, ...refusal, hash };
    const rows = [...this.#rows, full];
    if (this.path !== undefined) {
      const payload = Buffer.from(JSON.stringify({ prev: hash, rows }, null, 2));
      writePrivate(this.path, this.#seal?.seal(payload) ?? payload);
    }
    this.#rows = rows;
    return { ...full };
  }
  recent(n = 5, day?: string) {
    const rows = hasText(day) ? this.#rows.filter(row => row.day === day) : this.#rows;
    return rows.slice(-n).map(row => ({ ...row }));
  }
  speakRecent(n = 5) {
    const rows = this.recent(n * 2, localDay(this.#now())).filter(row => row.phase === "before").slice(-n);
    if (rows.length === 0) return "오늘 기록된 조작이 없어요.";
    const items = rows.map((row, i) => `${i + 1}. ${row.label.length > 0 ? row.label : row.actionType.length > 0 ? row.actionType : "조작"}${row.host.length > 0 ? ", " + row.host : ""}`);
    return `오늘 한 일 ${items.length}건이에요. ${items.join(". ")}.`;
  }
}
