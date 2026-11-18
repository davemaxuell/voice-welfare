import { z } from "zod";

// JSON 수의 범위 안에서 정수인지 본다. Pydantic 정수에는 safe-integer 상한이 없다.
export const integer = z.number().refine(Number.isInteger, "정수가 필요합니다.");

// 선택 필드에 온 JSON null은 결과 객체에서 빠진다. 필수 필드와 알 수 없는 키의 검증은 그대로 적용한다.
export function optional<T extends z.ZodType>(schema: T) {
  return schema.nullable().transform(value => value ?? undefined).optional();
}

export function omitAbsent<T extends object>(fields: T): T {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) Reflect.deleteProperty(fields, key);
  }
  return fields;
}

export function boundedText(min: number, max: number) {
  return z.string().refine(value => {
    const length = Array.from(value).length;
    return length >= min && length <= max;
  }, `문자 수는 ${min} 이상 ${max} 이하여야 합니다.`);
}
