import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { welfareData } from '../../../core/assets.ts';
import { optional, omitAbsent } from '../../../core/schema.ts';
import { strip, asciiDecimalDigits } from '../../../core/text.ts';
import { todayIso } from '../../../core/time.ts';
import { tryUrl } from '../../../core/url.ts';
import { decodeHTML } from 'entities';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

export const dataPatterns = {
  declaration: /<!(DOCTYPE|ENT[Iı]TY)/iu,
  htmlEntity: /&([A-Za-z][A-Za-z0-9]*|#[0-9]+|#x[0-9A-Fa-f]+);/gu,
  numericEntity: /&#(\p{Nd}+);/gu,
  namedEntity: /&([a-z]+);/gu,
  lineBreak: /\r\n?/gu,
  trailingSpaces: /[ \t]+\n/gu,
  stageSeparator: /\p{White_Space}*·\p{White_Space}*/gu,
  contactList: /연락처목록|목록/gu,
  space: /\p{White_Space}/gu,
  localBase: /NationalWelfareInformationsV001\/?(?=\n?$)/u,
};


export const SourceRefSchema = z.looseObject({
  title: z.string(),
  url: z.string().refine(value => tryUrl(value) !== undefined),
  lastCheckedAt: z.string(),
  version: z.string(),
  note: optional(z.string()),
}).transform(omitAbsent);
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const WelfareServiceSchema = z.looseObject({
  servId: z.string(),
  servNm: z.string(),
  summary: z.string(),
  target: z.string(),
  applyMethod: z.string(),
  source: SourceRefSchema,
  /** 이하 공식 API 상세조회에서만 채워진다 */
  criteria: optional(z.string()),
  benefit: optional(z.string()),
  applySteps: optional(z.array(z.looseObject({ step: z.string(), detail: z.string() }))),
  contacts: optional(z.array(z.looseObject({ name: z.string(), value: z.string() }))),
  forms: optional(z.array(z.looseObject({ name: z.string(), url: z.string() }))),
  laws: optional(z.array(z.string())),
  ministry: optional(z.string()),
  criteriaYear: optional(z.string()),
  enfcBgngYmd: optional(z.string()), enfcEndYmd: optional(z.string()),
  onlineApply: optional(z.boolean()),
}).transform(omitAbsent);
export type WelfareService = z.infer<typeof WelfareServiceSchema> & { dataOrigin: 'fixture' | 'official-api' };

export const FieldGlossaryEntrySchema = z.looseObject({
  fieldId: z.string(),
  term: z.string(),
  explanation: z.string(),
  source: SourceRefSchema,
});
export type FieldGlossaryEntry = z.infer<typeof FieldGlossaryEntrySchema>;

export const WelfareFixtureSchema = z.looseObject({
  version: z.string(),
  dataOrigin: z.literal('fixture'),
  notice: z.string(),
  services: z.array(WelfareServiceSchema),
  fieldGlossary: z.array(FieldGlossaryEntrySchema),
});
export type WelfareFixture = z.infer<typeof WelfareFixtureSchema>;

/** 맞춤 찾기용 서비스 요약(중앙부처·지자체 목록조회 공통). 분류 값은 응답의 글자 그대로. */
export interface ServiceSummary {
  servId: string;
  servNm: string;
  summary: string;
  lifeStages: string[];
  targets: string[];
  themes: string[];
  onlineApply?: boolean;
  provider: 'central' | 'local';
  region?: { ctpv: string; sgg?: string };
  ministry?: string;
  detailUrl: string;
  lastModified?: string;
  /** 제공 방식(예: 현금지급)·지원 주기(예: 월) */
  provision?: string;
  cycle?: string;
}

const splitList = (v: unknown) =>
  (typeof v === 'string' ? v : '')
    .split(',')
    .map(strip)
    .filter(Boolean);

/** 목록조회 XML → 요약 목록. 중앙(lifeArray…)·지자체(lifeNmArray…, ctpvNm) 필드를 모두 받는다. */
export function parseServiceCatalog(body: string, provider: 'central' | 'local'): ServiceSummary[] {
  const root = rootOf(body, "wantedList");
  if (!root) throw new WelfareApiError(apiErrorMessage(body));
  return items(root.servList).map((r) => omitAbsent({
    servId: cleanApiText(r.servId),
    servNm: cleanApiText(r.servNm),
    summary: cleanApiText(r.servDgst),
    lifeStages: splitList(r.lifeArray ?? r.lifeNmArray).map((x) => x.replace(dataPatterns.stageSeparator, '·')),
    targets: splitList(r.trgterIndvdlArray ?? r.trgterIndvdlNmArray),
    themes: splitList(r.intrsThemaArray ?? r.intrsThemaNmArray),
    onlineApply: r.onapPsbltYn !== undefined ? cleanApiText(r.onapPsbltYn) === 'Y' : undefined,
    provider,
    region: cleanApiText(r.ctpvNm).length > 0 ? omitAbsent({ ctpv: cleanApiText(r.ctpvNm), sgg: nonempty(cleanApiText(r.sggNm)) }) : undefined,
    ministry: nonempty(cleanApiText(r.jurMnofNm ?? r.bizChrDeptNm)),
    detailUrl: cleanApiText(r.servDtlLink),
    lastModified: nonempty(cleanApiText(r.lastModYmd ?? r.svcfrstRegTs)),
    provision: nonempty(cleanApiText(r.srvPvsnNm)),
    cycle: nonempty(cleanApiText(r.sprtCycNm)),
  }));
}

/** Agent B가 사용하는 복지 데이터 경계. 정책 데이터는 화면 상태·사용자 입력과 섞지 않는다. */
export interface WelfareDataProvider {
  /** 맞춤 찾기용 전체 목록(중앙부처 + 지정한 시·도의 지자체 서비스) */
  catalog(ctpv?: string, signal?: AbortSignal): Promise<ServiceSummary[]>;
  /** 지자체 서비스 상세(선정기준 포함). 없으면 undefined */
  getLocalService?(servId: string, detailUrl?: string): Promise<WelfareService | undefined>;
  readonly mode: 'fixture' | 'official-api';
  readonly lastError?: string;
  listServices(query?: string, signal?: AbortSignal): Promise<WelfareService[]>;
  getService(servId: string, signal?: AbortSignal): Promise<WelfareService | undefined>;
  /** 서비스명으로 찾아 상세까지 채워 돌려준다(예: "장애인연금"). */
  findService(name: string, signal?: AbortSignal): Promise<WelfareService | undefined>;
  getFieldGlossary(fieldId: string): Promise<FieldGlossaryEntry | undefined>;
}

export const DEFAULT_FIXTURE_PATH = join(welfareData, 'fixtures', 'welfare_services.json');
const FIXTURE_DIR = join(welfareData, 'fixtures');

/** 저장해 둔 실제 목록 응답(2026-11-16). API 키가 없거나 실패할 때의 대체 자료. 지자체는 부산 예시만. */
export function fixtureCatalog(ctpv?: string): ServiceSummary[] {
  const read = (f: string) => readFileSync(join(FIXTURE_DIR, f), 'utf8');
  const central = parseServiceCatalog(read('welfare-catalog-central.xml'), 'central');
  const local = ctpv === '부산광역시' ? parseServiceCatalog(read('welfare-catalog-local-busan.xml'), 'local') : [];
  return [...central, ...local];
}

const normalize = (s: string) => s.replace(dataPatterns.space, '');

export class FixtureWelfareDataProvider implements WelfareDataProvider {
  readonly mode = 'fixture' as const;

  readonly data: WelfareFixture;
  constructor(data: WelfareFixture) { this.data = data; }

  static fromFile(path = DEFAULT_FIXTURE_PATH): FixtureWelfareDataProvider {
    return new FixtureWelfareDataProvider(WelfareFixtureSchema.parse(JSON.parse(readFileSync(path, 'utf8'))));
  }

  get notice(): string {
    return this.data.notice;
  }

  async catalog(ctpv?: string): Promise<ServiceSummary[]> {
    return fixtureCatalog(ctpv);
  }

  async listServices(query = ''): Promise<WelfareService[]> {
    const q = normalize(query);
    return this.data.services
      .filter((s) => q.length === 0 || normalize(s.servNm).includes(q) || q.includes(normalize(s.servNm)))
      .map((s) => ({ ...s, dataOrigin: 'fixture' as const }));
  }

  async getService(servId: string): Promise<WelfareService | undefined> {
    const s = this.data.services.find((x) => x.servId === servId);
    return s && { ...s, dataOrigin: 'fixture' };
  }

  async findService(name: string): Promise<WelfareService | undefined> {
    return (await this.listServices(name)).find((s) => normalize(s.servNm) === normalize(name));
  }

  async getFieldGlossary(fieldId: string): Promise<FieldGlossaryEntry | undefined> {
    return this.data.fieldGlossary.find((g) => g.fieldId === fieldId);
  }
}

// ---------------------------------------------------------------- 공식 API

export interface RawApiResponse {
  status: number;
  body: string;
  /** serviceKey를 제거한 요청 URL */
  requestUrl: string;
  requestedAt: string;
}

export class WelfareApiError extends Error {
  readonly reason: string;
  readonly status?: number;
  constructor(reason: string, status?: number) {
    super(`welfare api: ${reason}`);
    this.reason = reason;
    this.status = status;
  }
}

function nonempty(text: string): string | undefined { return text.length === 0 ? undefined : text; }

const ENTITIES: Record<string, string> = { times: '×', divide: '÷', ge: '≥', le: '≤', amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

/** 응답에 이중 인코딩된 HTML 엔티티(&amp;times; 등)와 &#13; 줄바꿈이 섞여 있어 정리한다. */
export function cleanApiText(raw: unknown): string {
  if (raw === undefined || raw === null || typeof raw === 'object') return '';
  return strip((typeof raw === 'boolean' ? (raw ? 'True' : 'False') : String(raw))
    .replace(dataPatterns.numericEntity, (_, n: string) => String.fromCodePoint(Number(asciiDecimalDigits(n))))
    .replace(dataPatterns.namedEntity, (m, name: string) => Object.hasOwn(ENTITIES, name) ? ENTITIES[name] ?? m : m)
    .replace(dataPatterns.lineBreak, '\n')
    .replace(dataPatterns.trailingSpaces, '\n')
    );
}

type Row = Record<string, unknown>;
function isRow(v: unknown): v is Row { return typeof v === "object" && v !== null && !Array.isArray(v); }
const items = (v: unknown): Row[] => Array.isArray(v) ? v.filter(isRow) : [];
const listTags = new Set(['servList', 'applmetList', 'inqplCtadrList', 'inqplHmpgReldList', 'basfrmList', 'baslawList']);
const xml = new XMLParser({
  preserveOrder: true, ignoreAttributes: true, ignoreDeclaration: true, ignorePiTags: true,
  parseTagValue: false, trimValues: false, processEntities: false, cdataPropName: '#cdata',
});

interface XmlNode { [tag: string]: XmlNode[] | string }

function decodeXmlText(text: string): string {
  return text.replace(/&([^;]+);/gu, (entity, name: string) => {
    if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return decodeHTML(entity);
    if (!name.startsWith('#')) throw new Error('알 수 없는 XML 엔티티');
    const point = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!(point === 9 || point === 10 || point === 13 || (point >= 32 && point <= 0xd7ff)
      || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) throw new Error('잘못된 XML 문자');
    return String.fromCodePoint(point);
  });
}

function elementValue(children: XmlNode[]): Row | string {
  const fields: Row = Object.create(null) as Row;
  let text = '';
  for (const child of children) {
    for (const [tag, value] of Object.entries(child)) {
      if (typeof value === 'string') {
        text += decodeXmlText(value);
      } else if (tag === '#cdata') {
        for (const section of value) if (typeof section['#text'] === 'string') text += section['#text'];
      } else {
        const item = elementValue(value);
        const prior = fields[tag];
        if (Array.isArray(prior)) prior.push(item);
        else if (prior !== undefined) fields[tag] = [prior, item];
        else fields[tag] = listTags.has(tag) ? [item] : item;
      }
    }
  }
  return Object.keys(fields).length > 0 ? fields : strip(text);
}

export function parseXml(body: string): Row {
  if (dataPatterns.declaration.test(body)) return {};
  try {
    const cleaned = body.replace(dataPatterns.htmlEntity, (entity, name: string) => {
      if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name) || name.startsWith('#')) return entity;
      const decoded = decodeHTML(entity);
      return decoded === entity ? entity : decoded.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    });
    if (XMLValidator.validate(cleaned) !== true) return {};
    const nodes = xml.parse(cleaned) as XmlNode[];
    if (nodes.length !== 1 || nodes[0] === undefined) return {};
    const root = Object.entries(nodes[0])[0];
    return root !== undefined && Array.isArray(root[1]) ? { [root[0]]: elementValue(root[1]) } : {};
  } catch {
    return {};
  }
}
function rootOf(body: string, tag: string) {
  const value = parseXml(body)[tag];
  return isRow(value) ? value : undefined;
}

/** 목록조회(callTp=L) XML → 서비스 요약. 필드는 실제 응답으로 확인함(2026-11-16). */
export function parseWelfareList(body: string, checkedAt = todayIso()): WelfareService[] {
  const root = rootOf(body, "wantedList");
  if (!root) throw new WelfareApiError(apiErrorMessage(body));
  if (String(root.resultCode ?? '0') !== '0') throw new WelfareApiError(String(root.resultMessage ?? 'resultCode != 0'));
  return items(root.servList).map((r) => {
    const servNm = cleanApiText(r.servNm);
    return {
      servId: cleanApiText(r.servId),
      servNm,
      summary: cleanApiText(r.servDgst),
      target: '',
      applyMethod: '',
      ministry: [cleanApiText(r.jurMnofNm), cleanApiText(r.jurOrgNm)].filter(Boolean).join(' '),
      onlineApply: cleanApiText(r.onapPsbltYn) === 'Y',
      source: officialSource(servNm, cleanApiText(r.servDtlLink), checkedAt),
      dataOrigin: 'official-api' as const,
    };
  });
}

/** 상세조회(callTp=D) XML → 서비스 상세. 출처 링크는 목록조회의 servDtlLink를 넘겨받는다. */
export function parseWelfareDetail(body: string, detailUrl: string, checkedAt = todayIso()): WelfareService {
  const r = rootOf(body, "wantedDtl");
  if (!r) throw new WelfareApiError(apiErrorMessage(body));
  if (String(r.resultCode ?? '0') !== '0') throw new WelfareApiError(String(r.resultMessage ?? 'resultCode != 0'));
  const servNm = cleanApiText(r.servNm);
  const applySteps = items(r.applmetList).map((a) => ({
    step: strip(cleanApiText(a.servSeDetailNm).replace(dataPatterns.contactList, '')),
    detail: cleanApiText(a.servSeDetailLink),
  }));
  const criteriaYear = cleanApiText(r.crtrYr);
  // 지자체 상세(LcgvWelfaredetailed)는 필드 이름이 다르다: sprtTrgtCn·aplyMtdCn·wlfareInfoReld*
  const local = r.ctpvNm !== undefined;
  return {
    servId: cleanApiText(r.servId),
    servNm,
    summary: cleanApiText(r.wlfareInfoOutlCn ?? r.servDgst),
    target: cleanApiText(r.tgtrDtlCn ?? r.sprtTrgtCn),
    criteria: cleanApiText(r.slctCritCn),
    benefit: cleanApiText(r.alwServCn),
    applyMethod: applySteps[0]?.detail ?? cleanApiText(r.aplyMtdCn ?? r.aplyMtdNm),
    applySteps,
    contacts: [...items(r.inqplCtadrList), ...items(r.inqplHmpgReldList)].map((c) => ({
      name: cleanApiText(c.servSeDetailNm ?? c.wlfareInfoReldNm),
      value: cleanApiText(c.servSeDetailLink ?? c.wlfareInfoReldCn),
    })),
    forms: items(r.basfrmList).map((f) => ({ name: cleanApiText(f.servSeDetailNm ?? f.wlfareInfoReldNm), url: cleanApiText(f.servSeDetailLink ?? f.wlfareInfoReldCn) })),
    laws: items(r.baslawList).map((l) => cleanApiText(l.servSeDetailNm ?? l.wlfareInfoReldNm)).filter(Boolean),
    ministry: cleanApiText(r.jurMnofNm ?? (local ? r.bizChrDeptNm : undefined)),
    criteriaYear,
    ...(cleanApiText(r.enfcBgngYmd).length > 0 ? {enfcBgngYmd: cleanApiText(r.enfcBgngYmd)} : {}),
    ...(cleanApiText(r.enfcEndYmd).length > 0 ? {enfcEndYmd: cleanApiText(r.enfcEndYmd)} : {}),
    source: officialSource(servNm, detailUrl, checkedAt, criteriaYear),
    dataOrigin: 'official-api',
  };
}

function officialSource(servNm: string, url: string, checkedAt: string, year?: string): SourceRef {
  return {
    title: `복지로 '${servNm}' (한국사회보장정보원 중앙부처복지서비스 API)`,
    url: url.length > 0 ? url : 'https://www.data.go.kr/data/15090532/openapi.do',
    lastCheckedAt: checkedAt,
    version: year !== undefined && year.length > 0 ? `${year}년 기준` : 'API 실시간',
    note: '공식 API 실시간 조회',
  };
}

function apiErrorMessage(body: string): string {
  const header = rootOf(body, "OpenAPI_ServiceResponse")?.cmmMsgHeader;
  const h = isRow(header) ? header : undefined;
  return h ? `${cleanApiText(h.errMsg)} (${cleanApiText(h.returnAuthMsg)})` : '알 수 없는 응답 형식';
}

/**
 * 한국사회보장정보원 중앙부처복지서비스 API (https://www.data.go.kr/data/15090532/openapi.do).
 * 오퍼레이션 경로와 응답 필드는 실제 호출로 확인했다. 실패하면 fixture로 대체하고 그 사실을 남긴다.
 * 조회 결과는 메모리에 캐시한다(기본 6시간).
 */
export class OfficialCentralWelfareApiProvider implements WelfareDataProvider {
  readonly mode = 'official-api' as const;
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  /** 마지막 실패 사유(진단용). 성공하면 지워진다. */
  lastError?: string;

  private readonly opts: { apiKey: string; baseUrl: string; timeoutMs?: number; cacheMs?: number };
  private readonly fallback: WelfareDataProvider;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: OfficialCentralWelfareApiProvider['opts'], fallback: WelfareDataProvider, fetchImpl: typeof fetch = fetch) {
    this.opts = opts; this.fallback = fallback; this.fetchImpl = fetchImpl;
  }

  private requestSignal(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 10_000);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }

  async fetchRaw(params: { callTp: 'L' | 'D'; servId?: string; extra?: Record<string, string> }, signal?: AbortSignal): Promise<RawApiResponse> {
    // 오퍼레이션별 경로(실제 호출로 확인): 목록 /NationalWelfarelistV001, 상세 /NationalWelfaredetailedV001
    const operation = params.callTp === 'L' ? 'NationalWelfarelistV001' : 'NationalWelfaredetailedV001';
    const url = new URL(`${this.opts.baseUrl.replace(/\/+$/u, '')}/${operation}`);
    url.searchParams.set('callTp', params.callTp);
    if (params.callTp === 'L') {
      // 목록조회 필수값(공공데이터포털 명세)
      url.searchParams.set('pageNo', '1');
      url.searchParams.set('numOfRows', '10');
      url.searchParams.set('srchKeyCode', '001');
    }
    if (params.servId !== undefined && params.servId.length > 0) url.searchParams.set('servId', params.servId);
    for (const [k, v] of Object.entries(params.extra ?? {})) url.searchParams.set(k, v);
    url.searchParams.delete('serviceKey');
    const requestUrl = url.toString();
    url.searchParams.set('serviceKey', this.opts.apiKey);
    const res = await this.fetchImpl(url, { signal: this.requestSignal(signal) });
    return { status: res.status, body: await res.text(), requestUrl, requestedAt: new Date().toISOString() };
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (this.opts.cacheMs ?? 6 * 60 * 60 * 1000)) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async withFallback<T>(work: () => Promise<T>, fallback: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    try {
      const v = await work();
      signal?.throwIfAborted();
      this.lastError = undefined;
      return v;
    } catch (e) {
      signal?.throwIfAborted();
      const message = e instanceof Error ? e.message : 'unknown';
      const key = this.opts.apiKey;
      const encodedKey = new URLSearchParams({ serviceKey: key }).toString().slice('serviceKey='.length);
      this.lastError = key.length === 0 ? message : message.replaceAll(encodedKey, '[비공개]').replaceAll(key, '[비공개]');
      console.warn(`[welfare] 공식 API 실패 → fixture 사용: ${this.lastError}`);
      return fallback();
    }
  }

  private localBaseUrl(): string {
    // 지자체복지서비스 API: 같은 기관(B554287)의 LocalGovernmentWelfareInformations (실제 호출로 확인)
    return this.opts.baseUrl.replace(dataPatterns.localBase, 'LocalGovernmentWelfareInformations');
  }

  async catalog(ctpv?: string, signal?: AbortSignal): Promise<ServiceSummary[]> {
    return this.withFallback(
      async () => {
        const central = await this.cached('C:central', async () => {
          const res = await this.fetchRaw({ callTp: 'L', extra: { numOfRows: '500' } }, signal);
          if (res.status !== 200) throw new WelfareApiError(apiErrorMessage(res.body), res.status);
          return parseServiceCatalog(res.body, 'central');
        });
        if (ctpv === undefined || ctpv.length === 0) return central;
        const local = await this.cached(`C:local:${ctpv}`, async () => {
          const url = new URL(`${this.localBaseUrl()}/LcgvWelfarelist`);
          for (const [k, v] of Object.entries({ pageNo: '1', numOfRows: '500', srchKeyCode: '001', ctpvNm: ctpv })) url.searchParams.set(k, v);
          url.searchParams.set('serviceKey', this.opts.apiKey);
          const res = await this.fetchImpl(url, { signal: this.requestSignal(signal) });
          const body = await res.text();
          if (res.status !== 200) throw new WelfareApiError(apiErrorMessage(body), res.status);
          return parseServiceCatalog(body, 'local');
        });
        return [...central, ...local];
      },
      async () => fixtureCatalog(ctpv), signal,
    );
  }

  private async list(query: string, signal?: AbortSignal): Promise<WelfareService[]> {
    return this.cached(`L:${query}`, async () => {
      const res = await this.fetchRaw({ callTp: 'L', extra: query.length > 0 ? { searchWrd: query } : {} }, signal);
      if (res.status !== 200) throw new WelfareApiError(apiErrorMessage(res.body), res.status);
      return parseWelfareList(res.body);
    });
  }

  private async detail(servId: string, detailUrl: string, signal?: AbortSignal): Promise<WelfareService> {
    return this.cached(`D:${servId}`, async () => {
      const res = await this.fetchRaw({ callTp: 'D', servId }, signal);
      if (res.status !== 200) throw new WelfareApiError(apiErrorMessage(res.body), res.status);
      return parseWelfareDetail(res.body, detailUrl);
    });
  }

  listServices(query = '', signal?: AbortSignal): Promise<WelfareService[]> {
    return this.withFallback(() => this.list(query, signal), () => this.fallback.listServices(query, signal), signal);
  }

  getService(servId: string, signal?: AbortSignal): Promise<WelfareService | undefined> {
    return this.withFallback(
      () => this.detail(servId, '', signal),
      () => this.fallback.getService(servId, signal), signal,
    );
  }

  findService(name: string, signal?: AbortSignal): Promise<WelfareService | undefined> {
    return this.withFallback(
      async () => {
        const hit = (await this.list(name, signal)).find((s) => normalize(s.servNm) === normalize(name));
        if (!hit) throw new WelfareApiError(`'${name}' 서비스를 찾지 못함`);
        return this.detail(hit.servId, hit.source.url, signal);
      },
      () => this.fallback.findService(name, signal), signal,
    );
  }

  async getLocalService(servId: string, detailUrl = ''): Promise<WelfareService | undefined> {
    return this.cached(`LD:${servId}`, async () => {
      const url = new URL(`${this.localBaseUrl()}/LcgvWelfaredetailed`);
      url.searchParams.set('servId', servId);
      url.searchParams.set('serviceKey', this.opts.apiKey);
      const res = await this.fetchImpl(url, { signal: this.requestSignal() });
      const body = await res.text();
      if (res.status !== 200) throw new WelfareApiError(apiErrorMessage(body), res.status);
      const s = parseWelfareDetail(body, detailUrl);
      return { ...s, source: { ...s.source, title: `복지로 '${s.servNm}' (한국사회보장정보원 지자체복지서비스 API)` } };
    }).catch(() => undefined);
  }

  getFieldGlossary(fieldId: string): Promise<FieldGlossaryEntry | undefined> {
    // 모의 신청서 항목 설명은 fixture 용어집을 쓴다(공식 API에는 해당 정보 없음).
    return this.fallback.getFieldGlossary(fieldId);
  }
}

export function createWelfareDataProvider(opts: {
  fixturePath?: string;
  apiKey?: string;
  apiBaseUrl?: string; fetchImpl?: typeof fetch;
} = {}): WelfareDataProvider {
  const fixture = FixtureWelfareDataProvider.fromFile(opts.fixturePath);
  if (opts.apiKey !== undefined && opts.apiKey.length > 0 && opts.apiBaseUrl !== undefined && opts.apiBaseUrl.length > 0) {
    return new OfficialCentralWelfareApiProvider({ apiKey: opts.apiKey, baseUrl: opts.apiBaseUrl }, fixture, opts.fetchImpl);
  }
  return fixture;
}
