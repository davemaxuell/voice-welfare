import { existsSync } from "node:fs";
import { WelfareInformationAgent } from "../src/agents/welfare/agent.ts";
import { OfficialCentralWelfareApiProvider, createWelfareDataProvider } from "../src/agents/welfare/data/index.ts";
import { loadConfig } from "../src/server/runtime.ts";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main(): Promise<number> {
  const cfg = loadConfig();
  const provider = createWelfareDataProvider({apiKey: cfg.welfareApiKey, apiBaseUrl: cfg.welfareApiBaseUrl});
  if (!(provider instanceof OfficialCentralWelfareApiProvider)) {
    console.log("공식 API 모드가 아닙니다. .env에 WELFARE_DATA_MODE=official-api, WELFARE_API_KEY, WELFARE_API_BASE_URL을 설정하세요.");
    return 1;
  }
  const start = performance.now();
  const service = await provider.findService("장애인연금");
  if (service?.dataOrigin !== "official-api") {
    console.error(`✗ 공식 API 조회 실패 → fixture로 대체됨. 사유: ${provider.lastError ?? "알 수 없음"}`);
    return 1;
  }
  console.log(`✓ 조회 성공 (${Math.floor(performance.now()-start)}ms): ${service.servNm} (${service.servId}), ${service.source.version ?? ""}`);
  console.log(`  출처: ${service.source.url}`);
  const count = (s?: string) => Array.from(s ?? "").length;
  console.log(`  필드: 대상 ${count(service.target)}자, 선정기준 ${count(service.criteria)}자, 지원내용 ${count(service.benefit)}자, 신청절차 ${service.applySteps?.length ?? 0}단계, 서식 ${service.forms?.length ?? 0}개`);
  const answer = await new WelfareInformationAgent(provider).answerPolicyQuestion("장애인연금 지원대상과 신청 절차 알려줘");
  console.log("✓ Agent B 답변: " + answer.speech);
  return 0;
}

process.exitCode = await main();
