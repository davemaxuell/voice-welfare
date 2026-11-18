import childProcess from "node:child_process";
import { once } from "node:events";
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

  it("같은 프로세스를 재사용하고 비정상 종료 후 재시작하며 닫을 때 자식 종료를 기다린다", async () => {
    const spawn = vi.spyOn(childProcess, "spawn");
    const local = new PiiModel(directory);
    const scanner = new PiiScanner(local);
    try {
      const secret = "주민번호 900101-1234567";
      expect((await scanner.scan([secret]))[0]?.length).toBeGreaterThan(0);
      expect(await scanner.scan(["이름은 김하늘"])).toEqual([[]]);
      expect(spawn).toHaveBeenCalledTimes(1);
      const child = spawn.mock.results[0]?.value;
      if (child === undefined) throw new Error("PII sidecar did not start");
      const closed = once(child, "close");
      // Interrupt a live inference and verify rules still cover the secret.
      const pending = scanner.scan([secret + " 김하늘".repeat(6000)]);
      await new Promise<void>(done => setImmediate(done));
      child.kill();
      expect(await pending).toEqual([[]]);
      expect(redactText(secret)).not.toContain("1234567");
      await closed;
      expect((await scanner.scan([secret]))[0]?.length).toBeGreaterThan(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      const restarted = spawn.mock.results[1]?.value;
      await local.close();
      expect(restarted?.exitCode).toBe(0);
      await expect(local.secretSpans([secret])).rejects.toThrow("closed");
    } finally {
      await local.close();
      spawn.mockRestore();
    }
  });
});
