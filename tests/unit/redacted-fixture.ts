import type { Redacted } from "../../src/core/llm.ts";

// 이미 비식별화한 테스트 발화와 기록된 가짜 모델 입력에만 쓴다.
export function fixtureText(value: string): Redacted {
  return value as Redacted;
}
