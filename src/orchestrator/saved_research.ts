import { draft, type Draft, type Lang } from "../core/turn.ts";
import type { SessionOrchestrator } from "./session.ts";

const NO_SAVED_RESEARCH: Record<Lang, string> = {
  ko: "아직 확인할 조사 결과가 없어요.", en: "There are no saved research results ready yet.",
  zh: "目前还没有可查看的调查结果。", ja: "確認できる調査結果はまだありません。",
};
const ALL_JOBS = 50;

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

  /** 가장 최근에 읽어 줄 것이 있는 조사 하나를 읽어 준다. 조사를 다룰 수 없는 기기면 undefined. */
  async readNewest(lang: Lang): Promise<Draft | undefined> {
    const s = this.#session;
    const desk = s.deps.research;
    if (desk === undefined) return undefined;
    for (const job of await desk.recent(ALL_JOBS)) {
      if (job.phase.kind !== "ready" && job.phase.kind !== "asking") continue;
      const reading = await desk.read(job.id, s.personal.speech().length);
      if (reading !== undefined) return draft("IDLE", "web-answer", reading.speech, { lang: reading.lang, sources: [...reading.sources] });
    }
    return draft("IDLE", "web-answer", NO_SAVED_RESEARCH[lang], { lang });
  }
}
