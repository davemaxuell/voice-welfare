import { JOB_CHOICE_KEYS, choiceLabel } from "../core/choices.ts";
import { RESEARCH_RESTART } from "../core/research_copy.ts";
import type { AnswerOutcome, JobPhase, ResearchDesk, SavedJob, SavedPick } from "../core/research_desk.ts";
import { draft, type Draft, type Lang } from "../core/turn.ts";
import { spokenRequest } from "../speech/research_reading.ts";
import type { PlannerJob, PlannerSaved, SavedDecision } from "./public_task.ts";
import type { SessionOrchestrator } from "./session.ts";

type SavedAction = SavedDecision["action"];
type Phrase = Record<Lang, string>;

const NO_SAVED_RESEARCH: Phrase = {
  ko: "아직 확인할 조사 결과가 없어요.", en: "There are no saved research results ready yet.",
  zh: "目前还没有可查看的调查结果。", ja: "確認できる調査結果はまだありません。",
};
const STILL_WORKING: Phrase = {
  ko: "아직 조사하고 있어요. 끝나면 알려 드릴게요.", en: "I’m still working on that research. I’ll tell you when it’s done.",
  zh: "那项调查还在进行中。完成后我会告诉您。", ja: "その調査はまだ進めています。終わったらお知らせします。",
};
const WHICH_SAVED: Phrase = {
  ko: "어느 조사를 말씀하시는지 잘 모르겠어요. 맡기신 조사의 주제를 말씀해 주세요.",
  en: "I’m not sure which saved research you mean. Please tell me what it was about.",
  zh: "我不确定您指的是哪一项调查。请告诉我它的主题。", ja: "どの調査のことか分かりませんでした。調査の内容を教えてください。",
};
const NOTHING_ASKED: Phrase = {
  ko: "지금 답을 기다리는 조사가 없어요.", en: "No saved research is waiting for an answer right now.",
  zh: "目前没有等待您回答的调查。", ja: "いま、お答えを待っている調査はありません。",
};
const NO_LONGER_ASKING: Phrase = {
  ko: "그 조사는 이제 답을 기다리지 않아요.", en: "That research isn’t waiting for an answer anymore.",
  zh: "那项调查已不再等待您的回答。", ja: "その調査は、もうお答えを待っていません。",
};
const ALREADY_ENDED: Phrase = {
  ko: "이미 끝났거나 취소된 조사예요.", en: "That research has already finished or been cancelled.",
  zh: "那项调查已经结束或已取消。", ja: "その調査はすでに終わったか、取り消されています。",
};
type Scope = "all" | "pointed";
const anyWorking = (meant: readonly SavedJob[]) => meant.some(job => job.phase.kind === "working");
const NOTHING_FITS: Record<Scope, Record<SavedAction, (meant: readonly SavedJob[]) => Phrase>> = {
  all: {
    read: meant => anyWorking(meant) ? STILL_WORKING : NO_SAVED_RESEARCH,
    answer: () => NOTHING_ASKED,
    cancel: () => ALREADY_ENDED,
  },
  pointed: {
    read: meant => anyWorking(meant) ? STILL_WORKING : ALREADY_ENDED,
    answer: () => NO_LONGER_ASKING,
    cancel: () => ALREADY_ENDED,
  },
};
const ANSWERED: Record<AnswerOutcome, Phrase> = {
  queued: {
    ko: "답을 받았어요. 이어서 조사할게요.", en: "Got your answer. I’ll continue the research.",
    zh: "已收到您的回答。我会继续调查。", ja: "お答えを受け取りました。調査を続けます。",
  },
  stale: {
    ko: "그 질문은 이미 바뀌었어요.", en: "That question has already changed.",
    zh: "那个问题已经变了。", ja: "その質問はすでに変わっています。",
  },
  unsafe: {
    ko: "답에 개인정보나 비밀 값이 있는 것 같아 보내지 않았어요. 공개해도 되는 말로 다시 답해 주세요.",
    en: "I didn’t send that answer because it may contain personal or secret information. Please answer again with details that are safe to share.",
    zh: "这个回答可能含有个人信息或保密内容，所以没有发送。请用可以公开的内容再回答一次。",
    ja: "お答えに個人情報や秘密の値が含まれているようなので、送りませんでした。公開してよい内容でもう一度お答えください。",
  },
  refused: {
    ko: "답을 보내지 못했어요. 다시 말씀해 주세요.", en: "I couldn’t send your answer. Please say it again.",
    zh: "未能发送您的回答。请再说一次。", ja: "お答えを送れませんでした。もう一度お話しください。",
  },
};
const CANCELLED: Record<Lang, (name: string) => string> = {
  ko: name => `‘${name}’ 조사를 취소했어요.`,
  en: name => `I cancelled the research on “${name}”.`,
  zh: name => `已取消“${name}”的调查。`,
  ja: name => `「${name}」の調査を取り消しました。`,
};
export const NEEDS_PERSONAL_DEVICE = "자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요.";

const LISTED = 8;
const REQUEST_LENGTH = 120;

export const READING_PLACEHOLDER = "[저장한 조사 결과를 읽어 드렸어요]";

export interface PlannerView {
  readonly saved: PlannerSaved;
  /** 플래너가 본 그대로의 조사 목록 */
  readonly jobs: readonly SavedJob[];
  readonly pick: SavedPick | undefined;
  resolve(ref: string): string | undefined;
}

function plannerState(phase: JobPhase): PlannerJob["state"] {
  return phase.kind === "asking" && phase.revision === undefined ? "asking-restart" : phase.kind;
}

export function plannerView(jobs: readonly SavedJob[], lastSaved: string | undefined, redact: (text: string) => string, pick?: SavedPick): PlannerView {
  const listed = jobs.slice(0, LISTED).map((job, i) => ({ ...job, ref: `j${i + 1}` }));
  const ids = new Map(listed.map(job => [job.ref, job.id]));
  const refs = new Map(listed.map(job => [job.id, job.ref]));
  const options = (pick?.options ?? []).flatMap((option, i) => {
    const ref = refs.get(option.jobId);
    return ref === undefined ? [] : [{ number: i + 1, ref }];
  });
  const pending = pick === undefined || options.length === 0 ? undefined :
    pick.action === "answer" ? { action: pick.action, answer: pick.answer, options } : { action: pick.action, options };
  return {
    jobs: jobs.slice(0, LISTED),
    saved: {
      jobs: listed.map(job => ({
        ref: job.ref, request: Array.from(redact(job.request)).slice(0, REQUEST_LENGTH).join(""), state: plannerState(job.phase), savedOn: job.savedOn,
        ...(job.id === lastSaved ? { lastSaved: true } : {}),
      })),
      ...(pending === undefined ? {} : { pick: pending }),
    },
    pick,
    resolve: ref => ids.get(ref),
  };
}

const FITS: Record<SavedAction, ReadonlySet<JobPhase["kind"]>> = {
  read: new Set(["ready", "asking"]),
  answer: new Set(["asking"]),
  cancel: new Set(["working", "asking"]),
};
export function fits(action: SavedAction, phase: JobPhase): boolean {
  return FITS[action].has(phase.kind);
}

type Task = { readonly action: Exclude<SavedAction, "answer"> } | { readonly action: "answer"; readonly answer: string };

const askedRevision = (job: SavedJob) => job.phase.kind === "asking" ? job.phase.revision : undefined;
function questionRevision(job: SavedJob, pick: SavedPick | undefined): number | undefined {
  const offered = pick?.action === "answer" ? pick.options.find(option => option.jobId === job.id) : undefined;
  return offered === undefined ? askedRevision(job) : offered.revision;
}

const NUMBERED: Record<Lang, (number: string, name: string) => string> = {
  ko: (number, name) => `${number} ‘${name}’`,
  en: (number, name) => `${number} “${name}”`,
  zh: (number, name) => `${number}“${name}”`,
  ja: (number, name) => `${number}「${name}」`,
};
const NAMED: Record<Lang, (items: readonly string[]) => string> = {
  ko: items => items.join(", "),
  en: items => new Intl.ListFormat("en", { type: "disjunction" }).format(items),
  zh: items => items.join("、"),
  ja: items => items.join("、"),
};
const WHICH_ONE: Record<SavedAction, Record<Lang, (names: string) => string>> = {
  read: {
    ko: names => `맡긴 조사가 여러 개예요. ${names} 중 어떤 것을 읽어 드릴까요?`,
    en: names => `You have several saved research jobs. Which should I read: ${names}?`,
    zh: names => `您有几项已保存的调查。${names}，要读哪一项？`,
    ja: names => `お預かりした調査がいくつかあります。${names}のどれを読みましょうか。`,
  },
  answer: {
    ko: names => `답을 기다리는 조사가 여러 개예요. ${names} 중 어느 것에 답할까요?`,
    en: names => `Several saved research jobs are waiting for an answer. Which should I give your answer to: ${names}?`,
    zh: names => `有几项调查在等您的回答。${names}，要把您的回答交给哪一项？`,
    ja: names => `お答えを待っている調査がいくつかあります。${names}のどれにお答えを伝えましょうか。`,
  },
  cancel: {
    ko: names => `맡긴 조사가 여러 개예요. ${names} 중 어떤 것을 취소할까요?`,
    en: names => `You have several saved research jobs. Which should I cancel: ${names}?`,
    zh: names => `您有几项已保存的调查。${names}，要取消哪一项？`,
    ja: names => `お預かりした調査がいくつかあります。${names}のどれを取り消しましょうか。`,
  },
};
const MORE_FIT: Phrase = {
  ko: "이 밖에도 더 있어요. 다른 조사는 주제를 말씀해 주세요.", en: "There are more. For another one, tell me what it was about.",
  zh: "此外还有其他调查。要找别的，请说出它的主题。", ja: "ほかにもあります。別の調査は、その内容をお話しください。",
};

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
    const s = this.#session, desk = s.deps.research;
    if (desk === undefined) return undefined;
    const jobs = await desk.recent(LISTED).catch(() => undefined);
    return jobs === undefined ? undefined : plannerView(jobs, this.#lastSaved, text => s.modelSpeech(text), s.offeredPick);
  }

  unclear(): Draft {
    const s = this.#session;
    if (s.deps.research === undefined) return draft(s.state, "clarify", NEEDS_PERSONAL_DEVICE);
    return draft(s.state, "clarify", WHICH_SAVED[s.lang], { lang: s.lang });
  }

  async handle(request: SavedDecision, view: PlannerView): Promise<Draft> {
    const desk = this.#session.deps.research;
    if (desk === undefined) return this.unclear();
    const named = new Set(request.jobs.map(ref => view.resolve(ref)));
    // 답은 플래너가 본 질문의 번호로 넣는다. 그사이 질문이 바뀌었으면 저장소가 받지 않는다(stale).
    const listed = request.action === "answer" ? view.jobs : await desk.recent(LISTED);
    const scope: Scope = request.jobs.length === 0 ? "all" : "pointed";
    return this.#among(desk, scope === "all" ? listed : listed.filter(job => named.has(job.id)), scope, request, view.pick);
  }

  async choose(pick: SavedPick, jobId: string): Promise<Draft> {
    const desk = this.#session.deps.research;
    if (desk === undefined) return this.unclear();
    const listed = await desk.recent(LISTED);
    return this.#among(desk, listed.filter(job => job.id === jobId), "pointed", pick, pick);
  }

  async #among(desk: ResearchDesk, meant: readonly SavedJob[], scope: Scope, task: Task, pick: SavedPick | undefined): Promise<Draft> {
    const s = this.#session, lang = s.lang;
    const [job, ...others] = meant.filter(candidate => fits(task.action, candidate.phase));
    if (job === undefined) return draft(s.state, "none", NOTHING_FITS[scope][task.action](meant)[lang], { lang });
    if (others.length > 0) return this.#ask(task, [job, ...others]);
    switch (task.action) {
      case "read": return this.#read(desk, job);
      case "answer": return this.#answer(desk, job, task.answer, questionRevision(job, pick));
      case "cancel": return this.#cancel(desk, job);
    }
  }

  #ask(task: Task, candidates: readonly SavedJob[]): Draft {
    const s = this.#session, lang = s.lang;
    const offered = JOB_CHOICE_KEYS.flatMap((key, i) => {
      const job = candidates[i];
      return job === undefined ? [] : [{ key, job }];
    });
    const names = NAMED[lang](offered.map(({ key, job }) => NUMBERED[lang](choiceLabel(key, lang), spokenRequest(job.request))));
    const pick: SavedPick = task.action === "answer"
      ? { action: task.action, answer: task.answer, options: offered.map(({ job }) => ({ jobId: job.id, revision: askedRevision(job) })) }
      : { action: task.action, options: offered.map(({ job }) => ({ jobId: job.id })) };
    const sentences = [WHICH_ONE[task.action][lang](names), ...(candidates.length > offered.length ? [MORE_FIT[lang]] : [])];
    return draft(s.state, "clarify", sentences.join(lang === "zh" || lang === "ja" ? "" : " "), { lang, pick });
  }

  async #read(desk: ResearchDesk, job: SavedJob): Promise<Draft> {
    const s = this.#session;
    const reading = await desk.read(job.id, s.personal.speech().length);
    if (reading === undefined) return draft(s.state, "none", NO_SAVED_RESEARCH[s.lang], { lang: s.lang });
    const savedResearch = { jobId: reading.jobId, reading: true, ...(reading.receipt === undefined ? {} : { token: reading.receipt.token }) };
    return draft(s.state, "web-answer", reading.speech, { lang: reading.lang, sources: [...reading.sources], savedResearch });
  }

  async #answer(desk: ResearchDesk, job: SavedJob, answer: string, revision: number | undefined): Promise<Draft> {
    const s = this.#session, lang = s.lang;
    if (revision === undefined) return draft(s.state, "none", RESEARCH_RESTART[lang], { lang });
    const outcome = await desk.answer(job.id, revision, answer);
    return draft(s.state, "none", ANSWERED[outcome][lang], { lang, ...(outcome === "queued" ? { researchDelivery: "queued" as const } : {}) });
  }

  async #cancel(desk: ResearchDesk, job: SavedJob): Promise<Draft> {
    const s = this.#session, lang = s.lang;
    const cancelled = await desk.cancel(job.id);
    if (cancelled === undefined) return draft(s.state, "none", ALREADY_ENDED[lang], { lang });
    if (this.#lastSaved === job.id) this.#lastSaved = undefined;
    const savedResearch = cancelled.token === undefined ? undefined : { jobId: job.id, token: cancelled.token, reading: false };
    return draft(s.state, "none", CANCELLED[lang](spokenRequest(cancelled.request)), { lang, ...(savedResearch === undefined ? {} : { savedResearch }) });
  }
}
