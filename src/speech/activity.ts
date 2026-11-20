import type { StructuredLlm } from "../core/llm.ts";
import { josa } from "./phrasing.ts";

export type ActivityPhase = "thinking" | "pulling" | "tool" | "checking" | "step";
export interface ActivityFact {
  phase: ActivityPhase;
  source?: string;
  action?: string;
  target?: string;
  ok?: boolean;
}

const CLAIM = /열었|열렸|열림|찾았|끝났|완료|눌렀|성공|됐|되었|이동했|들어갔/u;

function cut(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = Array.from(value).slice(0, max).join("");
  return text.length > 0 ? text : undefined;
}

export function fixedActivity(fact: ActivityFact): string {
  switch (fact.phase) {
    case "thinking": return "생각하는 중이에요.";
    case "pulling": {
      const source = fact.source?.trim() ?? "";
      return source.length > 0 ? `${source}에서 내용을 가져오는 중이에요.` : "내용을 가져오는 중이에요.";
    }
    case "tool": return "요청한 일을 실행하는 중이에요.";
    case "checking": return "답을 찾았어요. 화면과 맞는지 확인할게요.";
    case "step": return stepLine(fact);
  }
}

function stepLine(fact: ActivityFact): string {
  const name = Array.from(fact.target ?? "").slice(0, 20).join("");
  if (fact.action === "click" && name.length > 0) {
    const target = josa(`'${name}'`, "을", "를");
    return fact.ok === true ? `${target} 눌렀어요.` : `${target} 누르려고 했어요.`;
  }
  return "다음에 할 일을 다시 고르고 있어요.";
}

export function settleActivity(current: number, request: number, line: string, fixed: string): string {
  return current === request ? line : fixed;
}

function claimedSuccess(line: string, ok: boolean | undefined): boolean {
  return ok !== true && CLAIM.test(line);
}

export async function describeActivity(llm: StructuredLlm | undefined, fact: ActivityFact, signal?: AbortSignal): Promise<string> {
  const fixed = fixedActivity(fact);
  if (llm === undefined) return fixed;
  const body: ActivityFact = {
    phase: fact.phase, action: fact.action, ok: fact.ok,
    source: cut(fact.source, 40), target: cut(fact.target, 20),
  };
  try {
    const data = await llm.generate({
      system: "한 문장의 공손한 한국어만 쓰세요. ok가 true가 아니면 열었거나, 찾았거나, 끝났거나, 눌렀다고 말하지 마세요.",
      user: JSON.stringify(body),
      schemaName: "activity_line",
      schema: { type: "object", additionalProperties: false, required: ["line"], properties: { line: { type: "string" } } },
      signal,
    });
    const line = typeof data === "object" && data !== null && "line" in data && typeof data.line === "string" ? data.line.trim() : "";
    if (line.length === 0 || claimedSuccess(line, fact.ok)) return fixed;
    return line;
  } catch {
    return fixed;
  }
}
