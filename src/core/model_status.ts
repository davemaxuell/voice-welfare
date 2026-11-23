import { AsyncLocalStorage } from "node:async_hooks";
import type { Lang } from "./turn.ts";

export const MODEL_STATUS = new AsyncLocalStorage<{
  readonly language: Lang;
  begin: (schemaName: string, fallback?: string) => (status: string) => void;
}>();

export type ResponseFormat = { type: "json_schema"; json_schema: { name: string; strict: true; schema: object } } | { type: "json_object" };

const localized = (ko: string, en: string, zh: string, ja: string) => ({ ko, en, zh, ja });
export const modelActivities = {
  request: localized("요청하신 내용을 살펴보고 있어요.", "I’m reading the request.", "我正在查看您的请求。", "ご依頼の内容を確認しています。"),
  plan: localized("다음에 할 일을 정하고 있어요.", "I’m choosing the next step.", "我正在确定下一步。", "次の手順を考えています。"),
  page: localized("현재 화면의 내용을 살펴보고 있어요.", "I’m reading the current screen.", "我正在查看当前屏幕。", "現在の画面を確認しています。"),
  controls: localized("화면에서 사용할 수 있는 항목을 살펴보고 있어요.", "I’m checking the controls on the page.", "我正在查看页面上的控件。", "画面で操作できる項目を確認しています。"),
  file: localized("파일의 내용을 읽고 있어요.", "I’m reading the file.", "我正在阅读文件。", "ファイルの内容を読んでいます。"),
  passage: localized("질문과 관련된 부분을 찾고 있어요.", "I’m looking for the relevant passage.", "我正在查找相关段落。", "質問に関係する箇所を探しています。"),
  evidence: localized("안내 자료를 살펴보고 있어요.", "I’m reading the guidance.", "我正在阅读办事指南。", "案内資料を読んでいます。"),
  check: localized("답변과 근거를 대조하고 있어요.", "I’m comparing the answer with its sources.", "我正在对照资料核对答复。", "回答を資料と照らし合わせています。"),
  answer: localized("답변 내용을 정리하고 있어요.", "I’m putting the answer together.", "我正在整理答复。", "回答をまとめています。"),
  translate: localized("내용을 번역하고 있어요.", "I’m translating the wording.", "我正在翻译这段内容。", "内容を翻訳しています。"),
  wording: localized("표현이 뜻에 맞는지 확인하고 있어요.", "I’m checking the wording.", "我正在核对措辞。", "表現を確かめています。"),
};

type Activity = keyof typeof modelActivities;
const operations: { schemas: string[]; choices: Activity[] }[] = [
  { schemas: ["intent", "intent_plan", "chat_route", "public_service_decision"], choices: ["request", "plan"] },
  { schemas: ["screen_picture", "screen_orientation", "screen_text_decision", "page_summary", "web_answer"], choices: ["page", "controls", "passage"] },
  { schemas: ["link_choice", "visual_navigation_control", "browse_step", "public_browse_step"], choices: ["controls", "page", "plan"] },
  { schemas: ["file_answer"], choices: ["file", "passage"] },
  { schemas: ["public_search_answer", "public_welfare_facts", "service_brief", "grounded_answer", "precheck"], choices: ["evidence", "passage", "answer"] },
  { schemas: ["review_before_output", "personal_answer_check", "public_answer_check", "public_research_coverage"], choices: ["check", "passage"] },
  { schemas: ["translate_quote", "translate_in", "translate_out"], choices: ["translate", "wording"] },
  { schemas: ["speech_repair", "simple", "general_answer"], choices: ["answer", "wording"] },
];
// These text passes work with public sources. Every other pass may carry private page, conversation, or file data.
const publicSources = new Set(["public_search_answer", "public_welfare_facts", "public_research_coverage", "service_brief"]);
const languageName: Record<Lang, string> = { ko: "Korean", en: "English", zh: "Chinese", ja: "Japanese" };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function prepareModelStatus(format: ResponseFormat, input: "text" | "screen" | "file", signal?: AbortSignal) {
  const scope = MODEL_STATUS.getStore();
  const name = format.type === "json_schema" ? format.json_schema.name : "intent";
  if (scope === undefined || signal?.aborted === true || name === "activity_line") return undefined;

  const language = scope.language;
  const freeText = input === "text" && publicSources.has(name);
  let choices = operations.find(op => op.schemas.includes(name))?.choices ?? ["request", "plan"];
  if (input === "file") choices = ["file", "passage"];
  if (input === "screen" && !choices.includes("controls")) choices = ["page", "controls"];
  const lines = choices.map(key => modelActivities[key][language]);
  let field = "backend_status";
  const description = freeText
    ? `One short sentence in ${languageName[language]} describing your current activity for the chat status line. Omit results, reasoning, personal details, identifiers and quotations from the source.`
    : "Choose the activity that best describes this pass for the chat status line.";
  let instruction = "";
  if (format.type === "json_schema") {
    const schema = format.json_schema.schema;
    if (!record(schema) || schema.type !== "object") return undefined;
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    if (!record(properties) || !Array.isArray(required)) return undefined;
    while (Object.hasOwn(properties, field) || required.includes(field)) field = "_" + field;
    const definition = freeText ? { type: "string", description } : { type: "string", enum: lines, description };
    format = { ...format, json_schema: { ...format.json_schema, schema: {
      ...schema, properties: { [field]: definition, ...properties }, required: [field, ...required],
    } } };
  } else {
    instruction = `Write "${field}" first in the JSON object for the chat status line. Choose its value from ${JSON.stringify(lines)}.`;
  }
  let publish: (line: string) => void;
  try {
    publish = scope.begin(name, lines[0]);
  } catch {
    return undefined;
  }
  let published = false;
  function accept(value: unknown) {
    if (published || signal?.aborted === true || typeof value !== "string") return;
    const line = value.trim();
    if (line.length === 0 || line.length > 160 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || (!freeText && !lines.includes(line))) return;
    published = true;
    try {
      void Promise.resolve(publish(line)).catch(() => {});
    } catch { /* A closed progress consumer must not interrupt an answer. */ }
  }
  let prefixDone = false;
  return {
    format, instruction,
    readPrefix(content: string) {
      if (prefixDone) return;
      // Parse only a complete, delimited first JSON string. Never infer progress from a partial answer.
      const first = /^\s*\{\s*"(_*backend_status)"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/u.exec(content.slice(0, 1200));
      prefixDone = first !== null || content.length >= 1200;
      if (first?.[1] !== field || first[2] === undefined) return;
      try { accept(JSON.parse(first[2])); } catch { /* Malformed status is optional to the caller. */ }
    },
    take(answer: unknown): unknown {
      if (!record(answer) || !Object.hasOwn(answer, field)) return answer;
      const { [field]: status, ...result } = answer;
      accept(status);
      return result;
    },
  };
}
