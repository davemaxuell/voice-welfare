import type { JobPhase, SavedJob } from "../core/research_desk.ts";
import { draft, type Draft, type Lang } from "../core/turn.ts";
import { redactText } from "../safety/privacy.ts";
import type { PlannerJob, PlannerSaved, SavedDecision } from "./public_task.ts";
import type { SessionOrchestrator } from "./session.ts";

const NO_SAVED_RESEARCH: Record<Lang, string> = {
  ko: "아직 확인할 조사 결과가 없어요.", en: "There are no saved research results ready yet.",
  zh: "目前还没有可查看的调查结果。", ja: "確認できる調査結果はまだありません。",
};
const STILL_WORKING: Record<Lang, string> = {
  ko: "아직 조사하고 있어요. 끝나면 알려 드릴게요.", en: "I’m still working on that research. I’ll tell you when it’s done.",
  zh: "那项调查还在进行中。完成后我会告诉您。", ja: "その調査はまだ進めています。終わったらお知らせします。",
};
const WHICH_SAVED: Record<Lang, string> = {
  ko: "어느 조사를 말씀하시는지 잘 모르겠어요. 맡기신 조사의 주제를 말씀해 주세요.",
  en: "I’m not sure which saved research you mean. Please tell me what it was about.",
  zh: "我不确定您指的是哪一项调查。请告诉我它的主题。", ja: "どの調査のことか分かりませんでした。調査の内容を教えてください。",
};
export const NEEDS_PERSONAL_DEVICE = "자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요.";

const LISTED = 8;
const REQUEST_LENGTH = 120;
const ASKED_ABOUT = 3;

export const READING_PLACEHOLDER = "[저장한 조사 결과를 읽어 드렸어요]";

export interface PlannerView {
  readonly saved: PlannerSaved;
  resolve(ref: string): string | undefined;
}

function plannerState(phase: JobPhase): PlannerJob["state"] {
  return phase.kind === "asking" && phase.revision === undefined ? "asking-restart" : phase.kind;
}

export function plannerView(jobs: readonly SavedJob[], lastSaved: string | undefined, redact: (text: string) => string): PlannerView {
  const listed = jobs.slice(0, LISTED).map((job, i) => ({ ...job, ref: `j${i + 1}` }));
  const ids = new Map(listed.map(job => [job.ref, job.id]));
  return {
    saved: { jobs: listed.map(job => ({
      ref: job.ref, request: Array.from(redact(job.request)).slice(0, REQUEST_LENGTH).join(""), state: plannerState(job.phase), savedOn: job.savedOn,
      ...(job.id === lastSaved ? { lastSaved: true } : {}),
    })) },
    resolve: ref => ids.get(ref),
  };
}

const FITS: Record<SavedDecision["action"], ReadonlySet<JobPhase["kind"]>> = {
  read: new Set(["ready", "asking"]),
};
export function fits(action: SavedDecision["action"], phase: JobPhase): boolean {
  return FITS[action].has(phase.kind);
}

function whichToRead(requests: readonly string[], lang: Lang): string {
  return {
    ko: `맡긴 조사가 여러 개예요. ${requests.map(request => `‘${request}’`).join(", ")} 중 어떤 것을 읽어 드릴까요?`,
    en: `You have several saved research jobs. Which should I read: ${new Intl.ListFormat("en", { type: "disjunction" }).format(requests.map(request => `“${request}”`))}?`,
    zh: `您有几项已保存的调查。${requests.map(request => `“${request}”`).join("、")}，要读哪一项？`,
    ja: `お預かりした調査がいくつかあります。${requests.map(request => `「${request}」`).join("、")}のどれを読みましょうか。`,
  }[lang];
}

export class SavedResearch {
  readonly #session: SessionOrchestrator;
  #lastSaved: string | undefined;

  constructor(session: SessionOrchestrator) { this.#session = session; }

  get lastSaved(): string | undefined { return this.#lastSaved; }

  async delegate(requestId: string, goal: string, { expired = false } = {}): Promise<Draft> {
    const saved = expired ? undefined : await this.#session.deps.research?.delegate(requestId, goal);
    if (saved === undefined) return draft("IDLE", "none", "조사를 시작하지 못했어요. 개인 기기 설정과 질문을 확인해 주세요.");
    this.#lastSaved = saved.jobId;
    return draft("IDLE", "none", "조사를 맡겼어요. 결과가 나오면 알려 드릴게요.", { researchDelivery: "queued" });
  }

  async plannerView(): Promise<PlannerView | undefined> {
    const desk = this.#session.deps.research;
    if (desk === undefined) return undefined;
    const jobs = await desk.recent(LISTED).catch(() => undefined);
    return jobs === undefined ? undefined : plannerView(jobs, this.#lastSaved, redactText);
  }

  unclear(): Draft {
    const s = this.#session;
    if (s.deps.research === undefined) return draft(s.state, "clarify", NEEDS_PERSONAL_DEVICE);
    return draft(s.state, "clarify", WHICH_SAVED[s.lang], { lang: s.lang });
  }

  async handle(request: SavedDecision, view: PlannerView): Promise<Draft> {
    const s = this.#session;
    const desk = s.deps.research, lang = s.lang;
    if (desk === undefined) return this.unclear();
    const named = new Set(request.jobs.map(ref => view.resolve(ref)));
    const listed = await desk.recent(LISTED);
    const meant = request.jobs.length === 0 ? listed : listed.filter(job => named.has(job.id));
    const [job, ...others] = meant.filter(candidate => fits(request.action, candidate.phase));
    if (job === undefined) {
      const working = meant.some(candidate => candidate.phase.kind === "working");
      return draft(s.state, "none", (working ? STILL_WORKING : NO_SAVED_RESEARCH)[lang], { lang });
    }
    if (others.length > 0) {
      return draft(s.state, "clarify", whichToRead([job, ...others].slice(0, ASKED_ABOUT).map(candidate => candidate.request), lang), { lang });
    }
    const reading = await desk.read(job.id, s.personal.speech().length);
    if (reading === undefined) return draft(s.state, "none", NO_SAVED_RESEARCH[lang], { lang });
    const savedResearch = { jobId: reading.jobId, reading: true, ...(reading.receipt === undefined ? {} : { token: reading.receipt.token }) };
    return draft(s.state, "web-answer", reading.speech, { lang: reading.lang, sources: [...reading.sources], savedResearch });
  }
}
