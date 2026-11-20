import { createHash } from "node:crypto";
import { fromIsoDate, PROGRAMS, type DatasetCitation, type Program } from "./datasets.ts";

/** 민간 복지사업 한 건을 맞춤 찾기와 답 카드가 읽는 서비스 항목으로 옮긴 것. 상세 자료를 따로 받지 않는다. */
export type PrivateProgramEntry = {
  servId: string;
  servNm: string;
  organization: string;
  provider: "private";
  dataOrigin: "official-snapshot";
  lifeStages: string[];
  targets: string[];
  themes: string[];
  summary: string;
  target: string;
  benefit: string;
  applyMethod: string;
  documents: string;
  /** 시행 기간이 없다(Python은 None). 신청 기간 판단이 이 항목에서는 날짜를 보지 않는다. */
  enfcBgngYmd?: undefined;
  enfcEndYmd?: undefined;
  source: DatasetCitation;
  referenceDate: string;
};

export class ProgramShelf {
  readonly records: readonly Program[];
  /** YYYY-MM-DD. 자료가 없으면 없다. */
  readonly referenceDate: string | undefined;

  constructor(records: readonly Program[] = [], referenceDate?: string) {
    this.records = records;
    this.referenceDate = referenceDate === undefined || referenceDate === "" ? undefined : fromIsoDate(referenceDate);
  }

  /** 오늘 이전에 끝난 사업은 뺀다. 사업이 시작되기 전에도 신청은 열려 있을 수 있어 시작일은 보지 않는다. */
  entries(today: string): PrivateProgramEntry[] {
    const day = fromIsoDate(today);
    const entries: PrivateProgramEntry[] = [];
    for (const record of this.records) {
      if (record.end < day) continue;
      if (this.referenceDate === undefined) throw new Error("민간 사업 자료의 기준일이 없습니다.");
      const identifier = createHash("sha256").update(`${record.organization}\n${record.name}`, "utf8").digest("hex").slice(0, 20);
      entries.push({
        servId: `private-${identifier}`, servNm: record.name, organization: record.organization,
        provider: "private", dataOrigin: "official-snapshot",
        lifeStages: [...record.life_stages], targets: [...record.targets], themes: [...record.themes],
        summary: record.purpose.length > 0 ? record.purpose : record.benefit,
        target: record.target, benefit: record.benefit, applyMethod: record.apply, documents: record.documents,
        source: PROGRAMS.citation(this.referenceDate, record.organization),
        referenceDate: this.referenceDate,
      });
    }
    return entries;
  }
}
