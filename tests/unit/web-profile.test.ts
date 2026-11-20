import { expect, it } from "vitest";
import { createMockWelfareProfile, INCOME_OPTIONS, matchOption, validateAddress, validateName } from "../../src/agents/web/profile.ts";

it("test_profile_validators", () => {
  expect(validateAddress("부산").ok).toBe(false);
  expect(validateAddress("부산광역시 예시구").ok).toBe(false);
  expect(validateAddress("부산광역시 예시구 예시로 10").ok).toBe(true);
  expect(matchOption("없음", INCOME_OPTIONS)).toMatchObject({ ok: true, value: "신고할 소득·재산 없음" });
  expect(matchOption("잘 모르겠어", INCOME_OPTIONS)).toMatchObject({ ok: true, value: "잘 모르겠음 (상담 필요)" });
  expect(matchOption("글쎄", INCOME_OPTIONS).ok).toBe(false);
  const profile = createMockWelfareProfile("http://localhost:5174");
  expect(profile.classify("http://localhost:5174/apply.html")).toBe("mock-welfare");
  expect(profile.classify("https://www.bokjiro.go.kr/")).toBe("external");
});

it.each([
  ["김하늘", true], ["남궁민수", true], ["John Smith", true], ["음 그냥 좀 도와줄래", false],
  ["근데 이 신청하면", false], ["네", false], ["1234", false],
] as const)("test_validate_name", (value, ok) => {
  expect(validateName(value).ok).toBe(ok);
});
