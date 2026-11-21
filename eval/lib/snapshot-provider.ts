import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FixtureWelfareDataProvider,
  parseWelfareDetail,
  type FieldGlossaryEntry,
  type ServiceSummary,
  type WelfareDataProvider,
  type WelfareService,
} from '@ieum/welfare-data';

const SNAPSHOT_DIR = fileURLToPath(new URL('../snapshots/welfare/', import.meta.url));
const norm = (s: string) => s.replace(/\s|\(.*?\)/g, '');

/**
 * 평가 전용 복지 데이터: eval/snapshots/welfare/*.xml(공식 API 상세 저장본)로 답한다.
 * 맞춤 찾기 목록은 저장된 중앙부처 목록(packages/welfare-data/fixtures)을 쓴다.
 * 인터넷·API 상태와 상관없이 모든 모델이 같은 자료로 평가받게 하려는 것.
 */
export class SnapshotWelfareDataProvider implements WelfareDataProvider {
  readonly mode = 'official-api' as const;
  private readonly fixture = FixtureWelfareDataProvider.fromFile();
  readonly services: WelfareService[];

  constructor(dir = SNAPSHOT_DIR) {
    this.services = readdirSync(dir)
      .filter((f) => f.endsWith('.xml'))
      .map((f) => ({ ...parseWelfareDetail(readFileSync(`${dir}${f}`, 'utf8'), `https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=${f.replace('.xml', '')}`), dataOrigin: 'official-api' as const }));
  }

  /** 근거 글(답의 숫자 검사용): 모든 스냅숏 본문 */
  get groundTexts(): string[] {
    return this.services.map((s) => [s.servNm, s.summary, s.target, s.criteria, s.benefit, s.applyMethod, ...(s.contacts ?? []).map((c) => `${c.name} ${c.value}`)].join('\n'));
  }

  catalog(ctpv?: string): Promise<ServiceSummary[]> {
    return this.fixture.catalog(ctpv);
  }

  async listServices(query = ''): Promise<WelfareService[]> {
    const q = norm(query);
    return this.services.filter((s) => !q || norm(s.servNm).includes(q) || q.includes(norm(s.servNm)));
  }

  async getService(servId: string): Promise<WelfareService | undefined> {
    return this.services.find((s) => s.servId === servId);
  }

  async findService(name: string): Promise<WelfareService | undefined> {
    const q = norm(name);
    return this.services.find((s) => norm(s.servNm) === q) ?? this.services.find((s) => norm(s.servNm).startsWith(q) || q.startsWith(norm(s.servNm)));
  }

  getLocalService(): Promise<WelfareService | undefined> {
    return Promise.resolve(undefined);
  }

  getFieldGlossary(fieldId: string): Promise<FieldGlossaryEntry | undefined> {
    return this.fixture.getFieldGlossary(fieldId);
  }
}
