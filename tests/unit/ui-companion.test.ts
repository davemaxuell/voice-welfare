// 아바타 창에 보내는 카드와 한 줄 상태(companion.ts). 입력값·화면 글은 아바타로 나가지 않는다.
import { expect, it } from "vitest";
import { TurnSchema } from "../../web/src/api.ts";
import { currentDecision, desktopView, turnNotice, type LiveView, type ViewInput } from "../../web/src/companion.ts";

function turn(patch: Record<string, unknown> = {}) {
  return TurnSchema.parse({
    sessionId: "s1", turnId: "t1", userUtterance: "말", intentType: "X", state: "BROWSING", semanticAction: "read",
    speech: "답", actions: [], sources: [], ...patch,
  });
}
const base: ViewInput = { sessionId: "s1", lang: "ko", consent: "granted", state: "IDLE", busy: false, phase: "off", listening: false };
const live: LiveView = { capture: "off", speaking: false, recording: false, message: null, sleeping: false, introPose: null, card: undefined, pending: false };
const pending = { actionId: "a1", kind: "field-entry", purpose: "주민번호 입력", site: "복지로", values: [{ label: "주민번호", value: "900101-1234567" }], realSubmission: false };

it("동의 전에는 동의 카드, 승인 대기에는 동작 종류로만 만든 승인 카드를 준다", () => {
  expect(currentDecision({ ...base, consent: "ask" })).toMatchObject({ key: "consent", kind: "consent", choices: [{ key: "consent-yes" }, { key: "consent-no" }, { key: "review", open: "consent" }] });
  const approval = currentDecision({ ...base, state: "WAITING_FOR_USER_CONFIRMATION", last: turn({ pendingConfirmation: pending }) });
  expect(approval).toMatchObject({ key: "approval:a1", prompt: "입력란을 채울까요?", site: "복지로", ref: { actionId: "a1" } });
  expect(approval?.choices.map(c => c.label)).toEqual(["입력 승인", "내용 확인", "취소"]);
  expect(currentDecision({ ...base, sessionId: undefined, consent: "ask" })).toBeUndefined();
});

it("서버 제안은 인증 인계면 사이트 이름으로 묻고, 본문 읽기 하나면 그것을 묻는다", () => {
  const authHandoff = { id: "h1", taskId: "k", kind: "verification", status: "waiting", site: "정부24" };
  const offeredChoices = [{ key: "auth-done", label: "인증했어요" }, { key: "auth-cancel", label: "인증 취소" }];
  expect(currentDecision({ ...base, last: turn({ authHandoff, offeredChoices }) }))
    .toMatchObject({ key: "offer:t1", prompt: "정부24에서 직접 인증해 주세요.", ref: { turnId: "t1", handoffId: "h1" } });
  expect(currentDecision({ ...base, last: turn({ offeredChoices: [{ key: "read-main", label: "본문 읽기" }] }) })?.prompt).toBe("이 페이지의 본문을 읽어 드릴까요?");
  expect(currentDecision({ ...base, lang: "en", last: turn({ offeredChoices: [{ key: "read-main", label: "Read" }] }) })?.prompt).not.toBe("이 페이지의 본문을 읽어 드릴까요?");
});

it("아바타 카드에는 승인할 값과 목적이 실리지 않는다", () => {
  const ui = { ...base, state: "WAITING_FOR_USER_CONFIRMATION" as const, last: turn({ pendingConfirmation: pending }) };
  const decision = currentDecision(ui);
  if (decision === undefined) throw new Error("카드가 없다");
  const view = desktopView(ui, { ...live, card: { ...decision, id: "i-1" } });
  const text = JSON.stringify(view);
  expect(text).not.toContain("900101");
  expect(text).not.toContain("주민번호 입력");
  expect(text).not.toContain("actionId");
  expect(view).toMatchObject({ mode: "choice", choiceSetId: "i-1", prompt: "입력란을 채울까요?", site: "복지로", message: null });
});

it("응답 알림은 답 글을 옮기지 않고 앱이 정한 문장만 쓴다", () => {
  expect(turnNotice(turn({ speech: "김하늘 님의 주소를 입력했어요." }))).toBe("답변이 도착했어요. 저를 누르면 읽을 수 있어요.");
  expect(turnNotice(turn({ semanticAction: "stop" }))).toBeNull();
  expect(turnNotice(turn({ offeredChoices: [{ key: "read-main", label: "본문" }] }))).toBeNull();
  expect(turnNotice(turn({ semanticAction: "set-language", speech: "Language changed." }))).toBe("Language changed.");
  expect(turnNotice(turn({ state: "NEEDS_CLARIFICATION", publicSuggestions: ["장애인연금", "기초연금"] }))).toBe("1번 장애인연금, 2번 기초연금 중 어느 쪽인가요?");
  expect(turnNotice(turn({ state: "NEEDS_CLARIFICATION", publicSuggestions: ["장애인연금"] }))).toBe("“장애인연금” 말씀이세요?");
  expect(turnNotice(turn({ verification: { fieldValueMatches: true } }))).toBe("입력했어요. 다음 항목으로 가려면 “다음으로”라고 말씀해 주세요.");
});

it("한 줄 상태는 준비·종료·동의·인증·선택·문제·멈춤·처리·말하기·듣기 순서로 고른다", () => {
  const mode = (ui: Partial<ViewInput>, l: Partial<LiveView> = {}) => desktopView({ ...base, ...ui }, { ...live, ...l }).mode;
  expect(mode({ sessionId: undefined, consent: "loading" })).toBe("starting");
  expect(mode({ sessionId: undefined, consent: undefined })).toBe("ended");
  expect(mode({ sessionId: undefined, consent: undefined, error: "끊겼어요" })).toBe("problem");
  expect(mode({ consent: "intro", busy: true })).toBe("consent");
  expect(mode({ error: "오류" }, { sleeping: true })).toBe("problem");
  expect(mode({ busy: true }, { sleeping: true })).toBe("ready");
  expect(mode({ busy: true }, { speaking: true })).toBe("working");
  expect(mode({}, { speaking: true, recording: true })).toBe("speaking");
  expect(mode({}, { recording: true })).toBe("listening");
  const resting = desktopView(base, live);
  expect(resting).toMatchObject({ mode: "ready", resting: true, status: "기다리고 있어요." });
  expect(desktopView({ ...base, lang: "en" }, { ...live, message: { id: "m1", text: "Hi" } }).message).toEqual({ id: "m1", text: "Hi" });
  expect(desktopView(base, { ...live, sleeping: true, message: { id: "m1", text: "Hi" } })).toMatchObject({ sleeping: true, message: null, status: "멈췄어요." });
});
