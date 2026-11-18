import { getOpcodes } from "../../core/sequence_matcher.ts";
import { strip } from "../../core/text.ts";
import { chunkText, josa } from "../../speech/phrasing.ts";
import type { WebObservation } from "./view.ts";

export type Effect = "moved" | "changed" | "none";
export const effectPatterns = {
  loading: /(불러오는\p{White_Space}*중|로딩\p{White_Space}*중|읽어\p{White_Space}*오는\p{White_Space}*중|조회\p{White_Space}*중|처리\p{White_Space}*중|잠시만\p{White_Space}*기다려|load[iİ]ng|please\p{White_Space}*wa[iİ]t)/iu,
  newlines: /\n+/gu,
};
export const LOADING_MAX_CHARS = 80;
export const CHURN_CONFIRMATIONS = 2;

export function pressResult(pressed: string, effect?: Effect, { revealed, moved }: { revealed?: string; moved?: string } = {}): string {
  if (effect === "none") return pressed + " 눌렀지만 화면이 바뀌지 않았어요.";
  if (effect === "changed") {
    const shown = chunkText((revealed ?? "").replace(effectPatterns.newlines, " "), 0);
    return pressed + " 눌렀어요. " + (shown.length > 0 ? "새로 보이는 내용입니다. " + shown : "같은 화면에서 내용이 바뀌었어요.");
  }
  return moved !== undefined && moved.length > 0 ? moved : pressed + " 눌렀어요.";
}

export function unconfirmedMessage(what: string): string {
  return what + " 확인하지 못했어요.";
}

export function clickNote(target: string, { status, effect, revealed, title, message, candidates }: {
  status: string; effect?: Effect; revealed?: string; title?: string; message?: string; candidates?: readonly string[];
}): string {
  const pressed = josa("'" + target + "'", "을", "를");
  if (status === "ok" && effect === "changed") {
    return pressResult(pressed, "changed", { revealed: strip((revealed ?? "").split("\n")[0]!) });
  }
  if (status === "ok" && effect === "none") return pressResult(pressed, "none");
  if (status === "ok") return pressResult(pressed, "moved", { moved: title === undefined || title === "" ? undefined : "'" + title + "' 열림" });
  if (status === "unconfirmed") return message === undefined || message === "" ? unconfirmedMessage("눌렸는지") : message;
  if (status === "policy-denied") return "안전 규칙으로 막힘: " + (message ?? "");
  if (candidates !== undefined && candidates.length > 0) return "여러 개가 맞음: " + candidates.join(", ");
  return message === undefined || message === "" ? "누르지 못함" : message;
}

export function looksLoading(text: string): boolean {
  return Array.from(text).length < LOADING_MAX_CHARS && effectPatterns.loading.test(text);
}

function lines(view: WebObservation): string[] {
  return (view.outline?.mainText ?? "").split("\n").map(strip).filter(line => line.length > 0);
}

function samePage(a: WebObservation, b: WebObservation): boolean {
  return a.url === b.url && a.title === b.title;
}

export function openedDialog(before: WebObservation, after: WebObservation): boolean {
  const old = new Set(before.dialogs?.map(d => d.title));
  return after.dialogs?.some(d => !old.has(d.title)) === true;
}

export function itemChanged(before: WebObservation, after: WebObservation, ref?: string): boolean {
  if (ref === undefined || ref.length === 0) return false;
  const old = before.outline?.items?.find(item => item.ref === ref);
  const next = after.outline?.items?.find(item => item.ref === ref);
  return (old === undefined) !== (next === undefined) || old?.selected !== next?.selected || old?.expanded !== next?.expanded;
}

export function changedBlocks(old: readonly string[], next: readonly string[]) {
  return getOpcodes(old, next).filter(([tag]) => tag !== "equal").map(([, , , start, end]) => ({
    anchor: next[start - 1] ?? "", lines: next.slice(start, end),
  }));
}

export interface ChurnState {
  page?: readonly [string, string];
  counts: Record<string, number>;
  widths: Record<string, number>;
}

export class Churn {
  #page?: readonly [string, string];
  readonly #counts: Map<string, number>;
  readonly #widths: Map<string, number>;

  constructor(state?: ChurnState) {
    this.#page = state?.page;
    this.#counts = new Map(Object.entries(state?.counts ?? {}));
    this.#widths = new Map(Object.entries(state?.widths ?? {}));
  }

  snapshot(): ChurnState {
    return { page: this.#page, counts: Object.fromEntries(this.#counts), widths: Object.fromEntries(this.#widths) };
  }

  observe(view: WebObservation, idlePrev?: WebObservation): void {
    const url = view.url ?? "", title = view.title ?? "";
    if (this.#page?.[0] !== url || this.#page[1] !== title) {
      this.#page = [url, title];
      this.#counts.clear();
      this.#widths.clear();
    }
    if (idlePrev === undefined || !samePage(idlePrev, view)) return;
    const blocks = changedBlocks(lines(idlePrev), lines(view));
    for (const anchor of new Set(blocks.map(block => block.anchor))) {
      this.#counts.set(anchor, (this.#counts.get(anchor) ?? 0) + 1);
    }
    for (const block of blocks) this.#widths.set(block.anchor, Math.max(this.#widths.get(block.anchor) ?? 0, block.lines.length));
  }

  volatile(): Record<string, number> {
    return Object.fromEntries([...this.#counts].filter(([, n]) => n >= CHURN_CONFIRMATIONS)
      .map(([anchor]) => [anchor, this.#widths.get(anchor)!]));
  }
}

export function diffViews(before: WebObservation, after: WebObservation, ref?: string,
  volatile: Readonly<Record<string, number>> = {}): [Effect, string] {
  if (!samePage(after, before)) return ["moved", ""];
  const old = lines(before), seen = new Set(old);
  const clicked = ref === undefined ? undefined
    : after.outline?.items?.find(item => item.ref === ref)?.name ?? before.outline?.items?.find(item => item.ref === ref)?.name;
  const blocks: string[][] = [];
  for (const block of changedBlocks(old, lines(after))) {
    if (!Object.hasOwn(volatile, block.anchor)) blocks.push(block.lines);
    else {
      const rest = block.lines.slice(volatile[block.anchor]);
      if (rest.length > 0) blocks.push(rest);
    }
  }
  let revealed = blocks.flat().filter(line => !seen.has(line) && strip(line.replaceAll("선택됨", "")) !== clicked);
  const oldDialogs = new Set(before.dialogs?.map(d => d.title));
  const newDialogs = (after.dialogs ?? []).filter(d => !oldDialogs.has(d.title));
  if (revealed.length === 0) revealed = newDialogs.flatMap(d => d.text === undefined || d.text === "" ? [] : [d.text]);
  const changed = revealed.length > 0 || newDialogs.length > 0 || itemChanged(before, after, ref) || blocks.length > 0;
  return changed ? ["changed", Array.from(revealed.join("\n")).slice(0, 600).join("")] : ["none", ""];
}
