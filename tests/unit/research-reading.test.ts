import { describe, expect, it } from "vitest";
import { StoredResearch } from "../../src/core/research.ts";
import { RESEARCH_UNDELIVERED, stateNote } from "../../src/core/research_copy.ts";
import type { Lang } from "../../src/core/turn.ts";
import { researchReading, type ReadingJob } from "../../src/speech/research_reading.ts";

const LANGS: readonly Lang[] = ["ko", "en", "zh", "ja"];
const STATES = ["completed", "partial", "incomplete", "needs_input", "cancelled", "failed"] as const;
const url = "https://www.bokjiro.go.kr/";
const dated = { title: "복지로 공식 안내", url, lastCheckedAt: "2026-11-24", data: { kind: "live", origin: "official-api", date: "2026년" } };
const bare = { title: "복지로 공식 안내", url, lastCheckedAt: "2026-11-24" };
const answer = "신분증과 신청서를 준비하세요.";
const job = (result: unknown, over: Partial<ReadingJob> = {}): ReadingJob =>
  ({ prompt: "기초연금 신청 서류", language: "ko", state: "completed", result: result === undefined ? undefined : StoredResearch.parse(result), question: undefined, ...over });
const HEADLINE_START: Record<(typeof STATES)[number], Record<Lang, string>> = {
  completed: { ko: "‘기초연금 신청 서류’ 조사 결과예요.", en: "Results for “기초연금 신청 서류”.", zh: "“기초연금 신청 서류”的调查结果。", ja: "「기초연금 신청 서류」の調査結果です。" },
  partial: { ko: "‘기초연금 신청 서류’ 조사 결과예요.", en: "Results for “기초연금 신청 서류”.", zh: "“기초연금 신청 서류”的调查结果。", ja: "「기초연금 신청 서류」の調査結果です。" },
  incomplete: { ko: "‘기초연금 신청 서류’ 조사 결과예요.", en: "Results for “기초연금 신청 서류”.", zh: "“기초연금 신청 서류”的调查结果。", ja: "「기초연금 신청 서류」の調査結果です。" },
  needs_input: { ko: "‘기초연금 신청 서류’ 조사에서 여쭤볼 것이 있어요.", en: "A question about “기초연금 신청 서류”.", zh: "关于“기초연금 신청 서류”的调查有一个问题。", ja: "「기초연금 신청 서류」の調査で確認したいことがあります。" },
  cancelled: { ko: "‘기초연금 신청 서류’ 조사 소식이에요.", en: "An update on “기초연금 신청 서류”.", zh: "关于“기초연금 신청 서류”的调查进展。", ja: "「기초연금 신청 서류」の調査についてのお知らせです。" },
  failed: { ko: "‘기초연금 신청 서류’ 조사 소식이에요.", en: "An update on “기초연금 신청 서류”.", zh: "关于“기초연금 신청 서류”的调查进展。", ja: "「기초연금 신청 서류」の調査についてのお知らせです。" },
};
const read = (target: ReadingJob, brevity: "short" | "normal" | "detailed" = "normal") => researchReading(target, { brevity });

describe("저장한 조사를 읽는 글", () => {
  it("한국어는 주제, 답, 출처의 자료 종류와 기준일과 확인일, 남은 항목 순서로 한 번씩 말한다", () => {
    expect(read(job({ text: answer, sources: [dated] }))).toBe(
      "‘기초연금 신청 서류’ 조사 결과예요. 신분증과 신청서를 준비하세요. 출처 복지로 공식 안내. 기관 자료. 자료 기준일 2026년. 출처 확인일 2026년 11월 24일.");
    expect(read(job({ text: answer, sources: [{ ...dated, data: { kind: "stored", origin: "fixture", date: "2026-03-05" } }], missing: ["마감일", "지원 금액"] }, { state: "partial" }))).toBe(
      "‘기초연금 신청 서류’ 조사 결과예요. 신분증과 신청서를 준비하세요. 출처 복지로 공식 안내. 저장 자료. 자료 기준일 2026년 3월 5일. 출처 확인일 2026년 11월 24일. 확인이 남은 항목. 마감일. 지원 금액.");
  });

  it("자료 정보가 없는 출처는 기준일 기록이 없다고 말하고 종류는 붙이지 않는다", () => {
    expect(read(job({ text: answer, sources: [bare] }))).toBe(
      "‘기초연금 신청 서류’ 조사 결과예요. 신분증과 신청서를 준비하세요. 출처 복지로 공식 안내. 자료 기준일 날짜 기록 없음. 출처 확인일 2026년 11월 24일.");
  });

  it("인용마다 자료 정보를 두기 전의 기록은 글 안의 출처 문장을 한 번만 말하고 출처를 더하지 않는다", () => {
    const prose = "신청서가 필요해요. 출처는 복지로 공식 안내이며, 공식 API 실시간 조회입니다. 자료 기준은 2026년. 확인일은 2026년 11월 24일입니다. 출처에서 확인해 주세요.";
    const speech = read(job({ text: prose, sources: [bare], data: { kind: "live", origin: "official-api", date: "2026년" }, missing: ["마감일"] }));
    expect(speech).toBe(`‘기초연금 신청 서류’ 조사 결과예요. ${prose} 확인이 남은 항목. 마감일.`);
    expect(speech.split("출처는 복지로 공식 안내").length - 1).toBe(1);
    expect(speech).not.toContain("출처 확인일");
  });

  it("답이 없고 남은 항목도 없으면 상태 안내를, 남은 항목만 있으면 그 항목만 말한다", () => {
    expect(read(job(undefined, { state: "cancelled" }))).toBe(`‘기초연금 신청 서류’ 조사 소식이에요. ${stateNote("cancelled", "ko")}`);
    expect(read(job({ text: "", missing: ["지원 금액"] }, { state: "incomplete" }))).toBe(
      "‘기초연금 신청 서류’ 조사 결과예요. 확인이 남은 항목. 지원 금액.");
  });

  it("끝맺음 표가 겹치거나 없어도 문장마다 하나만 남기고 물음표는 지킨다", () => {
    expect(read(job({ text: "서류가 필요해요..", missing: ["마감일.。"] }))).toBe("‘기초연금 신청 서류’ 조사 결과예요. 서류가 필요해요. 확인이 남은 항목. 마감일.");
    expect(read(job({ text: "必要です。.", sources: [] }, { language: "ja" }))).toBe("「기초연금 신청 서류」の調査結果です。必要です。");
    expect(read(job({ text: "어느 지역에 사시나요?" }, { state: "needs_input" }))).toContain("어느 지역에 사시나요?");
    expect(read(job({ text: "어느 지역에 사시나요?" }, { state: "needs_input" }))).not.toContain("?.");
    expect(read(job({ text: "자세한 것은 (복지로)" }))).toContain("(복지로).");
    expect(read(job({ text: "자세한 것은 (복지로)." }))).not.toContain(").)");
  });

  it("'짧게'는 답 글만 앞 두 문장으로 줄이고 출처와 날짜와 남은 항목은 줄이지 않는다", () => {
    const long = "첫째 문장이에요. 둘째 문장이에요. 셋째 문장이에요. 넷째 문장이에요.";
    const result = { text: long, sources: [dated], missing: ["마감일"] };
    const short = read(job(result, { state: "partial" }), "short");
    expect(short).toContain("첫째 문장이에요. 둘째 문장이에요. 출처 복지로 공식 안내.");
    expect(short).not.toContain("셋째");
    expect(short).toContain("자료 기준일 2026년. 출처 확인일 2026년 11월 24일. 확인이 남은 항목. 마감일.");
    expect(read(job(result, { state: "partial" }), "normal")).toContain("넷째 문장이에요.");
    expect(read(job(result, { state: "partial" }), "detailed")).toContain("넷째 문장이에요.");
    expect(read(job({ text: "한 문장이에요.", sources: [dated] }), "short")).toContain("한 문장이에요.");
  });

  it("'짧게'로 묻는 조사를 읽어도 끝의 질문은 줄이지 않는다", () => {
    const question = "어느 구에 사시나요?";
    const asking = job({ text: `신분증이 필요해요. 신청서도 내야 해요. 주민센터에서 받아요.

${question}` }, { state: "needs_input", question });
    expect(read(asking, "short")).toBe(`‘기초연금 신청 서류’ 조사에서 여쭤볼 것이 있어요. 신분증이 필요해요. 신청서도 내야 해요. ${question}`);
    expect(read({ ...asking, result: StoredResearch.parse({ text: question }) }, "short")).toBe(`‘기초연금 신청 서류’ 조사에서 여쭤볼 것이 있어요. ${question}`);
    expect(read(asking, "normal")).toContain("주민센터에서 받아요.");
    expect(read(asking, "normal").endsWith(question)).toBe(true);
  });

  it("저장할 때 길어서 잘린 글에는 빠진 질문을 붙여, 짧게 읽어도 자세히 읽어도 질문을 읽는다", () => {
    const question = "어느 구에 사시나요?";
    const findings = "신분증이 필요해요. 신청서도 내야 해요. 주민센터에서 받아요.";
    const cut = job({ text: findings }, { state: "needs_input", question });
    expect(read(cut, "short")).toContain(`여쭤볼 것이 있어요. 신분증이 필요해요. 신청서도 내야 해요. ${question}`);
    expect(read(cut, "normal")).toContain(`여쭤볼 것이 있어요. ${findings} ${question}`);
  });

  it("출처는 세 곳까지, 남은 항목은 다섯 개까지 말하고 나머지는 개수로 알린다", () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ ...bare, title: `출처 ${i + 1}번`, url: `https://www.gov.kr/${i}` }));
    const missing = Array.from({ length: 7 }, (_, i) => `항목 ${i + 1}`);
    const speech = read(job({ text: answer, sources, missing }, { state: "partial" }));
    expect(speech).toContain("출처 출처 3번.");
    expect(speech).not.toContain("출처 4번");
    expect(speech).toContain("출처가 2곳 더 있어요.");
    expect(speech).toContain("항목 5.");
    expect(speech).not.toContain("항목 6");
    expect(speech).toContain("확인이 남은 항목이 2개 더 있어요.");
  });

  it.each([
    ["확인일이 날짜 모양이 아니다", "어제"],
    ["달력에 없는 날이다", "2026-02-30"],
    ["줄바꿈이 붙었다", "2026-11-24\n"],
    ["비어 있다", ""],
    ["전각 숫자다", "２０２６-11-24"],
  ])("확인일이 %s: 기록 없음으로 말한다", (_name, lastCheckedAt) => {
    expect(read(job({ text: answer, sources: [{ ...bare, lastCheckedAt }] }))).toContain("출처 확인일 날짜 기록 없음.");
  });

  it("기준일 모양이 틀린 자료 정보는 날짜만 비우고 종류는 말한다", () => {
    const speech = read(job({ text: answer, sources: [{ ...dated, data: { kind: "stored", origin: "fixture", date: "2026-3-5" } }] }));
    expect(speech).toContain("저장 자료. 자료 기준일 날짜 기록 없음.");
  });

  it("긴 주제는 백 글자에서 줄이고 줄바꿈은 공백 하나로 모은다", () => {
    expect(read(job({ text: answer }, { prompt: "가".repeat(150) }))).toContain(`‘${"가".repeat(100)}…’ 조사 결과예요.`);
    expect(read(job({ text: answer }, { prompt: "기초연금\n  신청\t서류" }))).toContain("‘기초연금 신청 서류’ 조사 결과예요.");
  });

  it("깨진 출처 항목이 하나 있어도 답 글과 나머지 출처는 말한다", () => {
    const speech = read(job({ text: answer, sources: [{ title: 7 }, null, dated], missing: [3, "마감일"] }, { state: "partial" }));
    expect(speech).toContain(answer);
    expect(speech).toContain("출처 복지로 공식 안내.");
    expect(speech).toContain("확인이 남은 항목. 마감일.");
  });

  it("비밀 값이 들어 있거나 이 세션의 개인 값이 보이면 전달하지 못했다는 안내로 바꾼다", () => {
    expect(read(job({ text: "비밀번호는 1234예요." }))).toBe(RESEARCH_UNDELIVERED.ko);
    expect(read(job({ text: answer, missing: ["카드 1234-5678-9012-3456"] }))).toBe(RESEARCH_UNDELIVERED.ko);
    expect(read(job({ text: "password is 1234" }, { language: "en" }))).toBe(RESEARCH_UNDELIVERED.en);
    expect(researchReading(job({ text: answer }), { brevity: "normal", speakable: text => !text.includes("신분증") })).toBe(RESEARCH_UNDELIVERED.ko);
    expect(researchReading(job({ text: answer }), { brevity: "normal", speakable: () => true })).toContain(answer);
  });

  it("공식 문서 이름으로 키워드만 나오는 글은 막지 않는다", () => {
    expect(read(job({ text: "신청서에 주민등록번호를 적고 계좌 사본을 내세요." }))).toContain("계좌 사본");
  });

  it("중단·실패·진행 중인 조사는 결과가 아니라 소식으로, 물음이 걸린 조사는 물음으로 시작한다", () => {
    expect(read(job({ text: "어느 지역에 사시나요?" }, { state: "needs_input" }))).toBe("‘기초연금 신청 서류’ 조사에서 여쭤볼 것이 있어요. 어느 지역에 사시나요?");
    expect(read(job(undefined, { state: "failed" }))).toBe(`‘기초연금 신청 서류’ 조사 소식이에요. ${stateNote("failed", "ko")}`);
    for (const state of ["queued", "running", "unknown"]) expect(read(job(undefined, { state })).startsWith("‘기초연금 신청 서류’ 조사 소식이에요."), state).toBe(true);
    for (const state of ["completed", "partial", "incomplete"]) expect(read(job({ text: answer }, { state })).startsWith("‘기초연금 신청 서류’ 조사 결과예요."), state).toBe(true);
  });

  it("알 수 없는 언어는 한국어로 읽는다", () => {
    expect(read(job({ text: answer }, { language: "xx" }))).toContain("조사 결과예요.");
  });

  describe.each(LANGS)("%s", lang => {
    const prompt = "기초연금 신청 서류";
    const variants = {
      "인용마다 자료 정보": { text: "Bring your ID.", sources: [dated], missing: ["마감일"] },
      "자료 정보 없음": { text: "Bring your ID.", sources: [bare], missing: ["마감일"] },
      "옛 기록": { text: "Bring your ID. 출처는 복지로예요.", sources: [bare], data: { kind: "live", origin: "official-api", date: "2026년" }, missing: ["마감일"] },
    } as const;
    const doubled = /[.。][.。]|[.。] [.。]/u;
    it.each(STATES)("%s 상태는 어느 자료 모양이든 주제로 시작하고 끝맺음 표 하나로 끝난다", state => {
      for (const [name, result] of Object.entries(variants)) {
        for (const brevity of ["normal", "short"] as const) {
          const speech = read({ prompt, language: lang, state, result: StoredResearch.parse(result), question: undefined }, brevity);
          expect(speech, `${name} ${brevity}`).toContain(prompt);
          expect(speech.startsWith(HEADLINE_START[state][lang]), `${name} ${brevity}`).toBe(true);
          expect(speech, `${name} ${brevity}`).not.toMatch(doubled);
          expect(speech.at(-1), `${name} ${brevity}`).toBe(lang === "zh" || lang === "ja" ? "。" : ".");
          expect(speech, `${name} ${brevity}`).toContain("마감일");
        }
      }
    });
    it("자료 정보가 있으면 자료 종류, 기준 연도, 확인일을 그 언어로 말하고 옛 기록은 출처를 더하지 않는다", () => {
      const speech = read({ prompt, language: lang, state: "completed", result: StoredResearch.parse(variants["인용마다 자료 정보"]), question: undefined });
      const year = lang === "ko" ? "2026년" : lang === "en" ? "2026" : "2026年";
      const checked = lang === "ko" ? "2026년 11월 24일" : "2026-11-24";
      expect(speech).toContain("복지로 공식 안내");
      expect(speech).toContain(year);
      expect(speech).toContain(checked);
      expect(speech).toContain(lang === "ko" ? "기관 자료" : lang === "en" ? "Agency data" : lang === "zh" ? "机构数据" : "機関のデータ");
      expect(speech).not.toContain("2026年年");
      const legacy = read({ prompt, language: lang, state: "completed", result: StoredResearch.parse(variants["옛 기록"]), question: undefined });
      expect(legacy).not.toContain("복지로 공식 안내");
      expect(legacy).toContain("Bring your ID.");
      const none = read({ prompt, language: lang, state: "completed", result: StoredResearch.parse(variants["자료 정보 없음"]), question: undefined });
      expect(none).toContain(lang === "ko" ? "날짜 기록 없음" : lang === "en" ? "Date unavailable" : lang === "zh" ? "日期未知" : "日付不明");
    });
    it("답도 남은 항목도 없으면 그 언어의 상태 안내를 말한다", () => {
      expect(read({ prompt, language: lang, state: "cancelled", result: undefined, question: undefined })).toContain(stateNote("cancelled", lang));
    });
  });
});
