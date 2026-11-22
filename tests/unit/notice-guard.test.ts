import { describe, expect, it } from "vitest";
import { ACTION_TYPES, type Action, type NativeGrant, type NoticeFacts, type NoticeProof } from "../../src/core/actions.ts";
import { NATIVE_SPOKEN_LIMIT, PolicyGuard, isNotice, nativeMessageRisk, type PolicyContext } from "../../src/safety/guard.ts";

// A2: 안내 팝업을 닫는 '확인'은 증명이 있을 때만 묻지 않는다. 증명이 없거나 어긋나면 지금처럼 묻는다(파이썬과 같은 행: tests/unit/policy.test.ts).
const MOCK = "http://localhost:5174";
const PAGE = "https://www.example.go.kr/notice";
const guard = new PolicyGuard({
  allowedOrigins: [MOCK], allowedActionTypes: ACTION_TYPES, allowedFieldIds: [], secretFieldIds: [], maxActionsPerTurn: 12,
  readOnlyWeb: true, readOnlyClicks: "safe",
});

function facts(over: Partial<NoticeFacts> = {}): NoticeFacts {
  const text = over.text ?? "서버 점검이 있어서 잠시 접속이 느릴 수 있어요. 확인";
  return {
    kind: "dialog", title: "점검 공지", buttons: ["확인"], buttonCount: 1, others: 0, hasInputs: false, popups: 1, signature: "sig-1",
    root: "r2-popup", shadows: 0, ...over, text, textLength: over.textLength ?? text.length,
  };
}
const click = (name = "확인", over: Partial<Action> = {}): Action => ({
  id: "a1", type: "click", target: { ref: "r1-aaaa", role: "button", name }, reason: "안내 팝업 닫기", risk: "low", requiresConfirmation: false, ...over,
});
const proof = (over: Partial<NoticeProof> = {}): NoticeProof => ({
  kind: "notice", url: PAGE, ref: "r1-aaaa", role: "button", name: "확인", facts: facts(), ...over,
});
const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({ currentUrl: PAGE, approvals: new Set<string>(), ...over });

describe("안내 팝업 증명", () => {
  it("증명이 없는 '확인'은 지금처럼 묻는다", () => {
    const decision = guard.check(click(), ctx());
    expect(decision).toMatchObject({ allowed: false, code: "NEEDS_CONFIRMATION" });
  });

  it("안내로 확인된 팝업의 '확인'은 묻지 않고 누른다", () => {
    expect(guard.check(click(), ctx({ notice: proof() }))).toMatchObject({ allowed: true, code: "ALLOWED_NOTICE" });
  });

  it("증명 없이 사용자가 승인한 '확인'은 지금처럼 승인으로 누른다", () => {
    expect(guard.check(click(), ctx({ approvals: new Set(["a1"]) }))).toMatchObject({ allowed: true, code: "APPROVED" });
  });

  const refused: [name: string, notice: NoticeProof][] = [
    ["단추가 둘인 팝업(확인·취소)", proof({ facts: facts({ buttons: ["확인", "취소"], buttonCount: 2 }) })],
    ["단추 이름이 다른 팝업", proof({ facts: facts({ buttons: ["닫기"] }) })],
    ["입력 칸이 있는 팝업", proof({ facts: facts({ hasInputs: true }) })],
    ["다른 조작 요소(링크 등)가 있는 팝업", proof({ facts: facts({ others: 1 }) })],
    ["신청 같은 낱말이 든 안내", proof({ facts: facts({ text: "신청 기간이 끝났어요. 확인" }) })],
    ["제목에 위험한 낱말이 든 안내", proof({ facts: facts({ title: "결제 안내" }) })],
    ["로그인·비밀번호를 말하는 안내", proof({ facts: facts({ text: "비밀번호를 바꾸세요. 확인" }) })],
    ["묻는 말투의 안내", proof({ facts: facts({ text: "계속 진행하시겠어요? 확인" }) })],
    ["글이 잘려 다 읽지 못한 안내", proof({ facts: facts({ textLength: 900 }) })],
    ["글 길이가 맞지 않는 안내", proof({ facts: facts({ textLength: 5 }) })],
    ["단추 말고 읽을 글이 없는 팝업", proof({ facts: facts({ text: "확인" }) })],
    ["서명이 빈 사실", proof({ facts: facts({ signature: "" }) })],
    ["팝업 몸통을 찾지 못한 사실", proof({ facts: facts({ root: "" }) })],
    ["닫힌 섀도 트리가 있는 팝업", proof({ facts: facts({ shadows: 1 }) })],
    ["섀도 트리를 확인하지 못한 팝업", proof({ facts: facts({ shadows: -1 }) })],
    ["떠 있는 팝업이 없다고 읽은 사실", proof({ facts: facts({ popups: 0 }) })],
    ["다른 ref의 증명", proof({ ref: "r9-zzzz" })],
    ["다른 이름의 증명", proof({ name: "닫기" })],
    ["다른 주소의 증명", proof({ url: "https://www.example.go.kr/other" })],
  ];
  it.each(refused)("묻는 쪽으로 남는다: %s", (_name, notice) => {
    expect(guard.check(click(), ctx({ notice }))).toMatchObject({ allowed: false, code: "NEEDS_CONFIRMATION" });
  });

  it("대상에 ref·역할·이름 말고 다른 지정이 붙으면 증명으로 인정하지 않는다", () => {
    const wider = click("확인", { target: { ref: "r1-aaaa", role: "button", name: "확인", nth: 0 } });
    expect(guard.check(wider, ctx({ notice: proof() }))).toMatchObject({ allowed: false, code: "NEEDS_CONFIRMATION" });
  });

  it("누르기가 아닌 조작에는 증명이 뜻이 없다", () => {
    const focus = click("확인", { type: "focus" });
    expect(guard.check(focus, ctx({ notice: proof() }))).toMatchObject({ allowed: true, code: "ALLOWED_READ_ONLY" });
    const select = click("확인", { type: "select", value: "예", target: { fieldId: "x", name: "확인" } });
    expect(guard.check(select, ctx({ notice: proof() })).code).not.toBe("ALLOWED_NOTICE");
  });

  it("로그인이라는 이름의 단추는 증명이 있어도 묻는다", () => {
    const login = click("로그인");
    const forged = proof({ name: "로그인", facts: facts({ buttons: ["로그인"], text: "서버 점검이 있어요. 로그인" }) });
    expect(guard.check(login, ctx({ notice: forged })).allowed).toBe(false);
  });

  it("신청·제출·삭제처럼 바로 거절하는 이름은 증명이 있어도 거절한다", () => {
    const hard = click("제출");
    const forged = proof({ name: "제출", facts: facts({ buttons: ["제출"], text: "서버 점검이 있어요. 제출" }) });
    expect(guard.check(hard, ctx({ notice: forged }))).toMatchObject({ allowed: false, code: "DENIED_READ_ONLY" });
  });

  it("링크·탭 같은 다른 역할은 증명으로 묻지 않는 길을 만들지 않는다", () => {
    const link = click("확인 안내", { target: { ref: "r1-aaaa", role: "scriptlink", name: "확인" } });
    const decision = guard.check(link, ctx({ notice: proof({ role: "scriptlink" }) }));
    expect(decision.code).not.toBe("ALLOWED_NOTICE");
  });

  it("정보 조회·화면 확인 범위에서는 증명을 보지 않는다", () => {
    expect(guard.check(click(), ctx({ notice: proof(), publicLookup: true })).allowed).toBe(false);
    const inspected = guard.check(click(), ctx({ notice: proof(), browsingScope: "personal-inspection" }));
    expect(inspected.allowed).toBe(false);
    expect(inspected.code).not.toBe("ALLOWED_NOTICE");
  });

  it("isNotice는 사실이 없거나 단추가 아닌 것을 안내로 보지 않는다", () => {
    expect(isNotice(undefined, { role: "button", name: "확인" })).toBe(false);
    expect(isNotice(facts(), { role: "link", name: "확인" })).toBe(false);
    expect(isNotice(facts(), { role: "button", name: "" })).toBe(false);
    expect(isNotice(facts(), { role: "button", name: "확인" })).toBe(true);
  });
});

describe("사이트의 confirm() 질문에 대신 답하는 허가", () => {
  const grant = (over: Partial<NativeGrant> = {}): NativeGrant => ({ tab: "t1", document: "1", url: PAGE, hash: "ab".repeat(32), length: 12, ...over });
  const approved = new Set(["a1"]);

  it("승인(ctx.granted)이 없으면 바로 누를 수 있는 이름이어도 허가만으로 답하지 않는다", () => {
    expect(guard.check(click("다음 쪽"), ctx({ native: grant() }))).toMatchObject({ allowed: false, code: "DENIED_NATIVE_BINDING" });
    expect(guard.check(click("다음 쪽"), ctx())).toMatchObject({ allowed: true, code: "ALLOWED_READ_ONLY" });
  });

  it("묻고 누르는 이름도 승인이 없으면 허가만으로 누르지 않는다", () => {
    expect(guard.check(click("확인"), ctx({ native: grant() }))).toMatchObject({ allowed: false, code: "DENIED_NATIVE_BINDING" });
  });

  it("처음 눌렀던 조작의 승인이 있을 때만 통과한다", () => {
    expect(guard.check(click("다음 쪽"), ctx({ native: grant(), approvals: approved }))).toMatchObject({ allowed: true });
    expect(guard.check(click("확인"), ctx({ native: grant(), approvals: approved }))).toMatchObject({ allowed: true, code: "APPROVED" });
    // 다른 조작의 승인은 이 조작에 쓰이지 않는다.
    expect(guard.check(click("다음 쪽"), ctx({ native: grant(), approvals: new Set(["other"]) }))).toMatchObject({ allowed: false, code: "DENIED_NATIVE_BINDING" });
  });

  it("허가의 주소가 지금 화면과 다르면 거절한다", () => {
    const decision = guard.check(click("다음 쪽"), ctx({ native: grant({ url: "https://www.example.go.kr/other" }), approvals: approved }));
    expect(decision).toMatchObject({ allowed: false, code: "DENIED_TASK_SCOPE" });
  });

  it("누르기가 아닌 조작과 지원 사이트·정보 조회·화면 확인 범위에서는 쓰지 않는다", () => {
    const base = { native: grant(), approvals: approved };
    expect(guard.check(click("다음 쪽", { type: "focus" }), ctx(base)).code).toBe("DENIED_TASK_SCOPE");
    expect(guard.check(click("다음 쪽"), ctx({ ...base, publicLookup: true })).code).toBe("DENIED_TASK_SCOPE");
    expect(guard.check(click("다음 쪽"), ctx({ ...base, browsingScope: "personal-inspection" })).code).toBe("DENIED_TASK_SCOPE");
    expect(guard.check(click("다음 쪽"), ctx({ ...base, currentUrl: MOCK + "/apply.html", native: grant({ url: MOCK + "/apply.html" }) })).code).toBe("DENIED_TASK_SCOPE");
  });

  it("안내 팝업 증명과 함께 쓰지 못한다", () => {
    expect(guard.check(click(), ctx({ native: grant(), notice: proof(), approvals: approved })).code).toBe("DENIED_TASK_SCOPE");
  });

  it("신청·제출처럼 거절하는 이름은 허가와 승인이 있어도 거절한다", () => {
    expect(guard.check(click("제출"), ctx({ native: grant(), approvals: approved }))).toMatchObject({ allowed: false, code: "DENIED_READ_ONLY" });
  });
});

describe("confirm() 질문의 분류", () => {
  it.each([
    ["다음 쪽으로 이동할까요?", "routine"],
    ["이 안내를 닫을까요?", "routine"],
    ["신청서를 제출하시겠습니까?", "consequential"],
    ["정말 삭제하시겠어요?", "consequential"],
    ["로그인 하시겠어요?", "consequential"],
    ["비밀번호를 다시 입력하세요", "consequential"],
    ["개인 정보가 함께 전송됩니다. 계속할까요?", "consequential"],
    ["설정을 초기화할까요?", "consequential"],
  ] as const)("%s → %s", (message, risk) => {
    expect(nativeMessageRisk(message)).toBe(risk);
  });

  it("소리로 다 읽어 줄 수 없게 길면 앞부분이 무엇이든 대신 답하지 않는다", () => {
    expect(nativeMessageRisk("가".repeat(NATIVE_SPOKEN_LIMIT))).toBe("routine");
    expect(nativeMessageRisk("가".repeat(NATIVE_SPOKEN_LIMIT + 1))).toBe("long");
    // 앞 200자는 평범해도 뒤에 신청·삭제가 숨어 있을 수 있다.
    expect(nativeMessageRisk("가".repeat(NATIVE_SPOKEN_LIMIT) + " 삭제합니다")).toBe("long");
  });
});
