import { strip } from "../../core/text.ts";
import type { WelfareService } from './data/index.ts';

export const ragPatterns = {
  overview: /(뭐야|무엇|어떤\p{White_Space}*제도|소개|목적|개요)/u,
  target: /(대상|자격|누가|받을\p{White_Space}*수|해당|몇\p{White_Space}*살|나이|중증)/u,
  criteria: /(선정|기준|소득|재산|소득인정액|기준액|자동차|직역연금|공무원)/u,
  benefit: /(얼마|금액|지급|급여|연금액|감액|부가급여|기초급여|매월|65세)/u,
  procedure: /(신청|절차|어디|어떻게|방법|주민센터|온라인|심사|결정)/u,
  forms: /(서류|서식|양식|동의서|신고서|첨부)/u,
  documents: /(서류|준비물|구비|첨부)/u,
  contact: /(문의|전화|연락|상담|129)/u,
  law: /(법|법령|근거|조항)/u,
  formExt: /\.(hwpx?|pdf)(?=\n?$)/iu,
  nonWord: /[^가-힣a-zA-Z0-9]/gu,
};


/**
 * 공식 복지 데이터(API 상세조회)를 근거 조각으로 나누고, 질문과 가까운 조각을 고른다.
 * 외부 벡터DB 없이 한국어 글자 2-gram 겹침 + 항목 키워드 가중치로 검색한다(재현 가능·설명 가능).
 */
export type ChunkSection = '개요' | '지원대상' | '선정기준' | '지원내용' | '제출서류' | '신청절차' | '서식' | '문의처' | '근거법령';

/** 조각이 나온 서비스 항목의 이름(답 카드가 어느 항목에서 읽었는지 밝힌다). */
export type ChunkField = 'summary' | 'target' | 'criteria' | 'benefit' | 'documents' | 'applySteps' | 'applyMethod' | 'forms' | 'contacts' | 'laws';

export interface Chunk {
  id: string;
  section: ChunkSection;
  field: ChunkField;
  text: string;
}

/** 질문에 이 말이 있으면 해당 항목 조각을 우선한다. */
export const SECTION_HINTS: Record<ChunkSection, RegExp> = {
  개요: ragPatterns.overview,
  지원대상: ragPatterns.target,
  선정기준: ragPatterns.criteria,
  지원내용: ragPatterns.benefit,
  제출서류: ragPatterns.documents,
  신청절차: ragPatterns.procedure,
  서식: ragPatterns.forms,
  문의처: ragPatterns.contact,
  근거법령: ragPatterns.law,
};

const LINES_PER_CHUNK = 3;

function splitLines(text: string | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map(strip)
    .filter((l) => Array.from(l).length > 1);
}

export function chunkService(s: WelfareService): Chunk[] {
  const chunks: Chunk[] = [];
  const fields: Record<ChunkSection, ChunkField> = {
    개요: 'summary', 지원대상: 'target', 선정기준: 'criteria', 지원내용: 'benefit', 제출서류: 'documents',
    신청절차: s.applySteps !== undefined && s.applySteps.length > 0 ? 'applySteps' : 'applyMethod',
    서식: 'forms', 문의처: 'contacts', 근거법령: 'laws',
  };
  const push = (section: ChunkSection, text: string) => {
    if (strip(text).length > 0) chunks.push({ id: `${s.servId}#${chunks.length + 1}`, section, field: fields[section], text: strip(text) });
  };
  const grouped = (section: ChunkSection, text: string | undefined) => {
    const lines = splitLines(text);
    for (let i = 0; i < lines.length; i += LINES_PER_CHUNK) push(section, lines.slice(i, i + LINES_PER_CHUNK).join('\n'));
  };
  push('개요', `${s.servNm}: ${s.summary}`);
  grouped('지원대상', s.target);
  grouped('선정기준', s.criteria);
  grouped('지원내용', s.benefit);
  grouped('제출서류', s.documents);
  if (s.applySteps !== undefined && s.applySteps.length > 0) push('신청절차', s.applySteps.map((a) => `${a.step}: ${a.detail}`).join('\n'));
  else push('신청절차', s.applyMethod);
  if (s.forms !== undefined && s.forms.length > 0) push('서식', `관련 서식: ${s.forms.map((f) => f.name.replace(ragPatterns.formExt, '')).join(', ')}`);
  if (s.contacts !== undefined && s.contacts.length > 0) push('문의처', `문의처: ${s.contacts.map((c) => `${c.name} ${c.value}`).join(', ')}`);
  if (s.laws !== undefined && s.laws.length > 0) push('근거법령', `근거 법령: ${s.laws.join(', ')}`);
  return chunks;
}

const bigrams = (text: string): Set<string> => {
  const t = text.replace(ragPatterns.nonWord, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

export interface Scored extends Chunk {
  score: number;
}

/** 질문과 조각의 2-gram 겹침(질문 기준 재현율) + 항목 힌트 가중치. */
export function retrieve(question: string, chunks: Chunk[], k = 3): Scored[] {
  const q = bigrams(question);
  return chunks
    .map((c) => {
      const cb = bigrams(c.text);
      let overlap = 0;
      for (const g of q) if (cb.has(g)) overlap++;
      const lexical = q.size > 0 ? overlap / q.size : 0;
      const hint = SECTION_HINTS[c.section].test(question) ? 0.5 : 0;
      return { ...c, score: lexical + hint };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
