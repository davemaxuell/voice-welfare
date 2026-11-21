import { createHash } from "node:crypto";
import { REDACTED, redactPictureText } from "../../safety/privacy.ts";
import type { WebObservation } from "./view.ts";

export type JourneyAssessment = "progress" | "dead_end" | "unknown";
type Stage = "entry" | "navigation" | "reading" | "recovery";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const clip = (value: string, length: number) => [...value].slice(0, length).join("");
export function webOrigin(raw: string | undefined): string | undefined {
  const url = URL.parse(raw ?? "");
  return url && ["http:", "https:"].includes(url.protocol) && url.username.length === 0 && url.password.length === 0 ? url.origin : undefined;
}

// 모델 입력과 근거에는 주소 경로와 개인 식별자를 보내지 않는다.
const urls = /https?:\/\/[^\s<>\[\]()"']+|(?<![\p{L}\p{N}\]])\/\/?[^\s<>\[\]()"']+/giu;
const opaque = /(?<![\p{L}\p{N}_])(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{9,}(?![\p{L}\p{N}_])/gu;

/** 화면·계획·근거에서 관찰된 입력값과 주소를 가린다. */
export function personalScrubber(view?: WebObservation, known: readonly string[] = []): (value: string) => string {
  const url = URL.parse(view?.url ?? "");
  const path = url?.pathname.split("/").filter(part => /[%\p{Nd}]/u.test(part)) ?? [];
  const fields = (view?.fields ?? []).flatMap(field => field.visible === true && typeof field.value === "string" &&
    field.type !== "checkbox" && field.type !== "radio" ? [field.value] : []);
  const fragment = url?.hash.slice(1) ?? "";
  const raw = [...known, ...fields, ...path, ...Array.from(url?.searchParams.values() ?? []),
    fragment, ...Array.from(new URLSearchParams(fragment).values())];
  const values = [...new Set(raw.flatMap(value => {
    try { return [value, decodeURIComponent(value), encodeURIComponent(value)]; } catch { return [value]; }
  }).filter(value => value.length > 0))].sort((a, b) => b.length - a.length);
  return value => {
    value = value.replace(urls, REDACTED);
    for (const secret of values) value = value.replaceAll(secret, REDACTED);
    return redactPictureText(value.replace(opaque, REDACTED));
  };
}

interface Screen {
  id: number;
  origin: string;
  urlKey: string;
  title: string;
  selected: string[];
}

interface Attempt {
  action: string;
  key: string;
  target?: string;
  before?: Screen;
  after?: Screen;
  expected?: string;
  outcome: JourneyAssessment | "auth" | "captcha" | "approval_required";
}

const stageOf = (action: string, entry: boolean): Stage => {
  if (action === "back") return "recovery";
  if (action === "find_portal" || entry) return "entry";
  if (["find_links", "more_links", "find", "read_more", "inspect_screen"].includes(action)) return "reading";
  return "navigation";
};

/** 사용자가 조작하다 돌아와도 같은 일의 탐색 기록과 한도를 유지한다. */
export class BrowserJourney {
  blockedBy?: "auth" | "captcha" | "approval";
  returnOrigin?: string;
  lastMilestone?: string;
  readonly #limit: number;
  readonly #stageLimits: Record<Stage, number>;
  readonly #stages: Record<Stage, number> = { entry: 0, navigation: 0, reading: 0, recovery: 0 };
  readonly #pages = new Map<string, Screen>();
  readonly #attempts: Attempt[] = [];
  readonly #dead = new Set<string>();
  readonly #tried = new Map<string, number>();
  readonly #trail: Screen[] = [];
  readonly #notices = new Set<string>();
  readonly #completedSubgoals: string[] = [];
  #current?: Screen;
  #pending?: Attempt;
  #steps = 0;
  #timeUsed = 0;
  #timeLimit?: number;
  #resumed = false;
  #personal = false;
  #inspection = false;
  #deepScreen?: Screen;
  #lastPortal?: string;
  #agencyDiscoveryUsed = false;

  constructor(maxSteps: number) {
    this.#limit = maxSteps;
    this.#stageLimits = {
      entry: Math.min(maxSteps, 3), navigation: maxSteps,
      reading: Math.ceil(maxSteps / 2), recovery: Math.min(maxSteps, 2),
    };
  }

  get remaining(): number { return Math.max(0, this.#limit - this.#steps); }
  get resumed(): boolean { return this.#resumed; }
  get canDiscoverAgency(): boolean { return !this.#resumed && !this.#agencyDiscoveryUsed; }

  useAgencyDiscovery(): void { this.#agencyDiscoveryUsed = true; }

  reservePersonalInspection(): void { this.#personal = true; }
  get #reserve(): number { return this.#personal ? Math.floor(this.#limit / 3) : 0; }

  admit(action: string): boolean {
    if (this.#personal && this.#current !== undefined && this.#current === this.#deepScreen &&
      ["find", "read_more", "answer"].includes(action)) this.#inspection = true;
    return this.#inspection || this.#resumed || this.remaining > this.#reserve;
  }

  takeStep(): void { this.#steps++; }
  timeRemaining(limit: number): number {
    this.#timeLimit ??= limit;
    return Math.max(0, this.#timeLimit - this.#timeUsed);
  }
  takeTime(elapsed: number): void { this.#timeUsed += elapsed; }

  pause(reason: NonNullable<BrowserJourney["blockedBy"]>, url?: string): void {
    this.blockedBy = reason;
    if (reason === "auth" || reason === "captcha") {
      this.returnOrigin = this.#lastPortal ?? webOrigin(url);
      const latest = this.#attempts.at(-1);
      if (latest !== undefined && latest.after === this.#current) latest.outcome = reason;
    }
  }

  resumeAfterAuth(): void {
    if (this.blockedBy !== "auth" && this.blockedBy !== "captcha") return;
    this.#resumed = true;
    this.#markCompleted("사용자가 직접 인증을 마침");
    this.#resume();
  }

  resumeAfterApproval(): void {
    if (this.blockedBy === "approval") this.#resume();
  }

  #resume(): void {
    this.blockedBy = undefined;
    this.#pending = undefined;
    this.#current = undefined;
    this.#trail.length = 0;
  }

  notice(key: string, speech: string): boolean {
    if (this.#notices.has(key)) return false;
    this.#notices.add(key);
    this.lastMilestone = speech;
    return true;
  }

  observe(view: WebObservation | undefined, scrub: (text: string) => string, portal = false): void {
    const url = view?.url, origin = webOrigin(url);
    if (url === undefined || origin === undefined || view?.pageId === "blank") {
      this.#current = undefined;
      return;
    }
    const controls = view?.outline?.items ?? [];
    const headings = (view?.outline?.headings ?? []).slice(0, 8).map(heading => heading.text);
    const selected = controls.filter(item => item.selected === true || item.expanded === true);
    const urlKey = digest(url);
    const title = view?.title ?? "";
    const identity = digest(JSON.stringify([urlKey, title, headings, selected.map(item => item.name),
      (view?.outline?.mainText ?? "").slice(0, 600)]));
    let screen = this.#pages.get(identity);
    if (screen === undefined) {
      screen = { id: this.#pages.size + 1, origin, urlKey, title: clip(scrub(title), 100),
        selected: selected.flatMap(item => item.pictureMasked === true || item.name === undefined || item.name.length === 0 ? [] : [clip(scrub(item.name), 80)]).slice(0, 6) };
      this.#pages.set(identity, screen);
    }
    this.#current = screen;
    if (portal) this.#lastPortal = origin;
  }

  canTry(action: string, target: string | undefined, position: number): boolean {
    const stage = stageOf(action, this.#current === undefined);
    const key = this.#edgeKey(action, target, position);
    return this.#stages[stage] < this.#stageLimits[stage] && !this.#dead.has(key) && (this.#tried.get(key) ?? 0) < 2;
  }

  get canBack(): boolean {
    const previous = this.#trail.at(-1);
    return previous !== undefined && this.#current !== undefined && previous.origin === this.#current.origin &&
      previous.urlKey !== this.#current.urlKey && this.canTry("back", undefined, 0);
  }

  get canRecoverByBack(): boolean {
    const last = this.#attempts.at(-1);
    return this.canBack && last?.after === this.#current && last?.before?.urlKey !== last?.after?.urlKey;
  }

  #edgeKey(action: string, target: string | undefined, position: number): string {
    return digest(JSON.stringify([this.#current?.id, action, target ?? "", position]));
  }

  begin(action: string, target: string | undefined, position: number, expected?: string): void {
    this.#stages[stageOf(action, this.#current === undefined)]++;
    const key = this.#edgeKey(action, target, position);
    this.#tried.set(key, (this.#tried.get(key) ?? 0) + 1);
    this.#pending = {
      action, key, target: target === undefined ? undefined : clip(target, 100), before: this.#current,
      expected: expected === undefined ? undefined : clip(expected, 160), outcome: "unknown",
    };
  }

  finish(ok: boolean, navigation: boolean, approval: boolean): void {
    const attempt = this.#pending;
    if (attempt === undefined) return;
    this.#pending = undefined;
    attempt.after = this.#current;
    if (approval) attempt.outcome = "approval_required";
    else if (!ok) this.#markDead(attempt);
    const { before, after } = attempt;
    if (ok && navigation && before !== undefined && after !== undefined && before !== after && attempt.action !== "back") {
      this.#deepScreen = after;
    }
    if (ok && navigation && before !== undefined && after !== undefined && before.urlKey !== after.urlKey) {
      if (attempt.action === "back") {
        if (this.#trail.at(-1)?.urlKey === after.urlKey) this.#trail.pop();
        else this.#trail.length = 0;
      } else if (before.origin === after.origin) this.#trail.push(before);
      else this.#trail.length = 0;
    }
    this.#attempts.push(attempt);
    if (this.#attempts.length > 8) this.#attempts.shift();
  }

  #markDead(attempt: Attempt): void {
    this.#dead.add(attempt.key);
    attempt.outcome = "dead_end";
  }

  assess(outcome: JourneyAssessment | undefined): boolean {
    const last = this.#attempts.at(-1);
    if (last === undefined || last.after !== this.#current || last.outcome !== "unknown") return false;
    if (outcome === "dead_end" && last.action !== "back") {
      this.#markDead(last);
      return true;
    }
    if (outcome === "progress") {
      last.outcome = outcome;
      if (last.expected !== undefined && last.expected.length > 0) this.#markCompleted(last.expected);
    }
    return false;
  }

  #markCompleted(subgoal: string): void {
    if (this.#completedSubgoals.includes(subgoal)) return;
    this.#completedSubgoals.push(subgoal);
    if (this.#completedSubgoals.length > 6) this.#completedSubgoals.shift();
  }

  context(currentGoal: string | undefined) {
    const page = (screen: Screen | undefined) => screen && ({ id: screen.id, url: screen.origin, title: screen.title, selected: screen.selected });
    const budgets = Object.fromEntries(Object.entries(this.#stageLimits).map(([stage, limit]) => [stage, limit - this.#stages[stage as Stage]]));
    const inspecting = this.#resumed || this.#inspection;
    return {
      currentGoal, currentSubgoal: this.#attempts.at(-1)?.expected ?? currentGoal, subgoalsCompleted: [...this.#completedSubgoals],
      blockedBy: this.blockedBy ?? null, visited: [...this.#pages.values()].slice(-6).map(page),
      remaining: this.remaining,
      budgets: {
        ...budgets, portal: Math.max(0, this.remaining - (inspecting ? 0 : this.#reserve)),
        inspection: inspecting ? this.remaining : this.#reserve,
      },
      current: page(this.#current), canGoBack: this.canBack, resumed: this.#resumed,
      recent: this.#attempts.map(({ action, target, expected, outcome, before, after }) =>
        ({ action, target, expected, outcome, before: page(before), after: page(after) })),
    };
  }
}
