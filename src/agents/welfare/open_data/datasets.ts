/** 연간 공개 자료의 스키마, 출처와 행 수 하한. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ASSET_ROOT } from "../../../core/assets.ts";
import { PLACE_KINDS, type PlaceKind } from "../../../core/places.ts";

/** Python str의 정렬 순서(코드 포인트 순). */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;
const COMPACT_DATE = /^([0-9]{4})([0-9]{2})([0-9]{2})$/u;
const WEEK_DATE = /^([0-9]{4})-?W([0-9]{2})(?:-?([0-9]))?$/u;
const DAY_MS = 86_400_000;

function isoParts(year: number, month: number, day: number): string | undefined {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isoWeekDate(year: number, week: number, day: number): string | undefined {
  if (year < 1 || year > 9999 || week < 1 || week > 53 || day < 1 || day > 7) return undefined;
  const fourth = new Date(0);
  fourth.setUTCFullYear(year, 0, 4);
  const mondayOfFirstWeek = fourth.getTime() - ((fourth.getUTCDay() + 6) % 7) * DAY_MS;
  const target = new Date(mondayOfFirstWeek + ((week - 1) * 7 + (day - 1)) * DAY_MS);
  // 53번째 주는 그 주의 목요일이 같은 해에 있을 때만 있다.
  const thursday = new Date(target.getTime() + (3 - (day - 1)) * DAY_MS);
  if (week === 53 && thursday.getUTCFullYear() !== year) return undefined;
  return isoParts(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate());
}

/** Python date.fromisoformat(3.11 이후): YYYY-MM-DD, YYYYMMDD, ISO 주 날짜(YYYY-Www-D, YYYYWwwD, YYYY-Www, YYYYWww). 잘못되면 RangeError(Python ValueError). */
export function fromIsoDate(text: string): string {
  let found: string | undefined;
  const calendar = ISO_DATE.exec(text) ?? COMPACT_DATE.exec(text);
  if (calendar !== null) {
    found = isoParts(Number(calendar[1]), Number(calendar[2]), Number(calendar[3]));
  } else if ([7, 8, 10].includes(text.length)) {
    const week = WEEK_DATE.exec(text);
    if (week !== null) found = isoWeekDate(Number(week[1]), Number(week[2]), week[3] === undefined ? 1 : Number(week[3]));
  }
  if (found === undefined) throw new RangeError(`Invalid isoformat string: '${text}'`);
  return found;
}

const ZERO_TIME = /^[Tt _]00:00(?::00(?:[.,]([0-9]+))?)?(?:[Zz]|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])?$/u;

/** pydantic의 날짜 칸: YYYY-MM-DD, 그리고 시각이 자정인 날짜·시각 글. */
export function parseDateField(text: string): string | undefined {
  const date = ISO_DATE.exec(text.slice(0, 10));
  if (date === null) return undefined;
  const found = isoParts(Number(date[1]), Number(date[2]), Number(date[3]));
  if (found === undefined) return undefined;
  const rest = text.slice(10);
  if (rest.length === 0) return found;
  const time = ZERO_TIME.exec(rest);
  if (time === null || !/^0*$/u.test((time[1] ?? "").slice(0, 6))) return undefined;
  return found;
}

const isoDate = z.string().transform((value, context) => {
  const found = parseDateField(value);
  if (found === undefined) {
    context.issues.push({ code: "custom", message: "날짜 형식이 아닙니다.", input: value });
    return z.NEVER;
  }
  return found;
});

/** Python re의 \s는 White_Space에 U+001C~U+001F를 더한 집합이다. 부정 문자 집합 안에 넣을 때는 PYTHON_SPACE_CHARS를 쓴다. */
export const PYTHON_SPACE_CHARS = String.raw`\p{White_Space}\u001c-\u001f`;
export const PYTHON_SPACE = `[${PYTHON_SPACE_CHARS}]`;

const text = z.string();
const nonEmpty = z.string().min(1);
const PHONE = /^(?:\p{Nd}{2,4}-\p{Nd}{3,4}-\p{Nd}{4}|\p{Nd}{4}-\p{Nd}{4})?$/u;

/** 스냅샷 파일의 키(snake_case)를 그대로 쓴다. 파일을 읽고 쓰는 경계의 모양이다. */
export const PlaceSchema = z.strictObject({
  name: nonEmpty,
  address: nonEmpty,
  province: nonEmpty,
  districts: z.array(text),
  dong: text.default(""),
  legal_dong: text.default(""),
  phone: z.string().regex(PHONE).default(""),
  reference_date: isoDate.nullable().default(null),
});
export type Place = z.infer<typeof PlaceSchema>;

export const ProgramSchema = z.strictObject({
  organization: nonEmpty,
  name: nonEmpty,
  start: isoDate,
  end: isoDate,
  purpose: text,
  target: text,
  benefit: text,
  apply: text,
  documents: text,
  life_stages: z.array(text),
  targets: z.array(text),
  themes: z.array(text),
});
export type Program = z.infer<typeof ProgramSchema>;

export const RelatedSiteSchema = z.strictObject({ name: text.default(""), url: nonEmpty });
export type RelatedSite = z.infer<typeof RelatedSiteSchema>;

export const ServiceLinkSchema = z.strictObject({
  serv_id: nonEmpty,
  name: nonEmpty,
  detail_url: nonEmpty,
  summary: text.default(""),
  sites: z.array(RelatedSiteSchema).default([]),
  contact: text.default(""),
  ministry: text.default(""),
  department: text.default(""),
  criteria_year: text.default(""),
  last_modified: text.default(""),
});
export type ServiceLink = z.infer<typeof ServiceLinkSchema>;

export type DatasetId = "15116392" | "15083323" | PlaceKind;

export type DatasetCitation = { title: string; url: string; lastCheckedAt: string; version: string; note: string };

export class Dataset<Id extends DatasetId, Row> {
  readonly id: Id;
  readonly title: string;
  readonly headers: readonly string[];
  readonly floor: number;
  readonly schema: z.ZodType<Row>;

  constructor(id: Id, title: string, headers: readonly string[], floor: number, schema: z.ZodType<Row>) {
    this.id = id;
    this.title = title;
    this.headers = headers;
    this.floor = floor;
    this.schema = schema;
    Object.freeze(this);
  }

  /** ref는 YYYY-MM-DD. 교통약자 이동지원센터만 표준데이터 주소를 쓴다. */
  citation(ref: string, note = ""): DatasetCitation {
    const page = this.id === PLACE_KINDS.MOBILITY ? "standard" : "fileData";
    return { title: this.title, url: `https://www.data.go.kr/data/${this.id}/${page}.do`, lastCheckedAt: ref, version: `${ref} 기준`, note };
  }
}

const words = (headers: string) => headers.split(" ");

export const PROGRAMS = new Dataset("15116392", "한국사회보장정보원 민간복지서비스정보",
  words("기관명 사업명 사업시작일 사업종료일 사업목적 지원대상 지원내용 신청방법 제출서류 기타 생애주기 가구상황 관심주제"), 160, ProgramSchema);
export const LINKS = new Dataset("15083323", "한국사회보장정보원 복지서비스정보",
  words("서비스아이디 서비스명 서비스URL 서비스요약 사이트 대표문의 소관부처명 소관조직명 기준연도 최종수정일"), 200, ServiceLinkSchema);
export const DONG_OFFICES = new Dataset(PLACE_KINDS.DONG_OFFICE, "행정안전부 읍면동 하부행정기관 현황",
  words("연번 시도 시군구 읍면동 우편번호 주소"), 1700, PlaceSchema);
export const PENSION_OFFICES = new Dataset(PLACE_KINDS.PENSION, "국민연금공단 지사 및 상담센터 현황",
  words("순번 지사(센터)명 우편번호 주소 전화번호 FAX"), 70, PlaceSchema);
export const MOBILITY_CENTERS = new Dataset(PLACE_KINDS.MOBILITY, "전국교통약자이동지원센터정보표준데이터", words([
  "교통약자이동지원센터명 소재지도로명주소 소재지지번주소 위도 경도 보유차량대수 보유차량종류 슬로프형휠체어차량대수 리프트형휠체어차량대수",
  "예약접수전화번호 예약접수인터넷주소 앱서비스명 평일예약접수운영시작시각 평일예약접수운영종료시각 주말예약접수운영시작시각 주말예약접수운영종료시각",
  "차량평일운행시작시각 차량평일운행종료시각 차량주말운행시작시각 차량주말운행종료시각 사전예약신청기간 차량이용제한사항 차량관내운행지역 차량관외운행지역",
  "차량이용대상 차량이용요금 관리기관명 관리기관전화번호 데이터기준일자 제공기관코드 제공기관명",
].join(" ")), 80, PlaceSchema);

export type AnyDataset = typeof PROGRAMS | typeof LINKS | typeof DONG_OFFICES | typeof PENSION_OFFICES | typeof MOBILITY_CENTERS;

/** 읽는 순서가 정해져 있다(민간 사업, 중앙 링크, 읍면동, 국민연금, 교통약자). id가 숫자 모양이라 Map에 둔다. */
export const DATASETS: ReadonlyMap<DatasetId, AnyDataset> = new Map(
  [PROGRAMS, LINKS, DONG_OFFICES, PENSION_OFFICES, MOBILITY_CENTERS].map((spec): [DatasetId, AnyDataset] => [spec.id, spec]),
);

export const PLACE_DATASETS: ReadonlyMap<PlaceKind, Dataset<PlaceKind, Place>> = new Map(
  [DONG_OFFICES, PENSION_OFFICES, MOBILITY_CENTERS].map((spec): [PlaceKind, Dataset<PlaceKind, Place>] => [spec.id, spec]),
);

/** 앱이 함께 넣은 스냅샷 폴더. 설치본에서도 소스와 같은 상대 위치에 있다. */
export const BUNDLED = join(ASSET_ROOT, "agents/welfare/open_data/snapshots");

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Python의 json.dumps([ref, records], ensure_ascii=False, sort_keys=True, separators=(",", ":"))를 sha256으로. */
export function digest(records: readonly unknown[], referenceDate: string): string {
  return createHash("sha256").update(canonicalJson([referenceDate, records]), "utf8").digest("hex");
}

/** /api/health가 그대로 내보내는 모양이라 키는 Python의 dataclass 필드 이름이다. */
export interface DatasetStatus {
  readonly dataset_id: string;
  readonly reference_date: string | null;
  readonly row_count: number;
  readonly error: string | null;
}

export function datasetStatus(datasetId: string, { referenceDate = null, rowCount = 0, error = null }: {
  referenceDate?: string | null; rowCount?: number; error?: string | null;
} = {}): DatasetStatus {
  return { dataset_id: datasetId, reference_date: referenceDate, row_count: rowCount, error };
}

const SnapshotSchema = z.object({
  meta: z.looseObject({
    dataset: z.string(), schemaVersion: z.number(), rowCount: z.number(), referenceDate: z.string(), sha256: z.string(),
  }),
  records: z.array(z.unknown()).min(1),
});

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function loadOne<Row>(folder: string, spec: Dataset<DatasetId, Row>): readonly [DatasetStatus, readonly Row[]] {
  let raw: Buffer;
  try {
    raw = readFileSync(join(folder, `${spec.id}.json`));
  } catch (error) {
    const missing = error instanceof Error && Reflect.get(error, "code") === "ENOENT";
    return [datasetStatus(spec.id, { error: missing ? "missing" : "invalid" }), []];
  }
  try {
    const { meta, records } = SnapshotSchema.parse(JSON.parse(UTF8.decode(raw)));
    const ref = fromIsoDate(meta.referenceDate);
    if (meta.dataset !== spec.id || meta.schemaVersion !== 1 || meta.rowCount !== records.length || meta.sha256 !== digest(records, ref))
      throw new RangeError("metadata");
    const rows = records.map(row => spec.schema.parse(row));
    return [datasetStatus(spec.id, { referenceDate: ref, rowCount: records.length }), rows];
  } catch {
    return [datasetStatus(spec.id, { error: "invalid" }), []];
  }
}
