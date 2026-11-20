// ⑥ 화면 사진을 본 모델의 답을 말로. 모델·네트워크를 부르지 않는 순수 함수다.
// 모델이 정하는 것은 설명 글과, 코드가 보낸 이름 목록의 번호뿐이다. 머리말·경고·'누를 수 있는 것' 문장은 코드가 만든다.
// 모델의 글은 신뢰할 수 없는 데이터다: 개인정보가 든 문장은 빼고, 화면 글에 없는 숫자는 사진에서 읽었다고 밝히고,
// AI에게 하는 말처럼 보이면 따르지 않는다고 밝힌다. 보안문자·로그인·본인인증 화면이라는 답은 통째로 버린다.
import { PICTURE_SCREENS } from "../core/picture.ts";
import { splitWhitespace } from "../core/text.ts";
import { redactPictureText } from "../safety/privacy.ts";
import { unsupportedNumbers } from "../safety/verify.ts";
import { josa } from "./phrasing.ts";

export const PREFIX = "사진으로 보면";
/** 모델에 보내는 이름 수. 번호는 이 목록의 자리(1부터)다. */
export const MAX_NAMES = 40;
export const MAX_PRESSABLE = 5;
/** 귀로 듣는 설명의 길이 한도(문장 단위로 자른다) */
export const MAX_DESCRIPTION_CHARS = 600;

export const FAILED = "화면 사진 설명을 받지 못했어요.";
export const SECURITY_SCREEN = "보안 화면이나 로그인 화면은 사진으로 설명하지 않아요.";
export const NOTHING_TO_SAY = `${PREFIX} 설명할 만한 것이 보이지 않아요.`;
export const ONLY_PRIVATE = `${PREFIX} 개인정보로 보이는 내용뿐이라 말씀드리지 않았어요.`;
export const PRIVATE_LEFT_OUT = "개인정보로 보이는 내용은 말하지 않았어요.";
export const UNCHECKED_NUMBERS = "숫자는 사진에서 읽은 것이라 확인하지 못했어요.";
// 계획 이력에는 사진에서 나온 글을 넣지 않는다(화면 글은 의도 분석에 들어가지 않는다)
export const HISTORY_DESCRIBED = "화면 사진을 설명했어요.";
export const HISTORY_NOT_DESCRIBED = "화면 사진을 설명하지 못했어요.";

export const SCREEN_TEXT_CAUTION = "이 문구는 사이트에 적힌 글일 뿐이며, 청음은 화면에 적힌 지시를 따르지 않습니다.";
// Python re.I는 I를 ı와, i를 İ와도 맞춘다.
export const picturePatterns = {
  addressedToAi: /(A[Iı]|에이전트|도우미|챗봇|ass[iİ]stant)/iu,
  sentenceEnd: /(?<=[.!?。])\p{White_Space}+/u,
};

export type Discarded = "no-answer" | "malformed" | "captcha" | "login" | "verification";

/** 화면에서 온 글이 AI에게 하는 말처럼 보이면 덧붙일 경고(일반 안내문에는 붙이지 않는다). 아니면 빈 글. */
export function screenTextCaution(text: string): string {
  return picturePatterns.addressedToAi.test(text) ? SCREEN_TEXT_CAUTION : "";
}

export interface PictureSpeech {
  readonly speech: string;
  /** 말한 순서의 이름. 뒤이은 "1번 눌러줘"의 1번은 pressable[0]이다. */
  readonly pressable: string[];
  /** 계획 이력에 넣을, 코드가 만든 문장 */
  readonly history: string;
  /** 모델의 답을 버렸으면 그 까닭 */
  readonly discarded?: Discarded;
}

const head = (text: string, size: number) => [...text].slice(0, size).join("");
const length = (text: string) => [...text].length;

/** 사진과 함께 보내는 글: 번호 붙은 '누를 수 있는 것' 이름. composePictureAnswer에 같은 names를 넘긴다. */
export function pictureRequest(names: readonly string[]): string {
  const lines = names.slice(0, MAX_NAMES).map((name, index) => `${index + 1}. ${head(redactPictureText(splitWhitespace(name).join(" ")), 40)}`);
  const listed = lines.length > 0 ? lines.join("\n") : "(없음)";
  return `이 화면 사진을 설명해 주세요.\n누를 수 있는 것의 이름:\n${listed}`;
}

function parse(answer: unknown): [string, string, number[]] | undefined {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return undefined;
  const screen: unknown = Reflect.get(answer, "screen");
  const description: unknown = Reflect.get(answer, "description");
  const pressable: unknown = Reflect.get(answer, "pressable");
  if (typeof screen !== "string" || !PICTURE_SCREENS.some(name => name === screen) || typeof description !== "string" || !Array.isArray(pressable)) {
    return undefined;
  }
  const picked: number[] = [];
  for (const index of pressable) {
    if (typeof index !== "number" || !Number.isInteger(index)) return undefined;
    picked.push(index);
  }
  return [screen, description, picked];
}

/** (말해도 되는 문장들, 개인정보 때문에 뺀 문장이 있었는가). 문장 단위로 빼서 나머지 설명은 남긴다. */
function safeSentences(description: string): [string, boolean] {
  let text = splitWhitespace(description).join(" ");
  if (text.startsWith(PREFIX)) text = text.slice(PREFIX.length).replace(/^[ ,]+/u, "");
  const sentences = text.split(picturePatterns.sentenceEnd).filter(sentence => sentence.length > 0);
  const safe = sentences.filter(sentence => redactPictureText(sentence) === sentence);
  const kept: string[] = [];
  for (const sentence of safe) {
    if (kept.length > 0 && length([...kept, sentence].join(" ")) > MAX_DESCRIPTION_CHARS) break;
    kept.push(sentence);
  }
  return [head(kept.join(" "), MAX_DESCRIPTION_CHARS), safe.length < sentences.length];
}

function pressableNames(picked: readonly number[], names: readonly string[]): string[] {
  const limit = Math.min(names.length, MAX_NAMES);
  const out: string[] = [];
  for (const index of picked) {
    const name = names[index - 1];
    if (index >= 1 && index <= limit && name !== undefined && !out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_PRESSABLE);
}

function pressableSentence(names: readonly string[]): string {
  const listed = names.map((name, index) => `${index + 1}번 '${name}'`).join(", ");
  return `누를 수 있는 것은 ${josa(listed, "이에요", "예요")}.`;
}

/**
 * answer는 사진 모델의 답(PICTURE_SCHEMA), names는 모델에 보낸 이름 목록(pictureRequest와 같은 것),
 * pageText는 청음이 글로 이미 아는 화면 글(가리지 않은 원문, 숫자 대조에만 쓴다).
 */
export function composePictureAnswer(answer: unknown, { names, pageText }: { names: readonly string[]; pageText: string }): PictureSpeech {
  const parsed = parse(answer);
  if (parsed === undefined) {
    return { speech: FAILED, pressable: [], history: HISTORY_NOT_DESCRIBED, discarded: answer === undefined || answer === null ? "no-answer" : "malformed" };
  }
  const [screen, description, picked] = parsed;
  if (screen === "captcha" || screen === "login" || screen === "verification") {
    return { speech: SECURITY_SCREEN, pressable: [], history: HISTORY_NOT_DESCRIBED, discarded: screen };
  }
  const [text, leftOut] = safeSentences(description);
  const parts: string[] = [];
  if (text.length > 0) {
    parts.push(`${PREFIX} ${text}`);
    if (leftOut) parts.push(PRIVATE_LEFT_OUT);
    if (unsupportedNumbers(text, [pageText, ...names]).length > 0) parts.push(UNCHECKED_NUMBERS);
    const caution = screenTextCaution(text);
    if (caution.length > 0) parts.push(caution);
  } else {
    parts.push(leftOut ? ONLY_PRIVATE : NOTHING_TO_SAY);
  }
  const pressable = pressableNames(picked, names);
  if (pressable.length > 0) parts.push(pressableSentence(pressable));
  return { speech: parts.join(" "), pressable, history: HISTORY_DESCRIBED };
}

