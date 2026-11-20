/** Python finditer의 (start, end)처럼 코드 포인트 위치로 모든 일치 구간을 센다. */
export function codePointSpans(expression: RegExp, input: string): Array<[number, number]> {
  const flags = expression.flags.includes("g") ? expression.flags : expression.flags + "g";
  const toPoints = (units: number) => Array.from(input.slice(0, units)).length;
  return Array.from(input.matchAll(new RegExp(expression.source, flags)),
    match => [toPoints(match.index), toPoints(match.index + match[0].length)]);
}
