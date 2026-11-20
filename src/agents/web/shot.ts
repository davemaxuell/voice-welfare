// 웹 화면 사진의 판단(모두 순수 함수, 브라우저를 부르지 않는다): 찍어도 되는 화면인가, 무엇을 가리는가.
// - planShot: 찍기 전에 화면 관찰만 보고 정한다. 접속 차단·보안문자·로그인·본인인증·비밀번호 칸이 있는 화면은 찍지 않는다.
// - judgeMarks: 찍기 직전에 페이지가 표시해 준 글 조각(browser/blocks.ts)을 보고 가릴 조각을 정한다.
//   본문에 개인정보로 보이는 글이 있는데 그것을 담은 조각을 찾지 못하면 찍지 않는다(가리지 못하면 찍지 않는다).
// 개인정보 판정은 PolicyGuard와 같은 규칙(detectSensitive, 모델 없이)이라 같은 화면에는 늘 같은 답이 나온다.
// 가리는 것은 그 규칙이 알아보는 것뿐이다. 그림 속 글, 이름·주소처럼 규칙이 모르는 것은 여기서 가려지지 않는다.
import { strip } from "../../core/text.ts";
import { PICTURE_CONTACT, detectSensitive } from "../../safety/privacy.ts";
import { authPageKind } from "./auth_page.ts";
import { digestPage } from "./digest.ts";
import type { WebObservation } from "./view.ts";

export type ShotRefusalReason = "loading" | "too-large" | "changed" | "blocked" | "captcha" | "login" | "verification" | "password" | "unmaskable";

export const REFUSAL_SPEECH: Readonly<Record<ShotRefusalReason, string>> = {
  loading: "그림을 아직 불러오고 있어요. 잠시 뒤에 다시 촬영해 주세요.",
  "too-large": "페이지가 너무 크거나 계속 늘어나서 한 장으로 촬영할 수 없어요.",
  changed: "촬영하는 동안 화면이 바뀌어 사진을 보내지 않았어요. 다시 요청해 주세요.",
  blocked: "접속이 막힌 화면은 사진으로 찍지 않아요.",
  captcha: "보안문자가 있는 화면은 사진으로 찍지 않아요. 보안문자는 읽지도 풀지도 않아요.",
  login: "로그인 화면은 사진으로 찍지 않아요.",
  verification: "본인인증 화면은 사진으로 찍지 않아요.",
  password: "비밀번호 칸이 있는 화면은 사진으로 찍지 않아요.",
  unmaskable: "가려야 할 개인정보를 화면에서 다 찾지 못해서 사진을 찍지 않았어요.",
};

export class ShotRefusal {
  readonly reason: ShotRefusalReason;
  readonly speech: string;

  constructor(reason: ShotRefusalReason, speech: string) {
    this.reason = reason;
    this.speech = speech;
    Object.freeze(this);
  }
}

/** 찍을 때 검게 덮을 것(mask)과 아예 안 보이게 할 것(hide)의 CSS 선택자. */
export interface ShotPlan {
  readonly url: string;
  readonly mask: readonly string[];
  readonly hide: readonly string[];
}

// 입력 요소는 비어 있어도 덮는다(관찰과 촬영 사이에 사용자가 칠 수 있다). 다른 문서가 든 틀은 속을 볼 수 없으니 통째로.
export const MASK_SELECTORS = ["input", "textarea", "select", "[contenteditable]", "iframe", "embed", "object"] as const;
// 청음의 가상 커서. cursor.ts의 요소 이름이 바뀌어도 맞도록 접두어로 찾는다(물결은 id 없이 애니메이션 이름만 있다).
export const HIDE_SELECTORS = ['[id^="__cheongeum"]', '[style*="__cheongeum"]'] as const;

export const shotPatterns = {
  captchaWords: /(captcha|보안\p{White_Space}*문자|자동\p{White_Space}*입력\p{White_Space}*방지|자동\p{White_Space}*등록\p{White_Space}*방지|로봇이\p{White_Space}*아닙니다|are you a robot)/iu,
  captchaFrame: /(captcha|turnst[iİ]le)/iu,
};
// 이웃 조각과 맞닿았는지 볼 때 견주는 글자 수
const NEIGHBOR_CHARS = 8;
// Python regex의 \w. Node가 아직 모르는 새 유니코드 글자만 다르다.
const WORD = String.raw`[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`;
const SPACE = /[\p{White_Space}\u001c-\u001f]/u;

function refuse(reason: ShotRefusalReason): ShotRefusal {
  return new ShotRefusal(reason, REFUSAL_SPEECH[reason]);
}

/** 화면 관찰 하나로 정한다. 찍으면 안 되는 화면이면 까닭과 사용자에게 할 말을 돌려준다. */
export function planShot(view: WebObservation): ShotPlan | ShotRefusal {
  const fields = view.fields ?? [];
  const mainText = view.outline?.mainText ?? "";
  const labels = fields.map(field => field.label ?? "").join(" ");
  if (shotPatterns.captchaWords.test(`${view.title ?? ""}\n${mainText}\n${labels}`)) return refuse("captcha");
  if (digestPage(view).kind === "blocked") return refuse("blocked");
  const kind = authPageKind(view);
  if (kind !== "other") return refuse(kind);
  // 보이지 않는 비밀번호 칸(접힌 로그인 상자)도 찍는 사이에 펼쳐질 수 있다
  if (fields.some(field => field.type === "password")) return refuse("password");
  return { url: view.url ?? "", mask: MASK_SELECTORS, hide: HIDE_SELECTORS };
}

function secret(text: string): boolean {
  return text.search(PICTURE_CONTACT) >= 0 || detectSensitive(text).hasSecretValue;
}

/**
 * 이어진 글 조각 가운데 개인정보 값이 든 것의 번호. undefined는 끊긴 자리다.
 * 표나 목록은 이름('계좌번호')과 값이 서로 다른 조각에 있어, 혼자서는 값이 아니어도 바로 앞 조각과 붙여 값이 되면 값으로 본다.
 */
function secretEntries(texts: ReadonlyArray<string | undefined>): Set<number> {
  const hit = new Set<number>();
  let label: string | undefined;
  for (const [index, text] of texts.entries()) {
    if (text === undefined) {
      label = undefined;
    } else if (secret(text)) {
      hit.add(index);
      label = undefined;
    } else if (label !== undefined && secret(`${label}\n${text}`)) {
      hit.add(index);
      label = undefined;
    } else if (strip(text).length > 0) {
      label = text;
    }
  }
  return hit;
}

const nonSpace = (text: string) => Array.from(text).filter(character => !SPACE.test(character));

/** 띄어쓰기·줄바꿈이 달라도 맞는 식. */
function loose(characters: readonly string[]): string {
  return characters.map(character => character.replace(/[\^$\\.*+?()[\]{}|/]/u, "\\$&")).join(String.raw`\p{White_Space}*`);
}

/**
 * 본문에서 글 조각 하나를 찾는 식. before·after는 화면에서 바로 앞뒤에 있는 조각의 글이다.
 * 조각의 양 끝은 낱말 경계이거나 이웃 조각의 글과 맞닿아 있어야 한다(관찰한 본문은 조각 사이를 붙여 쓰기도 한다).
 * 낱말 중간에서도 끊으면 짧은 조각('3')이 다른 번호의 일부를 지워 그 번호를 못 알아보게 된다.
 */
export function piecePattern(piece: string, before: string, after: string): RegExp {
  const tail = nonSpace(before).slice(-NEIGHBOR_CHARS);
  const head = nonSpace(after).slice(0, NEIGHBOR_CHARS);
  const left = tail.length > 0 ? String.raw`(?:(?<!${WORD})|(?<=${loose(tail)}\p{White_Space}*))` : `(?<!${WORD})`;
  const right = head.length > 0 ? String.raw`(?:(?!${WORD})|(?=\p{White_Space}*${loose(head)}))` : `(?!${WORD})`;
  return new RegExp(left + loose(nonSpace(piece)) + right, "gu");
}

/** text에서 pattern이 맞은 자리를 끊어 낸다(끊긴 자리는 undefined). */
function cut(text: string, pattern: RegExp): Array<string | undefined> {
  const out: Array<string | undefined> = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    out.push(text.slice(at, match.index), undefined);
    at = match.index + match[0].length;
  }
  return [...out, text.slice(at)];
}

export interface MarkBlock { readonly id: string; readonly text: string }

/**
 * 화면의 글 조각(문서 순서)에서 가릴 조각의 id와, 본문(mainText)의 개인정보가 그 조각들로 다 가려지는지.
 * 한 요소의 글이 안쪽 요소로 나뉘어 있으면 같은 id가 여러 번 나온다.
 * 두 번째 값이 false면 가리지 못한 개인정보가 본문에 남아 있다는 뜻이다.
 */
export function judgeBlocks(blocks: readonly MarkBlock[], mainText: string): [string[], boolean] {
  const texts = blocks.map(block => block.text);
  const flagged = [...secretEntries(texts)].sort((a, b) => a - b);
  let rest: Array<string | undefined> = [mainText];
  // 긴 조각부터 끊어야 짧은 조각이 긴 조각의 일부를 먼저 지우지 않는다
  const longest = [...flagged].sort((a, b) => Array.from(texts[b] ?? "").length - Array.from(texts[a] ?? "").length);
  for (const index of longest) {
    const pattern = piecePattern(texts[index] ?? "", index > 0 ? texts[index - 1] ?? "" : "", texts[index + 1] ?? "");
    rest = rest.flatMap(chunk => chunk === undefined ? [undefined] : cut(chunk, pattern));
  }
  const lines = rest.flatMap(chunk => chunk === undefined ? [undefined] : chunk.split("\n"));
  return [[...new Set(flagged.map(index => blocks[index]?.id ?? ""))], secretEntries(lines).size === 0];
}

export interface PageMarks {
  readonly blocks: readonly MarkBlock[];
  readonly frames: ReadonlyArray<{ readonly src: string }>;
  readonly passwords: number;
}

/**
 * blocks.ts가 돌려준 것으로 찍을지와 가릴 글 조각의 id를 정한다.
 * 화면 관찰 뒤에 화면이 바뀌었을 수 있어 비밀번호 칸과 보안문자 틀은 여기서 한 번 더 본다.
 */
export function judgeMarks(marks: PageMarks, mainText: string): string[] | ShotRefusal {
  if (marks.passwords !== 0) return refuse("password");
  if (marks.blocks.some(block => shotPatterns.captchaWords.test(block.text)) ||
    marks.frames.some(frame => shotPatterns.captchaFrame.test(frame.src))) return refuse("captcha");
  const [flagged, covered] = judgeBlocks(marks.blocks, mainText);
  return covered ? flagged : refuse("unmaskable");
}
