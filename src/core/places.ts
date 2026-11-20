import { RegionMention } from "./region.ts";

// 공식 기관 위치·전화번호 요청의 공통 어휘.
export const PLACE_KINDS = { DONG_OFFICE: "15059715", PENSION: "15010814", MOBILITY: "15028207" } as const;
export type PlaceKind = (typeof PLACE_KINDS)[keyof typeof PLACE_KINDS];

// Python re의 \s는 White_Space에 U+001C~U+001F를 더한 집합이고, .은 줄바꿈(\n)만 빼고 모두 받는다.
const S = String.raw`[\p{White_Space}\u001c-\u001f]`;
const ANY = String.raw`[^\n]`;

export const placePatterns = {
  dongOffice: new RegExp(String.raw`주민${S}*센터|행정${S}*복지${S}*센터|동사무소|[읍면]${S}*사무소`, "gu"),
  pension: new RegExp(
    String.raw`국민${S}*연금(?:${S}*공단)?(?:${S}*[가-힣]+)?${S}*(?:지사|상담${S}*센터|지역${S}*본부)|국민${S}*연금${S}*공단`, "gu"),
  mobility: new RegExp(String.raw`장애인${S}*콜${S}*택시|교통약자${S}*이동${S}*지원${S}*센터|이동${S}*지원${S}*센터`, "gu"),
  cue: new RegExp(String.raw`어디|주소|위치|전화|문의|연락|예약|찾아|가까운|가는${S}*길`, "u"),
  screen: new RegExp(
    String.raw`누르|눌러|클릭|버튼|링크|이${S}*(?:화면|페이지)|(?:주소|이름|전화번호)${S}*(?:는|은)${S}*${ANY}+(?:넣|입력|저장)|^(?:내${S}*)?주소는${S}`, "u"),
  sourceQuestion: new RegExp(String.raw`어디서${S}*(?:본|봤|확인|찾은|나온|읽은)|주소지`, "gu"),
  nationalPension: new RegExp(String.raw`국민${S}*연금`, "gu"),
  otherBenefit: /[가-힣]{2,}(?:연금|수당|급여|바우처|지원금|지원사업)/u,
};

export interface PlaceKindSpec {
  readonly label: string;
  /** 전역 표지가 있다. 바꿀 때는 replace(전부 바꿈)로 쓰고, 찾을 때는 search로 쓴다(test는 lastIndex를 남긴다). */
  readonly pattern: RegExp;
}

// 키가 숫자 모양이라 객체로 두면 오름차순으로 돌아 순서가 바뀐다. place_kind는 이 순서로 찾으므로 Map에 둔다.
export const KINDS: ReadonlyMap<PlaceKind, PlaceKindSpec> = new Map<PlaceKind, PlaceKindSpec>([
  [PLACE_KINDS.DONG_OFFICE, { label: "행정복지센터", pattern: placePatterns.dongOffice }],
  [PLACE_KINDS.PENSION, { label: "국민연금 지사", pattern: placePatterns.pension }],
  [PLACE_KINDS.MOBILITY, { label: "교통약자 이동지원센터", pattern: placePatterns.mobility }],
]);

export function isPlaceKind(value: string): value is PlaceKind {
  return [...KINDS.keys()].some(kind => kind === value);
}

export function placeKind(text: string): PlaceKind | undefined {
  for (const [kind, { pattern }] of KINDS) {
    if (text.search(pattern) >= 0) return kind;
  }
  return undefined;
}

export function isPlaceRequest(text: string): boolean {
  // "어디서 본 정보인지"는 출처를 묻는 말, "내 주소지 주민센터에 가야 해?"의 '주소지'는 위치 단서가 아니다
  const cueText = text.replace(placePatterns.sourceQuestion, "");
  if (cueText.search(placePatterns.cue) < 0 || placeKind(text) === undefined || text.search(placePatterns.screen) >= 0) return false;
  return text.replace(placePatterns.nationalPension, "").search(placePatterns.otherBenefit) < 0;
}

export class PlaceAsk {
  readonly kind: PlaceKind;
  readonly region: RegionMention;
  readonly options: readonly string[];
  readonly field: string;

  constructor(kind: PlaceKind, region: RegionMention, options: readonly string[] = [], field = "region") {
    this.kind = kind;
    this.region = region;
    this.options = Object.freeze([...options]);
    this.field = field;
    Object.freeze(this);
  }
}
