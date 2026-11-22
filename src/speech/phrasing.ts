import { asciiDecimalDigits, strip } from "../core/text.ts";
import { maskValue } from "../safety/privacy.ts";

export const READ_CHUNK = 350;
/** 조용한 조사 창은 이미 닫혀 있으므로 이용자가 볼 검색 화면을 열도록 안내한다. */
export const OPEN_SITE_SEARCH = {
  ko: "이어서 ‘공식 사이트의 검색 화면을 열어 줘’라고 말씀해 주세요.",
  en: "To continue, say “Open the official site’s search page.”",
  zh: "要继续，请说“打开官方网站的搜索页面”。",
  ja: "続けるには「公式サイトの検索画面を開いて」とお伝えください。",
} as const;
export const phrasingPatterns = {
  wordTail: /[\p{White_Space})）'"’”]+(?=\n?$)/u,
  digit: /[0-9]/u,
  letterWithBatchim: /[LMNR](?=\n?$)/iu,
  optionalLabel: /\p{White_Space}*\(선택\)(?=\n?$)/u,
  sentenceEnd: /[.!?。]\p{White_Space}[^.!?。]*(?=\n?$)|다\.\p{White_Space}[^.]*(?=\n?$)/u,
  // 전화번호: 지역번호 붙은 번호, 1588-1234 같은 대표번호(언제나), 1355·129 같은 국번 없는 번호(아래 조건일 때만)
  fullPhone: /(?<![\p{Nd}.:,-])(?:0\p{Nd}{1,2}[-.)\p{White_Space}]?\p{Nd}{3,4}[-.\p{White_Space}]?\p{Nd}{4}|1\p{Nd}{3}[-\p{White_Space}]\p{Nd}{4})(?!\p{Nd}|,\p{Nd}|\.\p{Nd}|\p{White_Space}*[년월일생])/gu,
  // 국번 없는 번호는 뒤에 조사·문장부호·끝이 올 때만(100분의, 120시간, 100 만원, 100 이하, 120가구, 제102조, 1955-03-02는 아님)
  barePhone: /(?<![\p{Nd}.:,-])1\p{Nd}{2,3}(?=[\p{White_Space},.!?)(~]|$|[이가은는을를로으에와과도요번예입])(?!\p{White_Space}*(?:[\p{Nd}만천억원명세년월일개분시초%조항호층]|이하|이상|초과|미만|가구|곳))(?!\p{Nd}|,\p{Nd}|\.\p{Nd})/gu,
  // 바로 앞에 전화번호라는 단서가 있을 때만: '센터 이용 정원은 100'처럼 단서가 떨어져 있으면 금액·인원·기준값일 수 있다.
  cueBefore: /(번호|전화|국번\p{White_Space}*없이|센터|문의|연락처|☎)\p{White_Space}*(?:는|은|:|번호는|번호)?\p{White_Space}*(?:국번\p{White_Space}*없이\p{White_Space}*)?$/u,
  digits: /\p{Nd}+/gu,
};

export type ClickEffect = "moved" | "changed" | "none";
export function pressResult(pressed: string, effect?: ClickEffect, { revealed, moved, approved = false }: {
  revealed?: string; moved?: string; approved?: boolean;
} = {}): string {
  if (effect === "none") return pressed + " 눌렀지만 화면이 바뀌지 않았어요.";
  const receipt = approved ? pressed + " 눌렀어요. " : "";
  if (effect === "changed") {
    const shown = chunkText((revealed ?? "").split("\n").join(" "), 0);
    return receipt + (shown.length > 0 ? "새로 보이는 내용입니다. " + shown : "같은 화면에서 내용이 바뀌었어요.");
  }
  if (effect === "moved") return receipt + (moved !== undefined && moved.length > 0 ? moved : "새 페이지가 열렸어요.");
  return receipt + "화면 변화를 확인하지 못했어요.";
}

export function josa(word: string, withBatchim: string, without: string): string {
  const last = Array.from(word.replace(phrasingPatterns.wordTail, "")).at(-1);
  if (last === undefined) return word + without;
  if (phrasingPatterns.digit.test(last)) return word + ("013678".includes(last) ? withBatchim : without);
  const syllable = last.charCodeAt(0) - 0xac00;
  const hasBatchim = syllable >= 0 && syllable <= 11171 ? syllable % 28 !== 0 : phrasingPatterns.letterWithBatchim.test(last);
  return word + (hasBatchim ? withBatchim : without);
}

/** 부르는 이름 + 님('길동님'처럼 이미 붙었으면 그대로) */
export function speakCallName(name: string): string {
  return name.endsWith("님") ? name : `${name}님`;
}

export function speakLabel(label: string): string {
  return label.replace(phrasingPatterns.optionalLabel, "");
}

function dateInteger(part: string): string {
  const digits = asciiDecimalDigits(strip(part));
  if (!/^\+?[0-9](?:_?[0-9])*$/u.test(digits)) throw new Error("잘못된 날짜 숫자");
  return BigInt(digits.replaceAll("_", "")).toString();
}

export function speakDate(date: string): string {
  const parts = date.split("-").map(dateInteger);
  if (parts.length !== 3) throw new Error("날짜에 연·월·일 필요");
  return `${parts[1]}월 ${parts[2]}일`;
}

export function chunkText(text: string, offset: number, size = READ_CHUNK): string {
  const characters = Array.from(text);
  if (offset >= characters.length) return "";
  let end = Math.min(characters.length, offset + size);
  if (end < characters.length) {
    const window = characters.slice(offset, end).join("");
    const match = phrasingPatterns.sentenceEnd.exec(window);
    if (match !== null) {
      const cut = Array.from(window.slice(0, match.index)).length;
      if (cut > size * 0.5) end = offset + cut + 2;
    }
  }
  return strip(characters.slice(offset, end).join(""));
}

function spell(number: string): string {
  return (number.match(phrasingPatterns.digits) ?? []).map(group => Array.from(group).join(" ")).join(", ");
}

function barePhones(text: string): RegExpExecArray[] {
  return Array.from(text.matchAll(phrasingPatterns.barePhone))
    .filter(match => phrasingPatterns.cueBefore.test(text.slice(0, match.index)));
}

export function hasPhoneNumber(sentence: string): boolean {
  return sentence.search(phrasingPatterns.fullPhone) >= 0 || barePhones(sentence).length > 0;
}

/** 전화번호를 한 자리씩 끊어 읽게: '1355' → '1 3 5 5', '051-709-4657' → '0 5 1, 7 0 9, 4 6 5 7'. 금액·기준값은 그대로. */
export function spellPhoneNumbers(text: string): string {
  let spelled = text.replace(phrasingPatterns.fullPhone, spell);
  for (const match of barePhones(spelled).reverse()) {
    spelled = spelled.slice(0, match.index) + spell(match[0]) + spelled.slice(match.index + match[0].length);
  }
  return spelled;
}

export function readback(field: { maskOnReadback: boolean }, value: string): string {
  return field.maskOnReadback && value.length > 0 ? maskValue(value) : value;
}
