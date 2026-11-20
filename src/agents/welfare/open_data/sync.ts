/** 공식 CSV를 검증하고 스냅샷 한 개씩 교체한다. 서버에서는 가져오지 않는다. */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PLACE_KINDS, type PlaceKind } from "../../../core/places.ts";
import { CTPV, provinceName } from "../../../core/region.ts";
import { casefold, rstripChars, splitWhitespace, strip, stripChars } from "../../../core/text.ts";
import { tryUrl } from "../../../core/url.ts";
import { urlCredentials } from "../urlsplit.ts";
import {
  BUNDLED, DATASETS, digest, fromIsoDate, loadOne, PlaceSchema, ProgramSchema, PYTHON_SPACE, PYTHON_SPACE_CHARS, ServiceLinkSchema,
  type AnyDataset, type Dataset, type DatasetId, type DatasetStatus, type RelatedSite,
} from "./datasets.ts";

// Python re.I는 'i'에 점 있는 İ와 점 없는 ı도 맞춘다. JS의 iu는 K(켈빈 기호)와 ſ는 같게 보지만 이 둘은 따로 적어야 한다.
const LATIN = "a-zA-Z0-9İı";

export const syncPatterns = {
  siteUrl: new RegExp(
    `(https?[:;]//[^${PYTHON_SPACE_CHARS},]+|`
    + `(?<![${LATIN}./-])(?:www\\.[${LATIN}가-힣-]+|(?:[${LATIN}-]+\\.)*[${LATIN}-]+)`
    + "\\.(?:go\\.kr|or\\.kr|re\\.kr|ac\\.kr|pe\\.kr|ne\\.kr|co\\.kr|hs\\.kr|ms\\.kr|es\\.kr|kg\\.kr|sc\\.kr|kr|com|net|org|[iİı]o)"
    + `(?::\\p{Nd}+)?(?:/[^${PYTHON_SPACE_CHARS},]*)?)`,
    "giu",
  ),
  email: /[\p{L}\p{N}_.+-]+@[\p{L}\p{N}_.-]+\.[a-zA-Z]{2,}/gu,
  mobile: new RegExp(`(?<!\\p{Nd})01[016789][-${PYTHON_SPACE_CHARS}]?\\p{Nd}{3,4}[-${PYTHON_SPACE_CHARS}]?\\p{Nd}{4}(?!\\p{Nd})`, "gu"),
  tagSeparator: new RegExp(`${PYTHON_SPACE}*·${PYTHON_SPACE}*`, "gu"),
  staffNotice: new RegExp(`담당자${PYTHON_SPACE}*안내`, "u"),
  dongSuffix: new RegExp(`${PYTHON_SPACE}*(?:주민센터|행정복지센터|사무소)`, "u"),
  centerDong: /센터\(([가-힣]+(?:읍|면|동))\)(?=\n?$)/u,
  legalDong: /\(([가-힣\p{Nd}·.]+(?:동|가))[,)]/u,
  addressParts: new RegExp(`[${PYTHON_SPACE_CHARS}?,]+`, "u"),
  releaseDate: /_(\p{Nd}{8})\.csv(?=\n?$)/iu,
};

const length = (text: string) => Array.from(text).length;

export class CsvError extends Error {}

/** CSV를 읽다 막히거나 한 자료를 쓰지 못할 때 모두 이 계열이다(Python의 OSError·ValueError·csv.Error). */
export function isExpectedFailure(error: unknown): error is Error {
  return error instanceof RangeError || error instanceof CsvError || error instanceof z.ZodError
    || (error instanceof Error && typeof Reflect.get(error, "code") === "string");
}

export function cleanPublicUrl(raw: string): string | undefined {
  let url = rstripChars(strip(raw), ".,);");
  if (url.length === 0) return undefined;
  const lower = url.toLowerCase();
  if (lower.startsWith("http;//") || lower.startsWith("https;//")) url = url.replace(";//", "://");
  else if (!lower.startsWith("http://") && !lower.startsWith("https://")) url = `https://${url}`;
  const credentials = urlCredentials(url);
  const parsed = tryUrl(url);
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname.length === 0
    || !parsed.hostname.includes(".") || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
    || (credentials.username ?? "").length > 0 || (credentials.password ?? "").length > 0) return undefined;
  return parsed.href;
}

export function cleanBokjiroDetailUrl(raw: string, servId: string): string {
  const parsed = tryUrl(strip(raw));
  if (parsed === undefined || !["https://www.bokjiro.go.kr", "https://bokjiro.go.kr"].includes(parsed.origin)
    || servId.length === 0 || parsed.param("wlfareInfoId") !== servId) throw new RangeError(`유효하지 않은 복지로 상세 주소: ${raw}`);
  return parsed.href;
}

const withoutContacts = (text: string) => text.replace(syncPatterns.email, "").replace(syncPatterns.mobile, "");
const maskedContacts = (text: string) => text.replace(syncPatterns.email, "기관 공고의 이메일").replace(syncPatterns.mobile, "기관 공고의 연락처");

export function parseRelatedSites(raw: string): RelatedSite[] {
  const text = strip(raw);
  if (text.length === 0) return [];
  const sites: RelatedSite[] = [];
  const seen = new Map<string, number>();
  let position = 0;
  for (const match of text.matchAll(syncPatterns.siteUrl)) {
    const label = strip(withoutContacts(stripChars(text.slice(position, match.index), " ,·ㆍ/-")));
    position = match.index + match[0].length;
    const cleaned = cleanPublicUrl(match[0]);
    if (cleaned === undefined || cleaned.length === 0) continue;
    const key = rstripChars(casefold(cleaned), "/");
    const index = seen.get(key);
    if (index !== undefined) {
      if (label.length > 0 && sites[index]?.name === "") sites[index] = { name: label, url: cleaned };
      continue;
    }
    seen.set(key, sites.length);
    sites.push({ name: label, url: cleaned });
  }
  return sites;
}

type Csv = Readonly<Record<string, string>>;

function column(record: Csv, name: string): string {
  const value = record[name];
  if (value === undefined) throw new RangeError(`CSV에 '${name}' 칸이 없습니다`);
  return value;
}

function tags(value: string): string[] {
  return value.split(",").filter(tag => strip(tag).length > 0).map(tag => strip(tag).replace(syncPatterns.tagSeparator, "·"));
}

function prose(value: string): string {
  const notice = syncPatterns.staffNotice.exec(value);
  // 게시된 신청방법에 덧붙은 직원별 연락처 안내는 앱의 사업 자료에 싣지 않는다.
  return maskedContacts(rstripChars(notice === null ? value : value.slice(0, notice.index), " ·ㆍ"));
}

function programRow(record: Csv) {
  const at = (name: string) => column(record, name);
  return ProgramSchema.parse({
    organization: at("기관명"), name: at("사업명"), start: at("사업시작일"), end: at("사업종료일"), purpose: prose(at("사업목적")),
    target: prose(at("지원대상")), benefit: prose(at("지원내용")), apply: prose(at("신청방법")), documents: prose(at("제출서류")),
    life_stages: tags(at("생애주기")), targets: tags(at("가구상황")), themes: tags(at("관심주제")),
  });
}

function linkRow(record: Csv) {
  const at = (name: string) => column(record, name);
  const servId = strip(at("서비스아이디"));
  const detailUrl = cleanBokjiroDetailUrl(at("서비스URL"), servId);
  return ServiceLinkSchema.parse({
    serv_id: servId, name: strip(at("서비스명")), detail_url: detailUrl, summary: strip(maskedContacts(at("서비스요약"))),
    sites: parseRelatedSites(at("사이트")), contact: strip(maskedContacts(at("대표문의"))), ministry: strip(at("소관부처명")),
    department: strip(at("소관조직명")), criteria_year: strip(at("기준연도")), last_modified: strip(at("최종수정일")),
  });
}

const PROVINCE_NAMES = [...new Set([...Object.values(CTPV), "전라북도", "강원도"])].sort((a, b) => length(b) - length(a));

function placeRow(record: Csv, kind: PlaceKind) {
  const at = (name: string) => column(record, name);
  if (kind === PLACE_KINDS.DONG_OFFICE) {
    const name = at("읍면동"), address = at("주소");
    const suffix = syncPatterns.dongSuffix.exec(name);
    const centered = syncPatterns.centerDong.exec(name);
    const legal = syncPatterns.legalDong.exec(address);
    return PlaceSchema.parse({
      name, address, province: provinceName(at("시도")), districts: splitWhitespace(at("시군구")),
      dong: centered?.[1] ?? strip(suffix === null ? name : name.slice(0, suffix.index)), legal_dong: legal?.[1] ?? "",
    });
  }
  const pension = kind === PLACE_KINDS.PENSION;
  const name = pension ? at("지사(센터)명") : at("교통약자이동지원센터명");
  const phone = pension ? at("전화번호") : at("예약접수전화번호");
  const ref = pension ? null : at("데이터기준일자");
  const address = pension ? at("주소") : at("소재지도로명주소").length > 0 ? at("소재지도로명주소") : at("소재지지번주소");
  const province = PROVINCE_NAMES.find(candidate => address.startsWith(candidate)) ?? "";
  const districts: string[] = [];
  for (const part of strip(address.slice(province.length)).split(syncPatterns.addressParts)) {
    if (!["시", "군", "구"].some(suffix => part.endsWith(suffix))) break;
    districts.push(part);
  }
  return PlaceSchema.parse({ name, address, phone, province: provinceName(province), districts, reference_date: ref });
}

function rowOf(record: Csv, spec: AnyDataset): unknown {
  switch (spec.id) {
    case "15116392": return programRow(record);
    case "15083323": return linkRow(record);
    case PLACE_KINDS.DONG_OFFICE:
    case PLACE_KINDS.PENSION:
    case PLACE_KINDS.MOBILITY: return placeRow(record, spec.id);
    default: {
      const unreachable: never = spec;
      throw new RangeError(`알 수 없는 자료: ${JSON.stringify(unreachable)}`);
    }
  }
}

const FIELD_LIMIT = 131072;
const LINE = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+/gu;
type CsvState = "record" | "field" | "unquoted" | "quoted" | "quote-in-quoted" | "end-of-line";

/** Python csv 모듈(excel 방언, strict)의 글자 단위 상태 기계. 줄 끝은 feed(undefined)로 알린다. */
class CsvParser {
  private state: CsvState = "record";
  private field = "";
  private size = 0;
  private fields: string[] = [];

  /** 한 줄을 다 먹고 행이 끝났으면 그 행을, 따옴표 안이라 이어지면 undefined를 돌려준다. */
  line(text: string): string[] | undefined {
    for (const character of text) this.feed(character);
    this.feed(undefined);
    if (this.state !== "record") return undefined;
    const row = this.fields;
    this.fields = [];
    return row;
  }

  finish(): void {
    if (this.size !== 0 || this.state === "quoted") throw new CsvError("unexpected end of data");
  }

  private save(): void {
    this.fields.push(this.field);
    this.field = "";
    this.size = 0;
  }

  private add(character: string): void {
    if (this.size >= FIELD_LIMIT) throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`);
    this.field += character;
    this.size++;
  }

  private feed(character: string | undefined): void {
    const end = character === undefined;
    const newline = character === "\n" || character === "\r";
    switch (this.state) {
      case "record":
        if (end) return;
        if (newline) {
          this.state = "end-of-line";
          return;
        }
        this.state = "field";
        this.feed(character);
        return;
      case "field":
        if (end || newline) {
          this.save();
          this.state = end ? "record" : "end-of-line";
        } else if (character === '"') {
          this.state = "quoted";
        } else if (character === ",") {
          this.save();
        } else {
          this.add(character);
          this.state = "unquoted";
        }
        return;
      case "unquoted":
        if (end || newline) {
          this.save();
          this.state = end ? "record" : "end-of-line";
        } else if (character === ",") {
          this.save();
          this.state = "field";
        } else {
          this.add(character);
        }
        return;
      case "quoted":
        if (end) return;
        if (character === '"') this.state = "quote-in-quoted";
        else this.add(character);
        return;
      case "quote-in-quoted":
        if (character === '"') {
          this.add(character);
          this.state = "quoted";
        } else if (character === ",") {
          this.save();
          this.state = "field";
        } else if (end || newline) {
          this.save();
          this.state = end ? "record" : "end-of-line";
        } else {
          throw new CsvError("',' expected after '\"'");
        }
        return;
      case "end-of-line":
        if (end) this.state = "record";
        else if (!newline) throw new CsvError("new-line character seen in unquoted field - do you need to open the file with newline=''?");
        return;
    }
  }
}

/** Python csv.reader(StringIO(text, newline=""), strict=True)처럼 한 행씩 읽는다. 빈 줄은 빈 행([])이 된다. */
export function* readCsv(text: string): Generator<string[], void, undefined> {
  const parser = new CsvParser();
  for (const line of text.match(LINE) ?? []) {
    const row = parser.line(line);
    if (row !== undefined) yield row;
  }
  parser.finish();
}

function decodeCsv(raw: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    try {
      return new TextDecoder("euc-kr", { fatal: true }).decode(raw);
    } catch (error) {
      throw new RangeError("CSV 글자 모양(UTF-8·CP949)을 읽을 수 없습니다", { cause: error });
    }
  }
}

function sameHeaders(found: readonly string[], expected: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const name of found) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const name of expected) counts.set(name, (counts.get(name) ?? 0) - 1);
  return [...counts.values()].every(count => count === 0);
}

const statusOf = (folder: string, spec: Dataset<DatasetId, unknown>): DatasetStatus => loadOne(folder, spec)[0];

/** CSV를 검증해 기존 스냅샷을 한 번에 바꾼다. 행이 모자라거나 오류가 많거나 기준일이 오래됐으면 기존 자료를 그대로 둔다. */
export function importCsv(path: string, spec: AnyDataset, ref: string, dest: string): number {
  const reader = readCsv(decodeCsv(readFileSync(path)));
  const headers = reader.next().value;
  if (headers === undefined || !sameHeaders(headers, spec.headers)) throw new RangeError(`${spec.id}: CSV 헤더가 바뀌었습니다`);
  const records: unknown[] = [];
  let errors = 0;
  for (const values of reader) {
    try {
      if (values.length !== headers.length) throw new RangeError("zip() argument 2 is shorter or longer than argument 1");
      records.push(rowOf(Object.fromEntries(headers.map((header, index) => [header, strip(values[index] ?? "")])), spec));
    } catch (error) {
      if (!(error instanceof RangeError || error instanceof z.ZodError)) throw error;
      errors++;
    }
  }
  const old = statusOf(dest, spec);
  const count = records.length;
  if (count < spec.floor || count <= old.row_count / 2 || errors > (count + errors) * 0.02)
    throw new RangeError(`${spec.id}: ${count}개 정상 행, ${errors}개 오류. 기존 자료를 보존합니다`);
  if (old.reference_date !== null && ref < old.reference_date) throw new RangeError(`${spec.id}: 기존 자료보다 오래된 기준일입니다`);
  const meta = `{"dataset": ${JSON.stringify(spec.id)}, "schemaVersion": 1, "rowCount": ${count}, "referenceDate": ${JSON.stringify(ref)}, "sha256": ${JSON.stringify(digest(records, ref))}}`;
  mkdirSync(dest, { recursive: true });
  const temporary = join(dest, `tmp${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, `{"meta":${meta},"records":[\n${records.map(record => JSON.stringify(record)).join(",\n")}\n]}\n`, "utf8");
    renameSync(temporary, join(dest, `${spec.id}.json`));
  } finally {
    rmSync(temporary, { force: true });
  }
  return count;
}

export type PortalFile = readonly [spec: AnyDataset, path: string, ref: string];
/** 공공데이터포털에서 최신 CSV를 받아 오는 단계. 시험에서는 이 자리에 가짜를 넣어 브라우저를 열지 않는다. */
export type PortalFiles = (folder: string) => AsyncIterable<PortalFile>;

const browserPortalFiles: PortalFiles = async function* (folder) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.on("dialog", dialog => { void dialog.accept(); });
    for (const spec of DATASETS.values()) {
      if (spec.id === PLACE_KINDS.MOBILITY) continue;
      await page.goto(`https://www.data.go.kr/data/${spec.id}/fileData.do`, { waitUntil: "domcontentloaded" });
      const button = page.locator('[onclick^="fileDetailObj.fn_fileDataDown"]').first();
      const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), button.click()]);
      const release = syncPatterns.releaseDate.exec(download.suggestedFilename());
      if (release === null) throw new RangeError(`${spec.id}: 파일의 기준일을 확인하고 --csv와 --reference-date를 지정하세요`);
      const path = join(folder, `${spec.id}.csv`);
      await download.saveAs(path);
      yield [spec, path, fromIsoDate(release[1] ?? "")];
    }
  } finally {
    await browser.close();
  }
};

class UsageError extends Error {}

const OPTIONS = ["--help", "--dir", "--csv", "--reference-date", "--check"] as const;
type Option = (typeof OPTIONS)[number];

interface Arguments {
  dir: string | undefined;
  csv: string[];
  referenceDate: string[];
  check: boolean;
  help: boolean;
}

function resolveOption(name: string): Option | undefined {
  const exact = OPTIONS.find(option => option === name);
  if (exact !== undefined) return exact;
  const matches = OPTIONS.filter(option => option.startsWith(name));
  if (matches.length > 1) throw new UsageError(`ambiguous option: ${name} could match ${matches.join(", ")}`);
  return matches[0];
}

function parseArguments(argv: readonly string[]): Arguments {
  const found: Arguments = { dir: undefined, csv: [], referenceDate: [], check: false, help: false };
  const extras: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const option = token === "-h" ? "--help" : token.startsWith("--") ? resolveOption(equals < 0 ? token : token.slice(0, equals)) : undefined;
    if (option === undefined) {
      extras.push(token);
      continue;
    }
    if (option === "--help" || option === "--check") {
      if (equals >= 0) throw new UsageError(`argument ${option}: ignored explicit argument '${token.slice(equals + 1)}'`);
      if (option === "--help") found.help = true;
      else found.check = true;
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : argv[index + 1];
    if (value === undefined || (equals < 0 && value.startsWith("-") && value.length > 1)) throw new UsageError(`argument ${option}: expected one argument`);
    if (equals < 0) index++;
    if (option === "--dir") found.dir = value;
    else if (option === "--csv") found.csv.push(value);
    else found.referenceDate.push(value);
  }
  if (extras.length > 0) throw new UsageError(`unrecognized arguments: ${extras.join(" ")}`);
  return found;
}

const USAGE = "usage: sync-datasets [-h] [--dir DIR] [--csv ID=FILE] [--reference-date ID=YYYY-MM-DD] [--check]";
const HELP = `${USAGE}\n\n공식 CSV를 검증하고 스냅샷 한 개씩 교체한다. 서버에서는 가져오지 않는다.\n\noptions:\n  -h, --help            show this help message and exit\n  --dir DIR\n  --csv ID=FILE\n  --reference-date ID=YYYY-MM-DD\n  --check\n`;

function mapping(values: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of values) {
    const at = pair.indexOf("=");
    const key = at < 0 ? pair : pair.slice(0, at);
    const value = at < 0 ? "" : pair.slice(at + 1);
    if (![...DATASETS.keys()].some(id => id === key) || at < 0 || value.length === 0 || out.has(key)) throw new UsageError(`잘못된 자료 지정: ${pair}`);
    out.set(key, value);
  }
  return out;
}

export interface SyncOptions {
  /** --dir를 주지 않았을 때 쓸 폴더. 기본은 앱에 함께 든 스냅샷 폴더다. */
  defaultDir?: string;
  portalFiles?: PortalFiles;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** --check가 '며칠 전'을 셀 오늘(YYYY-MM-DD). 기본은 이 컴퓨터의 오늘이다. */
  today?: () => string;
}

function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysBetween(from: string, to: string): number {
  const parse = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** 종료 코드를 돌려준다. 잘못된 인자는 2, 자료를 하나라도 못 바꾸거나 점검이 실패하면 1. */
export async function main(argv: readonly string[] = process.argv.slice(2), options: SyncOptions = {}): Promise<number> {
  const out = options.stdout ?? (text => { process.stdout.write(text); });
  const err = options.stderr ?? (text => { process.stderr.write(text); });
  let args: Arguments;
  let paths: Map<string, string>;
  let dates: Map<string, string>;
  try {
    args = parseArguments(argv);
    if (args.help) {
      out(HELP);
      return 0;
    }
    paths = mapping(args.csv);
    dates = mapping(args.referenceDate);
    if (paths.size !== dates.size || [...paths.keys()].some(key => !dates.has(key))) throw new UsageError("각 CSV에 --reference-date ID=YYYY-MM-DD가 필요합니다");
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`${USAGE}\nsync-datasets: error: ${error.message}\n`);
    return 2;
  }
  const dir = args.dir ?? options.defaultDir ?? BUNDLED;
  if (args.check) {
    let result = 0;
    for (const spec of DATASETS.values()) {
      const status = statusOf(dir, spec);
      const detail = status.error ?? `${status.row_count}행 ${status.reference_date} 기준 ${daysBetween(fromIsoDate(status.reference_date ?? ""), (options.today ?? localToday)())}일 전`;
      out(`${spec.id} ${detail}\n`);
      if (status.error !== null && (status.error !== "missing" || spec.id !== PLACE_KINDS.MOBILITY)) result = 1;
    }
    return result;
  }
  const temp = mkdtempSync(join(tmpdir(), "cheongeum-datasets-"));
  try {
    const given = async function* (): AsyncGenerator<PortalFile> {
      for (const [key, path] of paths) {
        const spec = [...DATASETS.values()].find(candidate => candidate.id === key);
        if (spec === undefined) throw new RangeError(`알 수 없는 자료: ${key}`);
        yield [spec, path, fromIsoDate(dates.get(key) ?? "")];
      }
    };
    const files = paths.size > 0 ? given() : (options.portalFiles ?? browserPortalFiles)(temp);
    let result = 0;
    for await (const [spec, path, ref] of files) {
      try {
        out(`${spec.id} ${ref} ${importCsv(path, spec, ref, dir)}행\n`);
      } catch (error) {
        if (!isExpectedFailure(error)) throw error;
        err(`${messageOf(error)}\n`);
        result = 1;
      }
    }
    return result;
  } catch (error) {
    err(`자료 내려받기 실패: ${messageOf(error)}\n`);
    return 1;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
