import type { StoredResearch } from "../core/research.ts";
import { RESEARCH_UNDELIVERED, resultWord, stateNote } from "../core/research_copy.ts";
import { LangSchema, type Lang, type SpeechPrefs } from "../core/turn.ts";
import { detectSensitive } from "../safety/privacy.ts";
import { speakDate } from "./phrasing.ts";

export interface ReadingJob {
  prompt: string;
  language: string;
  state: string;
  result: StoredResearch | undefined;
  question: string | undefined;
}
export interface ReadingOptions {
  brevity: SpeechPrefs["length"];
  speakable?: ((text: string) => boolean) | undefined;
}

const MAX_SOURCES = 3;
const MAX_MISSING = 5;
const MAX_PROMPT = 100;
const SHORT_SENTENCES = 2;

type Headline = "result" | "question" | "update";
const HEADLINE: Record<Headline, Record<Lang, (prompt: string) => string>> = {
  result: {
    ko: prompt => `‘${prompt}’ 조사 결과예요.`,
    en: prompt => `Results for “${prompt}”.`,
    zh: prompt => `“${prompt}”的调查结果。`,
    ja: prompt => `「${prompt}」の調査結果です。`,
  },
  question: {
    ko: prompt => `‘${prompt}’ 조사에서 여쭤볼 것이 있어요.`,
    en: prompt => `A question about “${prompt}”.`,
    zh: prompt => `关于“${prompt}”的调查有一个问题。`,
    ja: prompt => `「${prompt}」の調査で確認したいことがあります。`,
  },
  update: {
    ko: prompt => `‘${prompt}’ 조사 소식이에요.`,
    en: prompt => `An update on “${prompt}”.`,
    zh: prompt => `关于“${prompt}”的调查进展。`,
    ja: prompt => `「${prompt}」の調査についてのお知らせです。`,
  },
};
const HEADLINE_OF_STATE: ReadonlyMap<string, Headline> = new Map([
  ["completed", "result"], ["partial", "result"], ["incomplete", "result"], ["needs_input", "question"],
]);
const MORE_SOURCES: Record<Lang, (count: number) => string> = {
  ko: count => `출처가 ${count}곳 더 있어요.`,
  en: count => count === 1 ? "There is 1 more source." : `There are ${count} more sources.`,
  zh: count => `还有${count}个来源。`,
  ja: count => `ほかに出典が${count}件あります。`,
};
const MORE_MISSING: Record<Lang, (count: number) => string> = {
  ko: count => `확인이 남은 항목이 ${count}개 더 있어요.`,
  en: count => count === 1 ? "1 more item is still to verify." : `${count} more items are still to verify.`,
  zh: count => `还有${count}项待核实。`,
  ja: count => `確認が残っている項目がほかに${count}件あります。`,
};
const STOP: Record<Lang, string> = { ko: ".", en: ".", zh: "。", ja: "。" };

const MARKS = ".。!！?？…";
const CLOSERS = "”’」』)）\"'";
const ISO_DAY = /^(\d{4})-\d{2}-\d{2}$/u;
const YEAR_ONLY = /^(\d{4})년$/u;

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();
const present = (text: string) => text.length > 0;

function realDay(value: string): boolean {
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(value);
}

function dateWords(value: string | undefined, lang: Lang): string {
  const unknown = resultWord("unknownDate", lang);
  if (value === undefined) return unknown;
  const year = YEAR_ONLY.exec(value)?.[1];
  if (year !== undefined) return lang === "ko" ? value : lang === "en" ? year : `${year}年`;
  const day = ISO_DAY.exec(value);
  if (day === null || !realDay(value)) return unknown;
  return lang === "ko" ? `${day[1]}년 ${speakDate(value)}` : value;
}

function endWithOneMark(part: string, lang: Lang): string {
  const chars = Array.from(part.trim());
  let tail = chars.length;
  while (tail > 0 && CLOSERS.includes(chars[tail - 1] ?? "")) tail--;
  let head = tail;
  while (head > 0 && MARKS.includes(chars[head - 1] ?? "")) head--;
  if (head === 0) return "";
  const marks = chars.slice(head, tail);
  if (marks.length === 0) return chars.join("") + STOP[lang];
  const kept = marks.find(mark => "?？".includes(mark)) ?? marks.find(mark => "!！".includes(mark)) ?? marks[0] ?? "";
  return [...chars.slice(0, head), kept, ...chars.slice(tail)].join("");
}

const joinSpoken = (parts: readonly string[], lang: Lang) =>
  parts.map(part => endWithOneMark(part, lang)).filter(present).join(lang === "zh" || lang === "ja" ? "" : " ");

function firstSentences(text: string, lang: Lang): string {
  const sentences = [...new Intl.Segmenter(lang, { granularity: "sentence" }).segment(text)]
    .map(({ segment }) => segment.trim()).filter(present);
  return sentences.length <= SHORT_SENTENCES ? text : sentences.slice(0, SHORT_SENTENCES).join(lang === "zh" || lang === "ja" ? "" : " ");
}

// 묻는 조사의 질문은 저장된 글의 끝에 있다(researchSummary). 짧게 읽어도 질문은 빼지 않는다.
function shortText(text: string, question: string | undefined, lang: Lang): string[] {
  const asked = question?.trim() ?? "";
  if (asked.length === 0 || !text.endsWith(asked)) return [firstSentences(text, lang)];
  return [firstSentences(text.slice(0, -asked.length).trim(), lang), asked];
}

export function researchReading(job: ReadingJob, { brevity, speakable }: ReadingOptions): string {
  const lang = LangSchema.safeParse(job.language).data ?? "ko";
  const { result } = job;
  const text = (result?.text ?? "").trim();
  const missing = (result?.missing ?? []).map(squash).filter(present);
  const textHasSources = result?.data !== undefined;
  const cited = result === undefined || textHasSources ? [] : result.sources;
  const subject = Array.from(squash(job.prompt));
  const headline = HEADLINE[HEADLINE_OF_STATE.get(job.state) ?? "update"][lang];
  const parts = [headline(subject.length > MAX_PROMPT ? `${subject.slice(0, MAX_PROMPT).join("")}…` : subject.join(""))];
  if (text.length > 0) parts.push(...(brevity === "short" ? shortText(text, job.question, lang) : [text]));
  else if (missing.length === 0) parts.push(stateNote(job.state, lang));
  for (const { title, lastCheckedAt, data } of cited.slice(0, MAX_SOURCES)) {
    parts.push([resultWord("source", lang), squash(title)].filter(present).join(" "));
    if (data !== undefined) parts.push(resultWord(data.kind, lang));
    parts.push(`${resultWord("dataDate", lang)} ${dateWords(data?.date, lang)}`);
    parts.push(`${resultWord("checked", lang)} ${dateWords(lastCheckedAt, lang)}`);
  }
  if (cited.length > MAX_SOURCES) parts.push(MORE_SOURCES[lang](cited.length - MAX_SOURCES));
  if (missing.length > 0) parts.push(resultWord("missing", lang), ...missing.slice(0, MAX_MISSING));
  if (missing.length > MAX_MISSING) parts.push(MORE_MISSING[lang](missing.length - MAX_MISSING));
  const speech = joinSpoken(parts, lang);
  return speakable?.(speech) !== false && !detectSensitive(speech).hasSecretValue ? speech : RESEARCH_UNDELIVERED[lang];
}
