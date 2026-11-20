import { expect, it } from "vitest";
import {
  REFUSAL_SPEECH, ShotRefusal, judgeBlocks, judgeMarks, planShot, type MarkBlock, type PageMarks,
} from "../../src/agents/web/shot.ts";
import type { WebObservation } from "../../src/agents/web/view.ts";

const RRN = "900101-1234567";

function view(over: WebObservation = {}): WebObservation {
  return {
    url: "https://example.kr/notice", title: "기초연금 안내", fields: [], errors: [], dialogs: [],
    outline: { mainText: "기초연금은 만 65세 이상 어르신께 드립니다.", items: [] }, ...over,
  };
}
const main = (text: string) => ({ mainText: text, items: [] });
const field = (type: string, { visible = true, label = "칸" } = {}) => ({ fieldId: `f-${type}`, type, visible, label });

const neverPhotographed: Array<[WebObservation, string]> = [
  [view({ title: "접속이 차단되었습니다" }), "blocked"],
  [view({ outline: main("비정상적인 접근이 감지되었습니다. 잠시 후 다시 시도하세요.") }), "blocked"],
  [view({ title: "reCAPTCHA 확인" }), "captcha"],
  [view({ outline: main("회원가입\n아래 보안문자를 입력해 주세요.") }), "captcha"],
  [view({ fields: [field("text", { label: "자동입력 방지 문자" })] }), "captcha"],
  [view({ title: "회원 로그인" }), "login"],
  [view({ fields: [field("text", { label: "아이디" }), field("password", { label: "비밀번호" })] }), "login"],
  [view({ pageId: "mock-login", title: "[모의] 본인인증 (가상 화면)" }), "login"],
  [view({ title: "본인인증" }), "verification"],
  [view({ title: "확인", outline: main("PASS 인증으로 본인 확인을 진행합니다.") }), "verification"],
  [view({ fields: [field("password", { visible: false })] }), "password"],
];
it.each(neverPhotographed)("test_screens_that_are_never_photographed", (screen, reason) => {
  const refusal = planShot(screen);
  expect(refusal).toBeInstanceOf(ShotRefusal);
  if (!(refusal instanceof ShotRefusal)) return;
  expect(refusal.reason).toBe(reason);
  expect(refusal.speech.length).toBeGreaterThan(0);
});

it("test_every_refusal_has_its_own_sentence", () => {
  expect(Object.keys(REFUSAL_SPEECH).sort((a, b) => a.localeCompare(b))).toEqual(
    ["loading", "too-large", "changed", "blocked", "captcha", "login", "verification", "password", "unmaskable"].sort((a, b) => a.localeCompare(b)),
  );
  expect(new Set(Object.values(REFUSAL_SPEECH)).size).toBe(Object.keys(REFUSAL_SPEECH).length);
});

it("test_normal_page_masks_every_input_and_frame_and_hides_the_cursor", () => {
  const plan = planShot(view({ fields: [field("text", { label: "검색어" })] }));
  if (plan instanceof ShotRefusal) throw new Error(plan.speech);
  for (const selector of ["input", "textarea", "select", "[contenteditable]", "iframe"]) expect(plan.mask).toContain(selector);
  expect(plan.hide).toContain('[id^="__cheongeum"]');
});

const block = (index: number, text: string): MarkBlock => ({ id: `b${index}`, text });
const blocks = (...texts: string[]) => texts.map((text, index) => block(index, text));

const judged: Array<[MarkBlock[], string, [string[], boolean]]> = [
  [blocks("기초연금 안내", `주민등록번호 ${RRN}`), `기초연금 안내\n주민등록번호 ${RRN}`, [["b1"], true]],
  [blocks("기초연금 안내", "만 65세 이상이면 신청할 수 있습니다."), "기초연금 안내\n만 65세 이상이면 신청할 수 있습니다.", [[], true]],
  // 표: 이름과 값이 다른 칸에 있다
  [blocks("계좌번호", "110-123-456789", "담당 부서", "복지정책과"), "계좌번호 110-123-456789\n담당 부서 복지정책과", [["b1"], true]],
  [blocks("주민등록번호", RRN), `주민등록번호\n${RRN}`, [["b1"], true]],
  // 본문에는 있는데 그것을 담은 조각이 없다
  [blocks("기초연금 안내"), `기초연금 안내\n주민등록번호 ${RRN}`, [[], false]],
  [blocks("기초연금 안내", `주민등록번호 ${RRN}`), `주민등록번호 ${RRN}\n카드번호 1234-5678-9012-3456`, [["b1"], false]],
  [blocks("계좌번호"), "계좌번호\n110-123-456789", [[], false]],
  // 띄어쓰기·줄바꿈이 달라도 같은 글이다
  [blocks(`주민등록번호 ${RRN}`), `주민등록번호\n  ${RRN}`, [["b0"], true]],
  // 관찰한 본문은 조각과 그 안쪽 요소의 글을 붙여 쓰기도 한다
  [blocks(`주민등록번호 ${RRN}`, "안쪽 문단입니다."), `주민등록번호 ${RRN}안쪽 문단입니다.`, [["b0"], true]],
  [blocks("앞 문단입니다", `주민등록번호 ${RRN}`), `앞 문단입니다주민등록번호 ${RRN}`, [["b1"], true]],
  // 짧은 조각('3')이 다른 번호의 일부를 지워 그 번호를 못 알아보게 하면 안 된다
  [blocks("계좌번호", "3"), `계좌번호 3\n${RRN}`, [["b1"], false]],
  // 한 요소의 글이 둘로 나뉘어 와도 id는 한 번
  [[block(0, `주민등록번호 ${RRN}`), block(1, "안내"), block(0, "카드번호 1234-5678-9012-3456")], "", [["b0"], true]],
];
it.each(judged)("test_judge_blocks", (page, mainText, expected) => {
  expect(judgeBlocks(page, mainText)).toEqual(expected);
});

const marks = (over: Partial<PageMarks> = {}): PageMarks => ({ blocks: blocks("기초연금 안내"), frames: [], passwords: 0, ...over });
const frame = (src: string) => ({ src, shown: true });

it.each([
  "https://www.google.com/recaptcha/api2/anchor?k=site",
  "https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html",
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/x/",
])("test_captcha_frame_is_refused", src => {
  const refusal = judgeMarks(marks({ frames: [frame("https://www.youtube.com/embed/abc"), frame(src)] }), "기초연금 안내");
  expect(refusal).toBeInstanceOf(ShotRefusal);
  expect(refusal instanceof ShotRefusal ? refusal.reason : refusal).toBe("captcha");
});

it("test_ordinary_frame_and_text_pass_with_the_blocks_to_mask", () => {
  const page = marks({ blocks: blocks("기초연금 안내", `주민등록번호 ${RRN}`), frames: [frame("https://www.youtube.com/embed/abc")] });
  expect(judgeMarks(page, `기초연금 안내\n주민등록번호 ${RRN}`)).toEqual(["b1"]);
});

it("test_password_field_seen_at_capture_time_is_refused", () => {
  const refusal = judgeMarks(marks({ passwords: 1 }), "기초연금 안내");
  expect(refusal instanceof ShotRefusal ? refusal.reason : refusal).toBe("password");
});

it("test_uncovered_secret_is_refused_as_unmaskable", () => {
  const refusal = judgeMarks(marks(), `주민등록번호 ${RRN}`);
  expect(refusal instanceof ShotRefusal ? refusal.reason : refusal).toBe("unmaskable");
});
