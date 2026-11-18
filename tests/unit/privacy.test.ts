import { expect, it, vi } from "vitest";
import { mergeBio, PiiScanner } from "../../src/safety/pii_model.ts";
import { detectSensitive, maskValue, redactText, spokenDigitSpans, type SecretSpan } from "../../src/safety/privacy.ts";

const positive = [
  "비밀번호는 123456이야", "주민번호 900101-1234567", "9001011234567", "OTP 482913", "계좌번호는 110-123-456789",
  "비밀번호는 일이삼사", "비밀번호는 사과나무야", "비밀번호는 사과나무로 할게", "비밀번호 알려줄게 사과나무",
  "인증번호는 칠칠칠팔팔팔", "주민번호 구공공일공일 일이삼사오육칠", "구공공일공일 일이삼사오육칠",
  "구공공일공일 일이삼사오육칠 이에요", "my password is 1234", "密码是1234", "パスワードは1234です",
];
const negative = [
  "비밀번호는 직접 입력할게", "로그인하고 싶어", "주소는 부산광역시 예시구 예시로 10", "연락처는 010-1234-5678",
  "비밀번호 칸이 어디야", "비밀번호를 잊어버렸어", "비밀번호 재설정 페이지 열어줘", "비밀번호 입력해줘",
  "비밀번호가 뭐야", "비밀번호 이거 뭐야", "비밀번호 알려줄게", "비밀번호요?", "인증번호 어디서 받아",
  "오늘 비번이야", "암호화폐 지원금 알려줘", "이사 가고 싶어", "사이사이에 넣어줘", "연락처는 공일공 일이삼사 오육칠팔",
];

it("test_detect_sensitive", () => {
  for (const text of positive) expect(detectSensitive(text).hasSecretValue, text).toBe(true);
  for (const text of negative) expect(detectSensitive(text).hasSecretValue, text).toBe(false);
});

it("test_redact", () => {
  expect(redactText("비밀번호는 123456이야")).toBe("비밀번호 [비공개]");
  expect(redactText("주민번호 900101-1234567 입니다")).not.toContain("1234567");
  expect(redactText("이름은 김하늘")).toBe("이름은 김하늘");
  expect(redactText("비밀번호는 사과나무야")).toBe("비밀번호 [비공개]");
  expect(redactText("구공공일공일 일이삼사오육칠 입니다")).toBe("[비공개] 입니다");
  expect(redactText("구공공일공일 일이삼사오육칠 이에요")).not.toContain("일이삼사오육칠");
  expect(redactText("연락처는 공일공 일이삼사 오육칠팔")).toBe("연락처는 공일공 일이삼사 오육칠팔");
  expect(redactText("😀가나다라마 끝", [["card", 3, 5], ["rrn", 1, 3], ["account", 2, 6]])).toBe("😀[비공개] 끝");
});

it("test_spoken_digit_spans", () => {
  expect(spokenDigitSpans("공일공 일이삼사, 이사 가요").map(([, , number]) => number)).toEqual(["0101234"]);
  expect(spokenDigitSpans("😀공일공 일이삼사, 🤔구공일이")).toEqual([[1, 9, "0101234"], [12, 16, "9012"]]);
});

it("test_model_union_with_rules", async () => {
  const secretSpans = vi.fn(async (texts: readonly string[]) => texts.map((): SecretSpan[] => [["password", 4, 8]]));
  const scanner = new PiiScanner({ secretSpans });
  const text = "오늘은 사과나무 라고 해";
  const [spans] = await scanner.scan([text]);
  expect(detectSensitive(text, spans)).toEqual({ hasSecretValue: true, kinds: ["password"] });
  expect(redactText(text, spans)).toBe("오늘은 [비공개] 라고 해");
  secretSpans.mockClear();
  expect(detectSensitive(text).hasSecretValue).toBe(false);
  expect(await scanner.scan(["hello world", text])).toEqual([[], spans]);
  expect(secretSpans).not.toHaveBeenCalled();
});

it("test_model_error_falls_back_to_rules", async () => {
  const secretSpans = vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue([[], []]);
  const scanner = new PiiScanner({ secretSpans });
  const input = ["비밀번호는 1234", "이름은 김하늘"];
  const result = await scanner.scan(input);
  expect(result).toEqual([[], []]);
  expect(detectSensitive(input[0]!, result[0]).hasSecretValue).toBe(true);
  expect(detectSensitive(input[1]!, result[1]).hasSecretValue).toBe(false);
  expect(await scanner.scan(input)).toEqual([[], []]);
  expect(secretSpans).toHaveBeenCalledTimes(2);
});

it("배치 중복을 합치고, 한글이 있는 입력만 보내며, 실패한 항목만 재시도한다", async () => {
  const secretSpans = vi.fn().mockResolvedValueOnce([[["rrn", 0, 1]], null]).mockResolvedValueOnce([[]]);
  const scanner = new PiiScanner({ secretSpans });
  const [first, second] = await Promise.all([
    scanner.scan(["가", "ABC", "가", "나"]), scanner.scan(["나", "가"]),
  ]);
  expect(first).toEqual([[["rrn", 0, 1]], [], [["rrn", 0, 1]], []]);
  expect(second).toEqual([[], [["rrn", 0, 1]]]);
  expect(secretSpans.mock.calls).toEqual([[["가", "나"]], [["나"]]]);
});

it("test_merge_bio", () => {
  const spans = mergeBio([
    ["B-NAME", 0.9, 0, 2], ["I-NAME", 0.7, 2, 3], ["O", 0.99, 4, 6], ["I-PHONE", 0.8, 7, 10],
    ["I-PHONE", 0.6, 11, 15], ["B-SECRET", 0.5, 16, 20], ["B-SECRET", 0.9, 21, 25],
  ]);
  expect(spans.map(s => [s.label, s.start, s.end])).toEqual([
    ["NAME", 0, 3], ["PHONE", 7, 15], ["SECRET", 16, 20], ["SECRET", 21, 25],
  ]);
  expect(spans[0]?.score).toBeCloseTo(0.8);
});

it("test_mask_phone", () => {
  expect(maskValue("010-1234-5678")).toBe("010-****-5678");
  expect(maskValue("😀한😀")).toBe("😀*😀");
});
