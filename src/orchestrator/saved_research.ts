import { RESEARCH_RESTART } from "../core/research_copy.ts";
import type { AnswerOutcome, JobPhase, ResearchDesk, SavedJob } from "../core/research_desk.ts";
import { draft, type Draft, type Lang } from "../core/turn.ts";
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
const ALREADY_ENDED: Phrase = {
  ko: "이미 끝났거나 취소된 조사예요.", en: "That research has already finished or been cancelled.",
  zh: "那项调查已经结束或已取消。", ja: "その調査はすでに終わったか、取り消されています。",
};
const NOTHING_FITS: Record<SavedAction, (meant: readonly SavedJob[]) => Phrase> = {
  read: meant => meant.some(job => job.phase.kind === "working") ? STILL_WORKING : NO_SAVED_RESEARCH,
  answer: () => NOTHING_ASKED,
  cancel: () => ALREADY_ENDED,
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
const CANCELLED: Record<Lang, (request: string) => string> = {
  ko: request => `‘${request}’ 조사를 취소했어요.`,
  en: request => `I cancelled the research on “${request}”.`,
  zh: request => `已取消“${request}”的调查。`,
  ja: request => `「${request}」の調査を取り消しました。`,
};
export const NEEDS_PERSONAL_DEVICE = "자료 조사를 맡기려면 이용 설정에서 개인 기기를 선택해 주세요.";

const LISTED = 8;
const REQUEST_LENGTH = 120;
const ASKED_ABOUT = 3;

export const READING_PLACEHOLDER = "[저장한 조사 결과를 읽어 드렸어요]";

export interface PlannerView {
  readonly saved: PlannerSaved;
  /** 플래너가 본 그대로의 조사 목록 */
  readonly jobs: readonly SavedJob[];
  resolve(ref: string): string | undefined;
}

function plannerState(phase: JobPhase): PlannerJob["state"] {
  return phase.kind === "asking" && phase.revision === undefined ? "asking-restart" : phase.kind;
}

export function plannerView(jobs: readonly SavedJob[], lastSaved: string | undefined, redact: (text: string) => string): PlannerView {
  const listed = jobs.slice(0, LISTED).map((job, i) => ({ ...job, ref: `j${i + 1}` }));
  const ids = new Map(listed.map(job => [job.ref, job.id]));
  return {
    jobs: jobs.slice(0, LISTED),
    saved: { jobs: listed.map(job => ({
      ref: job.ref, request: Array.from(redact(job.request)).slice(0, REQUEST_LENGTH).join(""), state: plannerState(job.phase), savedOn: job.savedOn,
      ...(job.id === lastSaved ? { lastSaved: true } : {}),
    })) },
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

const NAMED: Record<Lang, (requests: readonly string[]) => string> = {
  ko: requests => requests.map(request => `‘${request}’`).join(", "),
  en: requests => new Intl.ListFormat("en", { type: "disjunction" }).format(requests.map(request => `“${request}”`)),
  zh: requests => requests.map(request => `“${request}”`).join("、"),
  ja: requests => requests.map(request => `「${request}」`).join("、"),
};
const WHICH_ONE: Record<SavedAction, Record<Lang, (names: string) => string>> = {
  read: {
    ko: names => `맡긴 조사가 여러 개예요. ${names} 중 어떤 것을 읽어 드릴까요?`,
    en: names => `You have several saved research jobs. Which should I read: ${names}?`,
    zh: names => `您有几项已保存的调查。${names}，要读哪一项？`,
    ja: names => `お預かりした調査がいくつかあります。${names}のどれを読みましょうか。`,
  },
  answer: {
    ko: names => `답을 기다리는 조사가 여러 개예요. ${names} 중 어느 것에 답하시는지, 조사 이름과 답을 함께 말씀해 주세요.`,
    en: names => `Several saved research jobs are waiting for an answer. Please say which one you are answering together with your answer: ${names}.`,
    zh: names => `有几项调查在等您的回答。${names}，请把要回答的调查名称和回答一起说。`,
    ja: names => `お答えを待っている調査がいくつかあります。${names}のどれへのお答えか、調査の名前とお答えを一緒にお話しください。`,
  },
  cancel: {
    ko: names => `맡긴 조사가 여러 개예요. ${names} 중 어떤 것을 취소할까요?`,
    en: names => `You have several saved research jobs. Which should I cancel: ${names}?`,
    zh: names => `您有几项已保存的调查。${names}，要取消哪一项？`,
    ja: names => `お預かりした調査がいくつかあります。${names}のどれを取り消しましょうか。`,
  },
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
    const desk = this.#session.deps.research;
    if (desk === undefined) return undefined;
    const jobs = await desk.recent(LISTED).catch(() => undefined);
    return jobs === undefined ? undefined : plannerView(jobs, this.#lastSaved, text => this.#session.modelSpeech(text));
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
    // 답은 플래너가 본 질문의 번호로 넣는다. 그사이 질문이 바뀌었으면 저장소가 받지 않는다(stale).
    const listed = request.action === "answer" ? view.jobs : await desk.recent(LISTED);
    const meant = request.jobs.length === 0 ? listed : listed.filter(job => named.has(job.id));
    const [job, ...others] = meant.filter(candidate => fits(request.action, candidate.phase));
    if (job === undefined) return draft(s.state, "none", NOTHING_FITS[request.action](meant)[lang], { lang });
    if (others.length > 0) {
      const names = NAMED[lang]([job, ...others].slice(0, ASKED_ABOUT).map(candidate => candidate.request));
      return draft(s.state, "clarify", WHICH_ONE[request.action][lang](names), { lang });
    }
    switch (request.action) {
      case "read": return this.#read(desk, job);
      case "answer": return this.#answer(desk, job, request.answer);
      case "cancel": return this.#cancel(desk, job);
    }
  }

  async #read(desk: ResearchDesk, job: SavedJob): Promise<Draft> {
    const s = this.#session;
    const reading = await desk.read(job.id, s.personal.speech().length);
    if (reading === undefined) return draft(s.state, "none", NO_SAVED_RESEARCH[s.lang], { lang: s.lang });
    const savedResearch = { jobId: reading.jobId, reading: true, ...(reading.receipt === undefined ? {} : { token: reading.receipt.token }) };
    return draft(s.state, "web-answer", reading.speech, { lang: reading.lang, sources: [...reading.sources], savedResearch });
  }

  async #answer(desk: ResearchDesk, job: SavedJob, answer: string): Promise<Draft> {
    const s = this.#session, lang = s.lang;
    const revision = job.phase.kind === "asking" ? job.phase.revision : undefined;
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
    return draft(s.state, "none", CANCELLED[lang](cancelled.request), { lang, ...(savedResearch === undefined ? {} : { savedResearch }) });
  }
}
