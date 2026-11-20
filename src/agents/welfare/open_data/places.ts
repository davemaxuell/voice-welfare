/** 이름과 행정구역으로만 찾고, 두 곳 이상이면 지역이나 기관 이름을 다시 묻는다. */
import { KINDS, PLACE_KINDS, PlaceAsk, placeKind, type PlaceKind, type PlaceKindSpec } from "../../../core/places.ts";
import { dongForms, parseRegionMention, RegionMention } from "../../../core/region.ts";
import { asciiDecimalDigits, splitWhitespace, strip, stripChars } from "../../../core/text.ts";
import type { Lang, SemanticAction } from "../../../core/turn.ts";
import { josa } from "../../../speech/phrasing.ts";
import { BUNDLED, compareCodePoints, DONG_OFFICES, loadOne, PLACE_DATASETS, PYTHON_SPACE, type Dataset, type DatasetCitation, type Place } from "./datasets.ts";

export const placesPatterns = {
  sentenceEnd: /[.!?。]+/gu,
  nearby: new RegExp(`우리${PYTHON_SPACE}*동네|가까운|근처`, "u"),
  unknown: new RegExp(`^(?:모름|몰라(?:요)?|모르겠(?:어|어요)|잘${PYTHON_SPACE}*모르겠어요|건너뛰기)$`, "u"),
  choice: new RegExp(`^(\\p{Nd}+)${PYTHON_SPACE}*번(?:이요|요)?$`, "u"),
};

const DIGIT_WORDS = new Map(Array.from("0123456789-").map((digit, index): [string, string] => [digit, Array.from("공일이삼사오육칠팔구,")[index] ?? ""]));

type Home = readonly [province: string, area: string];

let districts: ReadonlyMap<string, readonly Home[]> | undefined;

/** 함께 넣은 행정안전부 읍면동 자료의 시·군·구 이름 → (시·도, 속한 시·군·구). 일반구는 그 시에 속한다(분당구 → 성남시). */
export function officialDistricts(): ReadonlyMap<string, readonly Home[]> {
  if (districts !== undefined) return districts;
  const [, places] = loadOne(BUNDLED, DONG_OFFICES);
  const homes = new Map<string, Map<string, Home>>();
  for (const place of places) {
    const [area] = place.districts;
    if (area === undefined) continue;
    for (const name of place.districts) {
      const found = homes.get(name) ?? new Map<string, Home>();
      found.set(`${place.province}\u0000${area}`, [place.province, area]);
      homes.set(name, found);
    }
  }
  const byHome = (a: Home, b: Home) => {
    const province = compareCodePoints(a[0], b[0]);
    return province !== 0 ? province : compareCodePoints(a[1], b[1]);
  };
  districts = new Map([...homes].map(([name, found]): [string, readonly Home[]] => [name, [...found.values()].sort(byHome)]));
  return districts;
}

export class PlaceReply {
  readonly speech: string;
  readonly semantic: SemanticAction;
  readonly sources: readonly DatasetCitation[];
  readonly ask: PlaceAsk | undefined;
  readonly reviewQuotes: readonly string[];

  constructor(speech: string, semantic: SemanticAction = "find-place", { sources = [], ask, reviewQuotes = [] }: {
    sources?: readonly DatasetCitation[]; ask?: PlaceAsk; reviewQuotes?: readonly string[];
  } = {}) {
    this.speech = speech;
    this.semantic = semantic;
    this.sources = sources;
    this.ask = ask;
    this.reviewQuotes = reviewQuotes;
    Object.freeze(this);
  }
}

const spoken = (text: string) => splitWhitespace(text.replace(placesPatterns.sentenceEnd, " ")).join(" ");

function specOf(kind: PlaceKind): PlaceKindSpec {
  const spec = KINDS.get(kind);
  if (spec === undefined) throw new Error(`알 수 없는 기관 종류: ${kind}`);
  return spec;
}

function datasetOf(kind: PlaceKind): Dataset<PlaceKind, Place> {
  const spec = PLACE_DATASETS.get(kind);
  if (spec === undefined) throw new Error(`알 수 없는 기관 종류: ${kind}`);
  return spec;
}

function spokenPhone(phone: string): string {
  return Array.from(phone, character => DIGIT_WORDS.get(character) ?? character).join("").replaceAll(",", ", ");
}

const QUESTIONS = { province: "어느 시·도인가요?", district: "어느 시·군·구인가요?", dong: "어느 읍·면·동인가요?", office: "어느 기관인가요?" } as const;

export class PlaceFinder {
  readonly rows: ReadonlyMap<PlaceKind, readonly Place[]>;
  /** 종류별 자료 기준일(YYYY-MM-DD) */
  readonly dates: ReadonlyMap<PlaceKind, string>;

  constructor(rows: ReadonlyMap<PlaceKind, readonly Place[]>, dates: ReadonlyMap<PlaceKind, string>) {
    this.rows = rows;
    this.dates = dates;
  }

  answer(text: string, hint?: string, { lang = "ko" }: { lang?: Lang } = {}): PlaceReply {
    const kind = placeKind(text);
    if (kind === undefined) return new PlaceReply("주민센터, 국민연금 지사, 교통약자 이동지원센터 중 어느 곳인가요?", "clarify");
    const spec = specOf(kind);
    const rows = this.rows.get(kind);
    if (rows === undefined) return new PlaceReply(`${spec.label} 자료를 아직 내려받지 못해서 확인하지 못했어요.`);
    // '콜택시'는 '시'로 끝난다. '삼산면사무소'의 읍·면은 지켜야 한다.
    const regionText = kind === PLACE_KINDS.MOBILITY ? text.replace(spec.pattern, " ") : text.replaceAll("사무소", " ");
    let region = parseRegionMention(regionText);
    if (!region.present && hint !== undefined && hint.length > 0 && placesPatterns.nearby.test(text)) region = new RegionMention(hint);
    let named = "";
    if (kind !== PLACE_KINDS.DONG_OFFICE) {
      const compact = splitWhitespace(text).join("");
      const names = new Set(rows.filter(row => compact.includes(splitWhitespace(row.name).join(""))).map(row => row.name));
      const [only] = names;
      if (names.size === 1 && only !== undefined) named = only;
    }
    return this.reply(kind, region, lang, named);
  }

  followUp(ask: PlaceAsk, text: string, { lang = "ko" }: { lang?: Lang } = {}): PlaceReply | undefined {
    let bare = strip(stripChars(strip(text), ".?!"));
    if (placesPatterns.unknown.test(bare)) return new PlaceReply("지역을 확인하기 어려워 어느 곳인지 정하지 못했어요.");
    const choice = placesPatterns.choice.exec(bare);
    if (choice !== null) {
      const number = Number(asciiDecimalDigits(choice[1] ?? ""));
      const picked = ask.options[number - 1];
      if (!(number >= 1 && number <= ask.options.length) || picked === undefined) return undefined;
      bare = picked;
    }
    if (ask.field === "office" && ask.options.includes(bare)) return this.reply(ask.kind, ask.region, lang, bare);
    const next = parseRegionMention(bare, { bare: true });
    if (!next.present) return undefined;
    const region = new RegionMention(
      next.province.length > 0 ? next.province : ask.region.province,
      [...new Set([...ask.region.districts, ...next.districts])],
      next.dong.length > 0 ? next.dong : ask.region.dong,
    );
    return this.reply(ask.kind, region, lang);
  }

  private reply(kind: PlaceKind, region: RegionMention, lang: Lang, named = ""): PlaceReply {
    if (!region.present && named.length === 0) return new PlaceReply("어느 시·군·구의 어느 동인지 말씀해 주세요.", "clarify", { ask: new PlaceAsk(kind, region) });
    const rows = this.rows.get(kind);
    if (rows === undefined) throw new Error(`자료를 읽지 않은 기관 종류: ${kind}`);
    let places = rows.filter(place => (named.length === 0 || named === place.name)
      && (region.province.length === 0 || region.province === place.province)
      && region.districts.every(part => place.districts.includes(part)));
    if (region.dong.length > 0) {
      const exact = places.filter(place => region.dong === place.dong || region.dong === place.legal_dong);
      places = exact.length > 0 ? exact : places.filter(place => dongForms(place.dong).has(region.dong));
    }
    const label = specOf(kind).label;
    const [first] = places;
    if (first === undefined) return new PlaceReply(`말씀하신 지역과 일치하는 ${label}를 이 자료에서 찾지 못했어요.`);
    if (places.length === 1) return this.found(kind, first, lang);

    const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compareCodePoints);
    const levels = [
      ["province", sorted(places.map(place => place.province))],
      ["district", sorted(places.flatMap(place => place.districts).filter(name => !region.districts.includes(name)))],
      ["dong", sorted(places.map(place => place.dong).filter(name => name.length > 0))],
      ["office", sorted(places.map(place => place.name))],
    ] as const;
    const level = levels.find(([, options]) => options.length > 1);
    if (level === undefined) return new PlaceReply("같은 이름과 지역으로 등록된 기관이 여러 곳이라 한 곳을 정하지 못했어요.");
    const [field, options] = level;
    const question = QUESTIONS[field];
    // 너무 많은 후보는 번호를 붙이지 않는다. 듣지 못한 후보 번호가 선택되지 않게 한다.
    const choices = options.length <= 5 ? options : [];
    const where = [region.province, ...region.districts, region.dong].filter(value => value.length > 0).join(" ");
    const scope = where.length > 0 ? `${where}에서 ` : "";
    const speech = choices.length > 0
      ? `${scope}${choices.map((item, index) => `${index + 1}번 ${spoken(item)}`).join(", ")} 중 ${question}`
      : `${scope}${places.length}곳을 찾았어요. ${question}`;
    return new PlaceReply(speech, "clarify", { ask: new PlaceAsk(kind, region, choices, field) });
  }

  private found(kind: PlaceKind, place: Place, lang: Lang): PlaceReply {
    const ref = place.reference_date ?? this.dates.get(kind);
    if (ref === undefined) throw new Error(`자료 기준일이 없는 기관 종류: ${kind}`);
    const spec = datasetOf(kind);
    const name = kind === PLACE_KINDS.PENSION ? `국민연금공단 ${place.name}` : place.name;
    const head = `${josa(spoken(name), "은", "는")} ${spoken(place.address)}에 있어요.`;
    const phone = place.phone.length > 0
      ? `${kind === PLACE_KINDS.MOBILITY ? "예약 전화번호" : "전화번호"}는 ${lang === "ko" ? spokenPhone(place.phone) : place.phone}예요`
      : "이 자료에는 전화번호가 없어요";
    const [year = "", month = "", day = ""] = ref.split("-").map(part => String(Number(part)));
    return new PlaceReply(`${head} ${phone} (출처: ${spec.title}, ${year}년 ${month}월 ${day}일 기준).`, "find-place", {
      sources: [spec.citation(ref, place.phone)],
      reviewQuotes: [name, place.address, place.phone].filter(quote => quote.length > 0),
    });
  }
}
