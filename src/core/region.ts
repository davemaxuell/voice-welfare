import { splitWhitespace, stripChars } from "./text.ts";

// 시·도 별칭과 사용자가 말한 지역. '광주시'는 경기도의 시 이름으로 보존한다.
export const CTPV: Readonly<Record<string, string>> = {
  "서울": "서울특별시", "부산": "부산광역시", "대구": "대구광역시", "인천": "인천광역시",
  "광주": "광주광역시", "대전": "대전광역시", "울산": "울산광역시", "세종": "세종특별자치시",
  "경기": "경기도", "강원": "강원특별자치도", "강원도": "강원특별자치도",
  "충북": "충청북도", "충청북": "충청북도", "충남": "충청남도", "충청남": "충청남도",
  "전북": "전북특별자치도", "전라북": "전북특별자치도", "전라북도": "전북특별자치도",
  "전남": "전라남도", "전라남": "전라남도", "경북": "경상북도", "경상북": "경상북도",
  "경남": "경상남도", "경상남": "경상남도", "제주": "제주특별자치도",
  "전남광주통합특별시": "전남광주통합특별시",
};

const PROVINCES = new Map<string, string>([
  ...Object.entries(CTPV),
  ...Object.values(CTPV).map((name): [string, string] => [name, name]),
  ...["서울", "부산", "대구", "인천", "대전", "울산", "세종"].map((short): [string, string] => [short + "시", CTPV[short] ?? ""]),
  ["제주도", CTPV["제주"] ?? ""],
]);
const NUMBERS = new Map(Array.from("일이삼사오육칠팔구").map((spoken, index): [string, string] => [spoken, String(index + 1)]));
const PUNCTUATION = ".,!?…。:;";
const NOT_AREAS = new Set(["누구", "어디가", "동네", "있는가", "이동", "지금가", "혹시", "혹시나", "어느", "어디로"]);
// Python re의 \d는 유니코드 십진 숫자라 \p{Nd}로 옮겼고, .은 줄바꿈(\n)만 빼고 모두 받아서 [^\n]으로 옮겼다.
export const regionPatterns = {
  particle: /(?:입니다|이에요|예요|에요|이요|이야|이고|인데|에서요?|에는|으로|에|의|은|는|요)$/u,
  area: /^[가-힣\p{Nd}·.ㆍ,]+(?:시|군|구|읍|면|동|가)$/u,
  dongNumber: /^([^\n]+?)제?(\p{Nd}+)동$/u,
};

export class RegionMention {
  readonly province: string;
  readonly districts: readonly string[];
  readonly dong: string;

  constructor(province = "", districts: readonly string[] = [], dong = "") {
    this.province = province;
    this.districts = Object.freeze([...districts]);
    this.dong = dong;
    Object.freeze(this);
  }

  /** Python의 bool(RegionMention): 시·도, 시·군·구, 동 가운데 하나라도 있으면 참이다. */
  get present(): boolean {
    return this.province.length > 0 || this.districts.length > 0 || this.dong.length > 0;
  }
}

export function provinceName(name: string): string {
  return PROVINCES.get(name) ?? "";
}

function stem(raw: string): string {
  return stripChars(raw, PUNCTUATION).replace(regionPatterns.particle, "");
}

export function parseRegionMention(text: string, { bare = false }: { bare?: boolean } = {}): RegionMention {
  let province = "", dong = "";
  const districts: string[] = [];
  for (const raw of splitWhitespace(text)) {
    const token = stem(raw);
    const canonical = provinceName(token);
    if (canonical.length > 0) {
      province = canonical;
    } else if (regionPatterns.area.test(token) && !NOT_AREAS.has(token) && !token.endsWith("하면") && !token.endsWith("려면")) {
      if (token.endsWith("시") || token.endsWith("군") || token.endsWith("구")) districts.push(token);
      else dong = token;
    } else if (bare) {
      return new RegionMention();
    }
  }
  return new RegionMention(province, districts, dong);
}

/** '부산 사상구'처럼 시·도 바로 뒤에 말한 시·군·구. '1인 가구'의 '가구'처럼 홀로 나온 말은 사는 곳으로 보지 않는다. */
export function districtAfterProvince(text: string): string {
  const tokens = splitWhitespace(text).map(stem);
  for (let index = 1; index < tokens.length; index++) {
    const before = tokens[index - 1] ?? "", token = tokens[index] ?? "";
    if (provinceName(before).length > 0 && regionPatterns.area.test(token) &&
        (token.endsWith("시") || token.endsWith("군") || token.endsWith("구"))) return token;
  }
  return "";
}

/** 정식 표기 우선. '삼성일동'은 정식 이름이 없을 때만 삼성1동 후보로 쓴다. */
export function dongForms(name: string): Set<string> {
  const forms = new Set([name]);
  const match = regionPatterns.dongNumber.exec(name);
  if (match !== null) {
    const base = match[1] ?? "", digits = match[2] ?? "";
    forms.add(`${base}${digits}동`).add(`${base}제${digits}동`);
    const spoken = [...NUMBERS].find(([, value]) => value === digits)?.[0];
    if (spoken !== undefined) forms.add(`${base}${spoken}동`).add(`${base}제${spoken}동`);
  }
  return forms;
}
