import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { models } from "../../src/core/assets.ts";
import { PiiModel, PiiScanner } from "../../src/safety/pii_model.ts";
import { detectSensitive, redactText } from "../../src/safety/privacy.ts";

const directory = join(models, "koelectra-ko-pii-ner");
describe.skipIf(!PiiModel.available(directory))("로컬 Koelectra ONNX", () => {
  const model = new PiiModel(directory, 0.5);
  afterAll(() => model.close());

  it.each(["제 비밀번호는 A2UfgtKg!W1x 입니다", "주민번호 900101-1234567", "계좌번호 110-123-456789로 보내 주세요"])("test_tier1_found", async text => {
    const [spans] = await model.secretSpans([text]);
    expect(spans?.length).toBeGreaterThan(0);
  });

  it.each(["연락처는 010-1234-5678", "주소는 부산광역시 예시구 예시로 10", "이름은 김하늘", "장애인연금 신청 도와줘", "다음으로"])("test_ordinary_form_values_not_tier1", async text => {
    expect(await model.secretSpans([text])).toEqual([[]]);
  });

  it("test_offsets_point_at_value", async () => {
    const text = "주민번호는 900101-1234567 이에요";
    const [spans] = await model.secretSpans([text]);
    expect(spans?.some(([, start, end]) => text.slice(start, end).includes("1234567"))).toBe(true);
    const prefix = "😀가 ".repeat(83);
    const [later] = await model.secretSpans([prefix + text]);
    const points = Array.from(prefix + text);
    expect(later?.some(([, start, end]) => points.slice(start, end).join("") === "900101-1234567")).toBe(true);
  });

  it("test_wired_into_privacy", async () => {
    const scanner = new PiiScanner(model);
    const secret = "제 비밀번호는 A2UfgtKg!W1x 입니다", name = "이름은 김하늘";
    const [passwordSpans, nameSpans] = await scanner.scan([secret, name]);
    expect(detectSensitive(secret, passwordSpans).hasSecretValue).toBe(true);
    expect(redactText(secret, passwordSpans)).not.toContain("A2UfgtKg");
    expect(detectSensitive(name, nameSpans).hasSecretValue).toBe(false);

    const account = "😀 여기로 110-123-456789 부탁해요";
    const [accountSpans] = await scanner.scan([account]);
    expect(detectSensitive(account).hasSecretValue).toBe(false);
    expect(accountSpans).toEqual([["account", 6, 20]]);
    expect(redactText(account, accountSpans)).toBe("😀 여기로 [비공개] 부탁해요");
  });

  it("닫을 때 진행 중인 검사를 마치고 그 뒤 요청은 거절한다", async () => {
    const local = new PiiModel(directory);
    const secret = "주민번호 900101-1234567";
    const pending = local.secretSpans([secret + " 김하늘".repeat(300)]);
    const closing = local.close();
    expect((await pending)[0]?.length).toBeGreaterThan(0);
    await closing;
    await expect(local.secretSpans([secret])).rejects.toThrow("closed");
    await local.close();
  });

  it("모델을 불러오지 못하면 규칙만 쓴다", async () => {
    const broken = mkdtempSync(join(tmpdir(), "cheongeum-pii-"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const name of ["tokenizer.json", "config.json"]) copyFileSync(join(directory, name), join(broken, name));
      writeFileSync(join(broken, "model_int8.onnx"), "not an onnx model");
      expect(PiiModel.available(broken)).toBe(true);
      const local = new PiiModel(broken);
      const scanner = new PiiScanner(local);
      const secret = "주민번호 900101-1234567";
      expect(await scanner.scan([secret])).toEqual([[]]);
      expect(await scanner.scan([secret])).toEqual([[]]);
      expect(redactText(secret)).not.toContain("1234567");
      expect(stderr.mock.calls.map(([line]) => line)).toEqual(Array(2).fill("[privacy] 개인정보 모델 오류 → 규칙만 사용\n"));
      await local.close();
    } finally {
      stderr.mockRestore();
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

it("모델 파일이 없으면 쓰지 않는다", () => {
  const empty = mkdtempSync(join(tmpdir(), "cheongeum-pii-"));
  try {
    expect(PiiModel.available(empty)).toBe(false);
    writeFileSync(join(empty, "tokenizer.json"), "{}");
    writeFileSync(join(empty, "config.json"), "{}");
    expect(PiiModel.available(empty)).toBe(false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

it("reports the missing tokenizer before opening ONNX weights", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cheongeum-tokenizer-"));
  const model = new PiiModel(directory);
  try {
    writeFileSync(join(directory, "model_int8.onnx"), "");
    writeFileSync(join(directory, "config.json"), "{}");
    expect(PiiModel.available(directory)).toBe(false);
    await expect(model.load()).rejects.toMatchObject({ code: "ENOENT", path: join(directory, "tokenizer.json") });
  } finally {
    await model.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
