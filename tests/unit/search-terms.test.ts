import { expect, it } from "vitest";
import { siteSearchTerms } from "../../src/agents/web/search_terms.ts";

it("검색 공급자 식 전체와 식이 섞인 모델 단어를 화면 검색어로 받을 수 없다", () => {
  for (const query of ["site:archive.go.kr 시민 교육", "title:open", "-archive", "교육 (복지 OR 예산)"]) {
    expect(siteSearchTerms(query)).toBeUndefined();
    expect(siteSearchTerms(["시민", query])).toBeUndefined();
  }
  expect(siteSearchTerms(["시민", "도서관"])).toBe("시민 도서관");
  expect(siteSearchTerms(["図書館", "교통", "café", "65세"])).toBe("図書館 교통 café 65세");
});
