import { createHash } from "node:crypto";
import { z } from "zod";
import type { Redacted } from "../core/llm.ts";
import { type Seal, readPrivateFile, writePrivateFile } from "./seal.ts";

const GENESIS = "0".repeat(64);
const RowSchema = z.object({
  seq: z.number().int(), day: z.string(), at: z.string(), host: z.string(), pageKind: z.string(),
  actionType: z.string(), label: z.string(), approvalId: z.string().nullable(),
  phase: z.enum(["before", "after"]), ok: z.boolean().nullable(), prev: z.string(), hash: z.string(),
});
type Row = z.infer<typeof RowSchema>;
export type AuditEntry = Partial<Pick<Row, "host" | "pageKind" | "actionType" | "approvalId" | "phase" | "ok">> & { label?: Redacted };

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
    try {
      const existing = readPrivateFile(path, seal);
      if (existing === undefined) return;
      const { rows } = z.object({ rows: z.array(RowSchema) }).parse(existing.data);
      const cutoff = new Date(now());
      cutoff.setDate(cutoff.getDate() - 30);
      const firstDay = localDay(cutoff);
      this.#rows = rows.filter(row => row.day >= firstDay);
    } catch { /* 손상된 기록은 다음 조작 전까지 원본 그대로 둔다. */ }
  }
  append(entry: AuditEntry): Row {
    const now = this.#now();
    const row = {
      seq: this.#rows.length + 1, day: localDay(now), at: now.toISOString(), host: entry.host ?? "",
      pageKind: entry.pageKind ?? "", actionType: entry.actionType ?? "", label: Array.from(entry.label ?? "").slice(0,120).join(""),
      approvalId: entry.approvalId ?? null, phase: entry.phase ?? "before", ok: entry.ok ?? null,
    };
    const prev = this.#rows.at(-1)?.hash ?? GENESIS;
    const body = JSON.stringify(row, Object.keys(row).sort((a,b) => a < b ? -1 : a > b ? 1 : 0));
    const hash = createHash("sha256").update(prev + body).digest("hex");
    const full = { ...row, prev, hash };
    const rows = [...this.#rows, full];
    if (this.path !== undefined) writePrivateFile(this.path, { prev: hash, rows }, this.#seal);
    this.#rows = rows;
    return { ...full };
  }
  recent(n = 5, day?: string) {
    const rows = day === undefined ? this.#rows : this.#rows.filter(row => row.day === day);
    return rows.slice(-n).map(row => ({ ...row }));
  }
  speakRecent(n = 5) {
    const rows = this.recent(n * 2, localDay(this.#now())).filter(row => row.phase === "before").slice(-n);
    if (rows.length === 0) return "오늘 기록된 조작이 없어요.";
    const items = rows.map((row, i) => `${i + 1}. ${row.label.length > 0 ? row.label : row.actionType.length > 0 ? row.actionType : "조작"}${row.host.length > 0 ? ", " + row.host : ""}`);
    return `오늘 한 일 ${items.length}건이에요. ${items.join(". ")}.`;
  }
}
