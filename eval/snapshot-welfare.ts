/**
 * 평가용 복지 데이터 스냅숏 만들기(한 번만, 또는 기준연도가 바뀔 때).
 * 공식 API(한국사회보장정보원 중앙부처복지서비스) 상세 응답을 eval/snapshots/welfare/<servId>.xml 로 저장한다.
 * 평가는 이 저장본으로 돌려서 인터넷·API 상태와 상관없이 같은 정답(goldFacts)으로 비교한다.
 * 사용: npx tsx eval/snapshot-welfare.ts   (.env의 WELFARE_API_KEY, WELFARE_API_BASE_URL 필요)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { FixtureWelfareDataProvider, OfficialCentralWelfareApiProvider, parseWelfareDetail } from '@ieum/welfare-data';

const root = fileURLToPath(new URL('..', import.meta.url));
loadEnv({ path: `${root}.env` });

/** 평가에 쓰는 핵심 제도(저장된 중앙부처 목록에서 확인한 servId) */
export const SNAPSHOT_SERVICES: Record<string, string> = {
  WLF00001164: '기초연금',
  WLF00003249: '장애인연금',
  WLF00003265: '장애수당',
  WLF00003198: '장애아동수당',
  WLF00003260: '장애인활동지원',
  WLF00003201: '주거급여(맞춤형 급여)',
  WLF00001132: '생계급여(맞춤형 급여)',
  WLF00001089: '교육급여(맞춤형 급여)',
  WLF00001171: '아동수당 지급',
  WLF00004657: '부모급여 지원',
  WLF00000072: '에너지바우처',
  WLF00003180: '긴급복지 생계지원',
};

const apiKey = process.env.WELFARE_API_KEY;
const baseUrl = process.env.WELFARE_API_BASE_URL;
if (!apiKey || !baseUrl) {
  console.error('WELFARE_API_KEY, WELFARE_API_BASE_URL이 .env에 필요합니다.');
  process.exit(1);
}
const api = new OfficialCentralWelfareApiProvider({ apiKey, baseUrl }, FixtureWelfareDataProvider.fromFile());
const dir = `${root}eval/snapshots/welfare`;
mkdirSync(dir, { recursive: true });
for (const [servId, name] of Object.entries(SNAPSHOT_SERVICES)) {
  const res = await api.fetchRaw({ callTp: 'D', servId });
  if (res.status !== 200 || !res.body.includes('<servNm>')) {
    console.log(`실패 ${servId} ${name} (HTTP ${res.status})`);
    continue;
  }
  const parsed = parseWelfareDetail(res.body, 'https://www.bokjiro.go.kr/');
  writeFileSync(`${dir}/${servId}.xml`, res.body);
  console.log(`저장 ${servId} ${parsed.servNm} (대상 ${parsed.target.length}자, 내용 ${(parsed.benefit ?? '').length}자)`);
}
writeFileSync(`${dir}/_meta.json`, JSON.stringify({ savedAt: new Date().toISOString(), source: '한국사회보장정보원 중앙부처복지서비스 상세(NationalWelfaredetailedV001)', services: SNAPSHOT_SERVICES }, null, 2));
