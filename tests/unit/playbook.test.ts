import { expect, it } from "vitest";
import { blockedSpeech, forUrl, helpHumanSpeech } from "../../src/agents/web/playbook.ts";

it("test_help_human_says_cant_speaks_129_then_alternatives", () => {
  const said = helpHumanSpeech();
  expect(said).toMatch(/전화|연결/u);
  expect(said).toMatch(/못|않/u);
  expect(said).toContain("129");
  expect(said.indexOf("129")).toBeLessThan(said.indexOf("대신"));
  expect(["찾아", "읽", "신청", "열어", "검색"].filter(word => said.includes(word)).length).toBeGreaterThanOrEqual(2);
  expect(said).toMatch(/다시 들려|다시 말씀/u);
});

it("test_help_human_prefers_service_contact_over_129", () => {
  const said = helpHumanSpeech({ contactName: "국민연금공단", contactNumber: "1355", serviceName: "기초연금" });
  expect(said).toContain("1355");
  expect(said.slice(0, said.indexOf("1355"))).not.toContain("129");
  expect(said).toContain("기초연금");
});

it("test_help_human_uses_gov24_playbook_number", () => {
  expect(helpHumanSpeech({ url: "https://www.gov.kr/mw/AA020InfoServiceList.do" })).toContain("1588-2188");
});

it("test_blocked_bokjiro_ends_with_next_step_and_notice_once", () => {
  const given = new Set<string>();
  const once = (key: string, text: string) => {
    if (given.has(key)) return "";
    given.add(key);
    return text;
  };
  const url = "https://www.bokjiro.go.kr/";
  const notice = forUrl(url)!.automationNotice;
  const first = blockedSpeech(url, once);
  const second = blockedSpeech(url, once);
  expect(first).toMatch(/막을|자동/u);
  expect(first).toContain("브라우저");
  expect(first).toMatch(/직접|찾아/u);
  expect(first).toContain(notice);
  expect(second).not.toContain(notice);
  expect(second).toMatch(/직접|찾아/u);
});
