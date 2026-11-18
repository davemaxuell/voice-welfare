import { existsSync } from "node:fs";
import { z } from "zod";
import { createMockWelfareProfile, fieldVocabulary } from "../src/agents/web/profile.ts";
import { OPENAI_BASE_URL } from "../src/core/llm.ts";
import { redactText } from "../src/safety/privacy.ts";
import { createIntentProvider } from "../src/understanding/llm_planner.ts";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main(): Promise<number> {
  const provider = (process.env.LLM_PROVIDER?.trim().toLowerCase() ?? "");
  if (provider === "" || provider === "mock") {
    console.log("LLM_PROVIDER=mock 입니다. 키 없이 규칙 파서만 사용합니다.");
    return 0;
  }
  const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
  const model = process.env.LLM_MODEL?.trim() ?? "";
  const configured = process.env.LLM_BASE_URL?.trim() ?? "";
  const baseUrl = (configured === "" && provider === "openai" ? OPENAI_BASE_URL : configured).replace(/\/+$/u, "");
  const missing = Object.entries({LLM_API_KEY: apiKey, LLM_MODEL: model, LLM_BASE_URL: baseUrl}).filter(([, v]) => v === "").map(([k]) => k);
  if (missing.length > 0) {
    console.error(`.env에 ${missing.join(", ")} 값이 비어 있습니다. 키를 넣은 뒤 다시 실행하세요.`);
    return 1;
  }
  const res = await fetch(baseUrl + "/models", {headers: {Authorization: "Bearer " + apiKey}, signal: AbortSignal.timeout(20_000)});
  if (!res.ok) {
    console.error(`모델 목록 조회 실패 (HTTP ${res.status}). 키가 올바른지, 결제/크레딧이 설정됐는지 확인하세요.`);
    return 1;
  }
  const ids = z.object({data: z.array(z.object({id: z.string()})).default([])}).parse(await res.json()).data.map(m => m.id)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  console.log(`✓ 키 확인 완료 (사용 가능 모델 ${ids.length}개)`);
  if (!ids.includes(model)) {
    const small = ids.filter(id => /(mini|nano|flash|luna|terra)/iu.test(id)).slice(0, 15);
    console.error(`✗ LLM_MODEL="${model}" 은(는) 이 키로 쓸 수 없습니다.${small.length > 0 ? "\n  후보(소형): " + small.join(", ") : ""}`);
    return 1;
  }
  console.log(`✓ LLM_MODEL="${model}" 사용 가능`);
  const intent = createIntentProvider({provider, model, apiKey, baseUrl, reasoningEffort: process.env.LLM_REASONING_EFFORT?.trim()},
    fieldVocabulary(createMockWelfareProfile("http://localhost:5174")));
  const sample = "사는 데가 부산광역시 예시구 예시로 10이에요";
  const start = performance.now();
  const result = await intent.parse(redactText(sample), {state: "APPLICATION_OPEN"});
  console.log(`✓ 의도 분류 테스트 (${Math.floor(performance.now() - start)}ms): "${sample}" → ${JSON.stringify(result)}`);
  if (result.type === "UNKNOWN") console.log("  ⚠ UNKNOWN이 나왔습니다. 모델이 strict json_schema를 지원하는지, 응답이 거절되지 않았는지 확인하세요.");
  return 0;
}

process.exitCode = await main();
