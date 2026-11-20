import { fixed } from "./eval-text.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createMockWelfareProfile, fieldVocabulary } from "../src/agents/web/profile.ts";
import { REPO_ROOT } from "../src/core/assets.ts";
import { strip, textOr } from "../src/core/text.ts";
import { cer, digitRuns, hasSpelledNumbers } from "../src/evaluation/asr.ts";
import { detectLangSwitch } from "../src/language/i18n.ts";
import { detectSensitive, redactText } from "../src/safety/privacy.ts";
import { RuleBasedIntentProvider, isStopUtterance } from "../src/understanding/rules.ts";
import { loadConfig } from "../src/server/runtime.ts";
import { createVoiceProviders } from "../src/voice/config.ts";
import type { SttProvider } from "../src/voice/stt.ts";

const AUDIO_EXT: Record<string, string> = {
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};
const RowSchema = z.object({
  id: z.string(),
  lang: z.string(),
  kind: z.string(),
  text: z.string(),
  read_as: z.string(),
  expect: z.string(),
});
type Row = z.infer<typeof RowSchema> & { audio?: string };
interface Result {
  provider: string;
  row: Row;
  text: string;
  ms: number;
  error: string | null;
  checks: ReturnType<typeof check>;
}

function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(strip(field));
      field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(strip(field));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw Error("문장 목록의 CSV 따옴표가 닫히지 않았습니다.");
  if (field.length > 0 || row.length > 0) {
    row.push(strip(field));
    rows.push(row);
  }
  return rows;
}
export function loadRows(recordings: string, file = join(REPO_ROOT, "docs/stt-eval/sentences.csv")): Row[] {
  const [header, ...records] = readCsv(readFileSync(file, "utf8"));
  if (header === undefined) return [];
  return records
    .filter((fields) => fields.length > 1 || fields[0] !== "")
    .map((fields) => {
      const row = RowSchema.parse(Object.fromEntries(header.map((key, i) => [key, fields[i] ?? ""])));
      const audio = Object.keys(AUDIO_EXT)
        .map((ext) => join(recordings, row.id + ext))
        .find((path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true);
      return { ...row, audio };
    });
}
const rules = new RuleBasedIntentProvider(fieldVocabulary(createMockWelfareProfile("http://localhost:5174")));
function understood(text: string) {
  const intent = rules.parseSync(text, { state: "IDLE" });
  const fills =
    intent.type === "FILL"
      ? intent.fills.map((f) => [f.fieldMention, f.value.replace(/[\p{White_Space}.\-]/gu, "")])
      : [];
  return { type: intent.type, fills };
}
export function check(row: Pick<Row, "text" | "lang" | "kind" | "expect">, text: string) {
  const want =
    row.lang === "ko" && ["command", "stop", "value", "number"].includes(row.kind) ? understood(row.text) : undefined;
  const digits = digitRuns(row.text);
  return {
    cer: row.kind === "silence" ? null : cer(row.text, text),
    intent: want !== undefined && want.type !== "UNKNOWN" ? isDeepStrictEqual(understood(text), want) : null,
    digits:
      digits.length > 0 && ["number", "secret", "value"].includes(row.kind)
        ? isDeepStrictEqual(digitRuns(text), digits)
        : null,
    spelled: row.kind === "number" ? hasSpelledNumbers(text) : null,
    stop: row.kind === "stop" && row.lang === "ko" ? isStopUtterance(text) : null,
    switch: row.kind === "switch" ? detectLangSwitch(text) === row.expect : null,
    silence: row.kind === "silence" ? text === "" : null,
    ...(row.expect === "secret" || row.expect === "not-secret"
      ? { secret: detectSensitive(text).hasSecretValue === (row.expect === "secret") }
      : {}),
  };
}
function mean(values: readonly (number | boolean | null | undefined)[]) {
  const measured = values.filter((v) => v != null);
  if (measured.length === 0) return null;
  // Python 3.12+ sums floats with Neumaier compensation before dividing.
  let sum = 0;
  let correction = 0;
  for (const value of measured) {
    const x = Number(value);
    const next = sum + x;
    correction += Math.abs(sum) >= Math.abs(x) ? sum - next + x : x - next + sum;
    sum = next;
  }
  return (sum + correction) / measured.length;
}
export function summarizeStt(results: readonly Result[]) {
  const ok = results.filter((r) => r.error === null),
    times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const percent = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? null;
  const languageCer = (lang: string) =>
    mean(
      ok
        .filter((r) => r.row.lang === lang && r.row.kind !== "silence" && (lang !== "ko" || r.row.kind !== "switch"))
        .map((r) => r.checks.cer),
    );
  return {
    clips: results.length,
    errors: results.length - ok.length,
    koreanCer: languageCer("ko"),
    intentMatch: mean(ok.map((r) => r.checks.intent)),
    digitMatch: mean(ok.map((r) => r.checks.digits)),
    numbersAsDigits: mean(ok.map((r) => (r.checks.spelled === null ? null : !r.checks.spelled))),
    stopRecognized: mean(ok.map((r) => r.checks.stop)),
    switchRecognized: mean(ok.map((r) => r.checks.switch)),
    silenceEmpty: mean(ok.map((r) => r.checks.silence)),
    silenceFalseText: ok.filter((r) => r.checks.silence === false).length,
    secretCorrect: mean(ok.map((r) => r.checks.secret)),
    p50Ms: percent(0.5),
    p95Ms: percent(0.95),
    maxMs: times.at(-1) ?? null,
    enCer: languageCer("en"),
    zhCer: languageCer("zh"),
    jaCer: languageCer("ja"),
  };
}
type Scores = ReturnType<typeof summarizeStt>;
function pct(n: number | null) {
  return n === null ? "—" : fixed(n * 100, 1) + "%";
}
function ms(n: number | null) {
  return n === null ? "—" : n.toLocaleString("en-US") + " ms";
}
const metrics: [string, (s: Scores) => string][] = [
  ["녹음 수(오류)", (s) => `${s.clips} (${s.errors})`],
  ["한국어 글자 오류율 CER(낮을수록 좋음)", (s) => pct(s.koreanCer)],
  ["명령 이해 일치(규칙이 정답과 같은 명령으로 이해)", (s) => pct(s.intentMatch)],
  ["숫자 덩어리 일치(전화·생년월일 등)", (s) => pct(s.digitMatch)],
  ["숫자를 숫자로 적음(‘공일공’ 아님)", (s) => pct(s.numbersAsDigits)],
  ["‘멈춰’ 인식", (s) => pct(s.stopRecognized)],
  ["언어 바꾸기 인식", (s) => pct(s.switchRecognized)],
  ["무음 → 빈 글", (s) => pct(s.silenceEmpty)],
  ["비밀번호 문장 판정 맞음", (s) => pct(s.secretCorrect)],
  ["영어 CER", (s) => pct(s.enCer)],
  ["중국어 CER", (s) => pct(s.zhCer)],
  ["일본어 CER", (s) => pct(s.jaCer)],
  ["지연 p50 / p95 / 최대", (s) => [s.p50Ms, s.p95Ms, s.maxMs].map(ms).join(" / ")],
];
export function sttReport(rows: Row[], results: Result[], recordings: string) {
  const names = [...new Set(results.map((x) => x.provider))];
  const summary = Object.fromEntries(
    names.map((name) => [name, summarizeStt(results.filter((r) => r.provider === name))]),
  );
  const missing = rows.filter((r) => r.audio === undefined).map((r) => r.id);
  const lines = [
    "# 받아쓰기 평가",
    "",
    "- 생성: " + new Date().toISOString(),
    `- 녹음 폴더: \`${recordings}\` · 문장 ${rows.length}개 중 녹음 ${rows.length - missing.length}개` +
      (missing.length > 0
        ? " (없음: " + missing.slice(0, 20).join(", ") + (missing.length > 20 ? " …" : "") + ")"
        : ""),
    "- 받아쓴 글은 비식별화(`redact_text`)해서 적는다.",
    "",
    "## 요약",
    "",
    "| 지표 | " + names.join(" | ") + " |",
    "| --- | " + names.map(() => "---").join(" | ") + " |",
    ...metrics.map(([label, get]) => "| " + label + " | " + names.map((n) => get(summary[n]!)).join(" | ") + " |"),
    "",
    "## 녹음별",
    "",
    "| id | 종류 | 정답 | " + names.join(" | ") + " |",
    "| --- | --- | --- | " + names.map(() => "---").join(" | ") + " |",
  ];
  for (const row of rows) {
    const byId = results.filter((r) => r.row.id === row.id);
    if (byId.length === 0) continue;
    const cells = names.map((n) => {
      const x = byId.find((r) => r.provider === n);
      if (x === undefined) return "—";
      const mark =
        x.checks.silence !== null
          ? x.checks.silence
            ? " ✅"
            : " ❌"
          : x.checks.cer === null
            ? ""
            : " (" + fixed(x.checks.cer * 100, 0) + "%)";
      return (x.error !== null ? "⚠" + x.error : textOr(redactText(x.text).replaceAll("|", "/"), "(빈 글)")) + mark;
    });
    lines.push(
      `| ${row.id} | ${row.kind} | ${textOr(redactText(row.text).replaceAll("|", "/"), "(무음)")} | ${cells.join(" | ")} |`,
    );
  }
  return { markdown: lines.join("\n") + "\n", summary };
}

function providers(env: NodeJS.ProcessEnv) {
  const out = new Map<string, SttProvider>();
  const [provider] = createVoiceProviders(loadConfig(env).voice);
  if (provider.supported) out.set("openai", provider);
  else console.error("⚠ openai: API 키 없음 — 건너뜀");
  return out;
}

export async function main() {
  if (process.argv.includes("--help")) {
    console.log("node scripts/eval-stt.ts (EVAL_STT_RECORDINGS)");
    return 0;
  }
  const dotenv = join(REPO_ROOT, ".env");
  if (existsSync(dotenv)) process.loadEnvFile(dotenv);
  const recordings = textOr(process.env.EVAL_STT_RECORDINGS, join(REPO_ROOT, "recordings"));
  const rows = loadRows(recordings);
  const have = rows.filter((row): row is Row & { audio: string } => row.audio !== undefined);
  if (have.length === 0) {
    console.error("녹음이 없습니다: " + recordings + "\\<id>.webm|m4a|wav … (문장 목록: docs/stt-eval/sentences.csv)");
    return 1;
  }
  const models = providers(process.env);
  if (models.size === 0) {
    console.error("평가할 받아쓰기 공급자가 없습니다(API 키 확인).");
    return 1;
  }
  const results: Result[] = [];
  for (const [name, model] of models) {
    for (const row of have) {
      const audio = await readFile(row.audio);
      const start = performance.now();
      let text = "",
        error: string | null = null;
      try {
        ({ text } = await model.transcribe(audio, { language: row.lang, mimeType: AUDIO_EXT[extname(row.audio)]! }));
      } catch (e) {
        error = e instanceof Error ? e.name : "Error";
      }
      const elapsed = Math.floor(performance.now() - start),
        checks = check(row, text);
      results.push({ provider: name, row, text, ms: elapsed, error, checks });
      console.log(
        name.padEnd(13),
        row.id,
        String(elapsed).padStart(6) + "ms",
        (checks.cer === null ? "" : "CER " + fixed(checks.cer * 100, 0) + "%").padEnd(9),
        error === null ? [...redactText(text)].slice(0, 60).join("") : "⚠ " + error,
      );
    }
  }
  const { markdown, summary } = sttReport(rows, results, recordings);
  const dir = join(REPO_ROOT, "reports");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "stt-eval.md"), markdown);
  await writeFile(
    join(dir, "stt-eval.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary,
        results: results.map((x) => ({
          provider: x.provider,
          id: x.row.id,
          kind: x.row.kind,
          lang: x.row.lang,
          ms: x.ms,
          error: x.error,
          text: redactText(x.text),
          checks: x.checks,
        })),
      },
      null,
      2,
    ),
  );
  console.log("\n보고서: reports/stt-eval.md");
  return 0;
}
if (import.meta.main) process.exitCode = await main();
