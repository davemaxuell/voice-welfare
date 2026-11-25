import type { GroundedAnswerCard, SourceCitation } from '../../core/turn.ts';
import { omitAbsent } from '../../core/schema.ts';
import { speakDate } from '../../speech/phrasing.ts';
import type { WelfareService } from './data/index.ts';

export const welfareCardPatterns = {
  referenceDate: /^(\p{Nd}{4}(?:-\p{Nd}{2}-\p{Nd}{2}|년))\p{White_Space}*기준/u,
  isoDay: /^(\p{Nd}{4})-\p{Nd}{2}-\p{Nd}{2}(?=\n?$)/u,
};

const STORED = "저장된 자료 기준";

export function cite(source: SourceCitation): SourceCitation {
  return omitAbsent({title: source.title, url: source.url, lastCheckedAt: source.lastCheckedAt,
    version: source.version?.startsWith('fixture') === true ? STORED : source.version, note: source.note});
}

export function citeWithData(card: GroundedAnswerCard, sources: readonly SourceCitation[]): SourceCitation[] {
  const data = omitAbsent({kind: card.dataKind, origin: card.dataOrigin, date: card.dataDate});
  const listed = sources.some(source => source.url === card.source.url);
  return [...sources.map(source => source.url === card.source.url ? {...source, data} : source), ...listed ? [] : [{...card.source, data}]];
}

export function sourceSentence(source: SourceCitation): string {
  const version = cite(source).version;
  return `(출처: ${source.title.startsWith('복지로') ? '복지로' : source.title}, ${version === STORED ? '연습용 예시, 저장된 자료 기준' : version ?? ''})`;
}

export function spokenDate(value: string): string {
  const match = welfareCardPatterns.isoDay.exec(value);
  const year = match?.[0] === value ? match[1] : undefined;
  return year === undefined ? value : `${year}년 ${speakDate(value)}`;
}

export function answerCard(service: WelfareService, answer: string, fields: string[], { grounded = true, nextAction }: { grounded?: boolean; nextAction?: string } = {}): GroundedAnswerCard {
  const source = cite(service.source);
  const reference = service.referenceDate ?? "";
  const year = service.criteriaYear ?? "";
  const dataDate = reference.length > 0 ? reference : year.length > 0 ? `${year}년` : welfareCardPatterns.referenceDate.exec(source.version ?? "")?.[1];
  const contact = service.contacts?.find(c => /^\p{Nd}/u.test(c.value));
  const dataKind: GroundedAnswerCard['dataKind'] = service.provider === "private" ? "private-program" : service.dataOrigin === "official-api" ? "live" : "stored";
  return omitAbsent({
    answer, serviceId: service.servId, serviceName: service.servNm, fields: [...new Set(fields)], grounded, source,
    dataKind, dataOrigin: service.dataOrigin, dataDate,
    nextAction: nextAction ?? (grounded ? "출처에서 해당 제도의 자세한 내용을 확인해 주세요." : contact ? `${contact.name} ${contact.value}에 문의해 주세요.` : "보건복지상담센터 129에 문의해 주세요."),
  });
}

const translations = {
  en: ["Source", "Data date", "Checked", "Unspecified", "Live official API", "Stored source", "Private program in public data", "Practice example"],
  zh: ["来源", "数据日期", "核对日期", "未注明", "官方接口实时数据", "存档资料", "公共数据中的民间项目", "练习示例"],
  ja: ["出典", "資料の基準日", "確認日", "記載なし", "公式APIの最新照会", "保存資料", "公開データ掲載の民間事業", "練習用の例"],
} as const;

export function speakAnswerCard(card: GroundedAnswerCard, lang: "ko" | keyof typeof translations = "ko"): string {
  const checked = card.source.lastCheckedAt;
  let metadata: string;
  if (lang === "ko") {
    const stored = card.dataOrigin === "fixture" ? "연습용 예시, 저장된 자료 기준" : STORED;
    const label = { live: "공식 API 실시간 조회", stored, "private-program": "공공데이터에 실린 민간 사업" }[card.dataKind];
    metadata = `출처는 ${card.source.title}이며, ${label}입니다. 자료 기준은 ${card.dataDate === undefined ? "기준일 미기재" : spokenDate(card.dataDate)}. 확인일은 ${spokenDate(checked)}입니다.`;
  } else {
    const [source, day, check, missing, live, stored, priv, fixture] = translations[lang];
    const label = card.dataOrigin === "fixture" ? fixture : {live, stored, "private-program": priv}[card.dataKind];
    metadata = `${source} ${card.source.title}. ${label}. ${day} ${card.dataDate ?? missing}. ${check} ${checked}.`;
  }
  const stop = card.answer.length > 0 && !".!?。！？".includes(card.answer.slice(-1)) ? "." : "";
  return `${card.answer}${stop} ${metadata} ${card.nextAction}`;
}
