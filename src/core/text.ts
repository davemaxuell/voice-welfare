export const REDACTED = "[비공개]";

// Python str.strip()은 BOM을 남기고 NEL과 정보 구분 제어 문자는 지운다.
export function strip(text: string): string {
  return text.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, "");
}

/** Python str.strip(chars): chars에 든 글자(코드 포인트)를 양끝에서 걷어 낸다. */
export function stripChars(text: string, chars: string): string {
  const set = new Set(chars);
  const points = Array.from(text);
  let start = 0, end = points.length;
  while (start < end && set.has(points[start] ?? "")) start++;
  while (end > start && set.has(points[end - 1] ?? "")) end--;
  return points.slice(start, end).join("");
}

/** Python str.rstrip(): 끝의 공백만 걷어 낸다. */
export function rstrip(text: string): string {
  return text.replace(/[\p{White_Space}\u001c-\u001f]+$/u, "");
}

/** Python str.rstrip(chars) */
export function rstripChars(text: string, chars: string): string {
  const set = new Set(chars);
  const points = Array.from(text);
  let end = points.length;
  while (end > 0 && set.has(points[end - 1] ?? "")) end--;
  return points.slice(0, end).join("");
}

/**
 * Python str.casefold(). 대문자로 올렸다 소문자로 내리면 ß→ss, ſ→s, ς→σ가 맞는다.
 * 점 없는 ı, 대문자 ẞ, 체로키 글자는 규칙이 달라 따로 맞춘다.
 */
export function casefold(text: string): string {
  let folded = "";
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point === 0x131 || (point >= 0x13a0 && point <= 0x13f5)) folded += char;
    else if (point === 0x1e9e) folded += "ss";
    else if (point >= 0xab70 && point <= 0xabbf) folded += String.fromCodePoint(point - 0xab70 + 0x13a0);
    else if (point >= 0x13f8 && point <= 0x13fd) folded += String.fromCodePoint(point - 0x13f8 + 0x13f0);
    else folded += char.toUpperCase().toLowerCase();
  }
  return folded;
}

/** Python str.split(): 공백 덩어리로 나누고 빈 조각은 버린다. */
export function splitWhitespace(text: string): string[] {
  return text.split(/[\p{White_Space}\u001c-\u001f]+/u).filter(word => word.length > 0);
}

export function hasText(value?: string | null): value is string {
  return value != null && value.length > 0;
}

export function textOr(value: string | null | undefined, fallback: string): string {
  return hasText(value) ? value : fallback;
}

export function asciiDecimalDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, digit => {
    const point = digit.codePointAt(0)!;
    if (point <= 0x39) return digit;
    // 유니코드 십진 숫자는 0부터 9까지 이어진다. 수학용 숫자처럼 여러 묶음이 붙기도 한다.
    let first = point;
    while (first > 0 && /\p{Nd}/u.test(String.fromCodePoint(first - 1))) first--;
    return String((point - first) % 10);
  });
}
