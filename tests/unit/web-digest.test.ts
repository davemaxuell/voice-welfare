import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { digestForLlm, digestPage, flatMain, pageTextForLlm, textOffset } from "../../src/agents/web/digest.ts";
import type { WebObservation } from "../../src/agents/web/view.ts";
import { PiiScanner } from "../../src/safety/pii_model.ts";
import { redactText, type SecretSpan } from "../../src/safety/privacy.ts";
import { checkGrounding } from "../../src/safety/verify.ts";

const rrn = "900101-1234567";
function view(overrides: WebObservation = {}): WebObservation {
  return { url: "https://example.kr/", title: "예시", pageId: "external", ...overrides };
}
function body(mainText: string) { return digestPage(view({ outline: { mainText } })); }

it("preserves terse labels next to each value when collecting official evidence", () => {
  const mainText = "본관\n가능\n별관\n불가\n분관\n가능";
  expect(digestPage(view({outline: { mainText }}), { preserveRows: true }).main).toBe(mainText);
});

it("test_digest_menu_and_content", () => {
  const digest = digestPage(view({ outline: {
    headings: [{ level: 1, text: "공지사항" }],
    links: ["본문 바로가기", "홈", "공지", "2026년 접수 안내", "2026년 접수 안내", "서식 자료실"],
    menuLinks: ["홈", "공지"], mainLinks: ["2026년 접수 안내", "2026년 접수 안내", "서식 자료실"],
    mainText: "홈\n공지\n공지사항\n2026년 접수 안내\n2026년 접수 안내\n가\n접수는 3월까지입니다.",
  } }));
  expect(digest.menu).toEqual(["홈", "공지"]);
  expect(digest.contentLinks).toEqual(["2026년 접수 안내", "서식 자료실"]);
  expect(digest.main).toBe("공지사항\n2026년 접수 안내\n접수는 3월까지입니다.");
  expect(digest.canDo).toContain("메뉴 이동");
});
it("test_digest_kinds", () => {
  expect(digestPage(view({ url: "https://search.example.kr/?query=날씨" })).kind).toBe("search-results");
  expect(digestPage(view({ title: "Access Denied" })).kind).toBe("blocked");
  expect(digestPage(view({ fields: [{ visible: true }, { visible: true }] })).kind).toBe("form");
  expect(digestPage(view({ outline: { links: ["사용 가능한 링크"], mainLinks: [] } })).contentLinks).toEqual([]);
});
it("test_digest_for_llm_is_smaller", async () => {
  const links = Array.from({ length: 200 }, (_, i) => "기사 제목 " + i + "번 — 아주 긴 제목이 이어집니다");
  const mainText = Array.from({ length: 200 }, (_, i) => i + "번째 문단입니다. 같은 이야기가 계속됩니다.").join("\n");
  const outline = { links, mainLinks: links, mainText };
  const small = await digestForLlm(digestPage(view({ outline })));
  expect(small.items.length).toBeLessThanOrEqual(54);
  expect(small.mainText.length).toBeLessThanOrEqual(1500);
  expect(small.moreText).toBe(true);
  expect(JSON.stringify(small).length).toBeLessThan(JSON.stringify(outline).length / 3);
});
it("test_digest_ranks_menu_buttons_over_screen_tools", async () => {
  const tools = ["글자 작게", "글자 크게", "화면 인쇄", "English", "中文", "日本語", "이전 배너", "다음 배너", "공유하기", "맨 위로", "본문 바로가기"];
  const menu = ["복지서비스", "서비스 찾기", "복지지도"];
  const buttons = [...tools, ...menu].map(name => ({ name, disabled: false }));
  const page = await digestForLlm(digestPage(view({ outline: { buttons } })));
  expect(page.items.map(i => i.name)).toEqual(menu);
});
it("test_digest_gives_spare_room_to_buttons", async () => {
  const buttons = Array.from({ length: 40 }, (_, i) => ({ name: "메뉴 " + i, disabled: false }));
  const page = await digestForLlm(digestPage(view({ outline: { links: ["가나", "다라"], mainLinks: ["가나", "다라"], buttons } })));
  expect(page.items.filter(i => i.kind === "button")).toHaveLength(40);
  expect(page.items.length).toBeLessThanOrEqual(54);
});
it("test_digest_lists_tabs_and_expanders_first_with_state", async () => {
  const d = digestPage(view({ outline: { items: [
    { role: "button", name: "더 보기" }, { role: "button", name: "서류 안내", expanded: false },
    { role: "tab", name: "지원대상", selected: true }, { role: "tab", name: "신청방법", selected: false },
  ] } }));
  expect((await digestForLlm(d)).items).toEqual([
    { kind: "tab", name: "지원대상", selected: true }, { kind: "tab", name: "신청방법", selected: false },
    { kind: "button", name: "서류 안내", expanded: false }, { kind: "button", name: "더 보기" },
  ]);
});
it("test_readable_body", () => {
  const d = body(["로그아웃", "복지소식", "복지로 소개", "고객센터", "사이트맵", "복지서비스 상세(중앙)", "즐겨찾기", "찜하기", "기초연금",
    "노인에게 기초연금을 지급하여 안정적인 소득기반을 제공함으로써 노인의 생활안정을 지원합니다.", "신청하기", "지원대상 선택됨",
    "만 65세 이상인 어르신으로서 소득인정액이 기준 이하인 사람에게 지원합니다.", "만족도 평가",
    "이 페이지에서 제공하는 정보에 얼마나 만족하십니까 ?", "매우 만족"].join("\n"));
  expect(d.body.split("\n")[0]).toBe("기초연금");
  expect(d.body).not.toMatch(/로그아웃|신청하기|만족도/u);
  expect(d.body).toContain("지원대상\n만 65세");
});
it("본문 찾기는 공백을 무시하고 메타문자를 글자로 비교하여 원문 코드 포인트 좌표를 돌려준다", () => {
  const d = body("🤔예시글\n자료 [ 지금 신청 ]\n마지막 줄");
  expect(flatMain(d)).toBe("🤔예시글 / 자료 [ 지금 신청 ] / 마지막 줄");
  expect(textOffset(d, "[지금신청]")).toBe(7);
  expect(textOffset(d, ".")).toBeUndefined();
  expect(textOffset(d, " ")).toBeUndefined();
});
it("test_digest_for_llm_redacts_resident_number_in_main_text", async () => {
  const page = await digestForLlm(body("기초연금 안내입니다. 번호 " + rrn + " 는 보여 주면 안 됩니다. 대상은 만 65세 이상입니다."));
  expect(page.mainText).not.toContain("900101");
  expect(page.mainText).toContain("[비공개]");
  expect(page.mainText).toContain("만 65세 이상");
});
it("test_digest_for_llm_gives_the_footer_with_personal_data_hidden", async () => {
  const d = digestPage(view({ outline: { mainText: "본문만", footerText: "대표번호 국번없이 1355(평일 09시~18시) 담당 " + rrn } }));
  const page = await digestForLlm(d);
  expect(page.footer).toContain("대표번호 국번없이 1355");
  expect(page.footer).not.toContain(rrn);
  expect(page.mainText).not.toContain("1355");
});
it("test_footer_is_redacted_before_it_is_cut", async () => {
  const page = await digestForLlm(digestPage(view({ outline: { mainText: "본문", footerText: "가".repeat(392) + rrn } })));
  expect(page.footer).not.toContain("900101");
});
it("test_digest_for_llm_redacts_title_heading_and_dialog", async () => {
  const page = await digestForLlm(digestPage(view({
    title: "주민 " + rrn, dialogs: [{ title: "확인 " + rrn, text: "" }],
    outline: { headings: [{ level: 1, text: "제목 " + rrn }], mainText: "본문만" },
  })));
  expect([page.title, ...page.headings, ...page.dialogs]).toEqual(["주민 [비공개]", "제목 [비공개]", "확인 [비공개]"]);
});
it("test_page_text_for_llm_hides_personal_data_before_cutting", async () => {
  const [raw, safe] = await pageTextForLlm(body("가".repeat(2992) + " " + rrn + " 끝"));
  expect(safe).not.toContain("900101");
  expect(raw.length).toBeLessThanOrEqual(3000);
  expect(safe.length).toBeLessThanOrEqual(3000);
  const answer = "대상은 만 65세 이상입니다.";
  const [source, prompt] = await pageTextForLlm(body(answer + " " + rrn));
  expect(prompt).toBe(answer + " [비공개]");
  expect(source).toContain(rrn);
  expect(checkGrounding({ answer, quotes: [answer], sources: [source] }).ok).toBe(true);
});

it("본문 페이지 경계의 주민번호는 어느 쪽에도 남지 않으며 다음 위치는 원문 기준이다", async () => {
  const rows = z.array(z.object({ kind: z.string() }).passthrough()).parse(JSON.parse(readFileSync(
    new URL("../fixtures/oracle/adopt-js.json", import.meta.url), "utf8",
  )));
  const adopted = z.object({
    input: z.string(), offset: z.int(), mainChars: z.int(), python: z.string(), typescript: z.string(),
  }).parse(rows.find(row => row.kind === "digest-main-window"));
  const d = body(adopted.input), size = adopted.mainChars;
  const pages = await Promise.all([0, size, 2 * size].map(offset => digestForLlm(d, { offset, mainChars: size })));
  expect(redactText(Array.from(d.main).slice(adopted.offset, adopted.offset + size).join(""))).toBe(adopted.python);
  expect(pages.map(page => page.mainText)).toEqual([adopted.typescript, "[비공개]", " 끝"]);
  expect(pages.map(page => page.moreText)).toEqual([true, true, false]);
  expect((await digestForLlm(d, { offset: 6, mainChars: 2 })).mainText).toBe("[비공개]");
  expect((await digestForLlm(d, { offset: 18, mainChars: 2 })).mainText).toBe(" 끝");

  const shifted = body("900101-1234567😀가 / 901010-2345678😀나");
  expect((await digestForLlm(shifted, { offset: 14, mainChars: 5 })).mainText).toBe("😀가 / ");
  expect((await digestForLlm(shifted, { offset: 16, mainChars: 5 })).mainText).toBe(" / [비공개]");
});
it("모델 전용 구간도 한 번의 전체 본문 배치로 찾아 양쪽 페이지에서 가린다", async () => {
  const mainText = "🤔원문 사과나무 끝";
  const secretSpans = vi.fn(async (texts: readonly string[]) => texts.map((text): SecretSpan[] => text === mainText ? [["password", 4, 8]] : []));
  const scanner = new PiiScanner({ secretSpans });
  const d = digestPage(view({ outline: { mainText, headings: [{ text: "안내 제목" }], footerText: "꼬리말" }, dialogs: [{ title: "열린 창" }] }));
  const first = await digestForLlm(d, { scanner, mainChars: 6 });
  const second = await digestForLlm(d, { scanner, offset: 6, mainChars: 6 });
  expect(secretSpans.mock.calls).toEqual([[[d.title, ...d.headings, ...d.dialogs, mainText, d.footer]]]);
  expect([first.mainText, second.mainText]).toEqual(["🤔원문 [비공개]", "[비공개] 끝"]);
});
