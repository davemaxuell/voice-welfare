// Python str.strip()은 BOM을 남기고 NEL과 정보 구분 제어 문자는 지운다.
export function strip(text: string): string {
  return text.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, "");
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
