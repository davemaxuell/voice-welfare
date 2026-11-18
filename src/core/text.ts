// Python str.strip()은 BOM을 남기고 NEL과 정보 구분 제어 문자는 지운다.
export function strip(text: string): string {
  return text.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, "");
}
