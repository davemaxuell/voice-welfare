// 대화 창 상태 → 보일 것(view.ts). Python app.js render()가 하던 판단을 화면 없이 확인한다.
import { expect, it } from "vitest";
import { TurnSchema } from "../../web/src/api.ts";
import { consentText, viewOf, type UiState } from "../../web/src/view.ts";

const env = { background: false, mac: false };
function ui(patch: Partial<UiState> = {}): UiState {
  return {
    state: "IDLE", lang: "ko", busy: false, hasTurn: false, practiceMode: false, workspaceAvailable: false, settingsAvailable: false,
    listening: false, voiceMode: { known: true, stt: true, tts: true, label: "", llmRoles: {} }, tts: true, contrast: false,
    phase: "off", baseSpeed: 1.35, consent: "granted", mics: [], speaking: false, cardTaken: false, sessionNew: false,
    checkingMic: false, micCheckResult: "", edge: false, conversationMode: "native", liveCaption: "", messages: [],
    announcement: { text: "", seq: 0 }, sessionId: "s1", ...patch,
  };
}
function turn(patch: Record<string, unknown> = {}) {
  return TurnSchema.parse({
    sessionId: "s1", turnId: "t1", userUtterance: "말", intentType: "X", state: "BROWSING", semanticAction: "read",
    speech: "답", actions: [], sources: [], ...patch,
  });
}

it("동의 전에는 동의 화면을 보이고, 세션이 생겨야 안내 듣기를 누를 수 있다", () => {
  const intro = viewOf(ui({ consent: "intro" }), env);
  expect(intro.stage).toBe("onboarding");
  expect(intro.consent).toMatchObject({ hear: true, hearDisabled: false, ask: false });
  expect(viewOf(ui({ consent: "intro", sessionId: undefined }), env).consent?.hearDisabled).toBe(true);
  expect(viewOf(ui({ consent: "ask" }), env).consent).toMatchObject({ hear: false, ask: true });
  expect(viewOf(ui(), env).consent).toBeUndefined();
});

it("음성 키가 없으면 동의 뒤 받아쓰기 안내를 보이고 대화 시작과 음성 입력을 막는다", () => {
  const v = viewOf(ui({ voiceMode: { known: true, stt: false, tts: false, label: "", llmRoles: {} } }), env);
  expect(v.stage).toBe("ready");
  expect(v.command.dictation).toBe("음성 입력과 안내를 쓰려면 이용 설정에 OpenAI API 키를 등록해 주세요. 글로도 질문할 수 있어요.");
  expect(v.conversation.startDisabled).toBe(true);
  expect(v.command.micDisabled).toBe(true);
  expect(v.tts.disabled).toBe(true);
  expect(viewOf(ui(), env).command.dictation).toBeUndefined();
});

it("첫 응답이 오면 시작 화면 대신 작업 화면이 되고, 거절한 사람에게는 정보 질문 예시만 보인다", () => {
  expect(viewOf(ui({ hasTurn: true }), env).stage).toBe("active");
  const declined = viewOf(ui({ consent: "declined" }), env).starters;
  expect(declined.filter(s => !s.hidden).map(s => s.label)).toEqual(["장애인연금 알아보기", "지원 대상 알아보기", "준비 서류 알아보기"]);
  expect(viewOf(ui({ busy: true }), env).starters.every(s => s.disabled)).toBe(true);
});

it("승인 대기면 동작 종류에 맞는 승인 단추와 카드 번호를 쓰고, 보내는 중인 카드는 누를 수 없다", () => {
  const pendingConfirmation = { actionId: "a1", kind: "click", purpose: "다음 쪽", site: "복지로", values: [], realSubmission: false };
  const card = { key: "approval:a1", kind: "approval" as const, prompt: "", choices: [], ref: { actionId: "a1" }, id: "x-1", lang: "ko" };
  const v = viewOf(ui({ state: "WAITING_FOR_USER_CONFIRMATION", last: turn({ state: "WAITING_FOR_USER_CONFIRMATION", pendingConfirmation }), card }), env);
  expect(v.confirm).toMatchObject({ approveLabel: "누르기 승인", edit: false, purpose: "다음 쪽", site: "복지로" });
  expect(v.confirmCard).toBe("x-1");
  expect(v.decisionDisabled).toBe(false);
  const practice = { ...pendingConfirmation, kind: "practice-submission", description: "모의 접수만 해요." };
  expect(viewOf(ui({ state: "WAITING_FOR_USER_CONFIRMATION", last: turn({ pendingConfirmation: practice }), card, cardTaken: true }), env))
    .toMatchObject({ confirm: { approveLabel: "모의접수 승인", edit: true, hint: "모의 접수만 해요." }, decisionDisabled: true });
  expect(viewOf(ui({ last: turn({ pendingConfirmation }) }), env).confirm).toBeUndefined();
});

it("본문 읽기는 제안된 카드 번호와 단추 문구를 그대로 사용한다", () => {
  const card = { id: "shown", key: "offer:t", lang: "ko", kind: "offer" as const,
    ref: { turnId: "t" }, prompt: "", choices: [{ key: "read-main", label: "이 페이지의 본문 읽기" }] };
  expect(viewOf(ui({ card }), env).readMain).toEqual({ id: "shown", label: "이 페이지의 본문 읽기" });
  expect(viewOf(ui(), env).readMain).toBeUndefined();
});

it("본인인증 인계 중에는 마이크·대화 시작·마이크 확인을 막고 인증 단추를 보인다", () => {
  const authHandoff = { id: "h1", taskId: "k", kind: "login", status: "waiting", site: "정부24" };
  const v = viewOf(ui({ state: "AUTH_HANDOFF", last: turn({ state: "AUTH_HANDOFF", authHandoff }) }), env);
  expect(v.auth).toEqual({ cardId: "t1", viaCard: false, doneLabel: "직접 확인을 마쳤어요" });
  expect([v.command.micDisabled, v.conversation.startDisabled, v.micCheckDisabled]).toEqual([true, true, true]);
  expect(v.recordingOwner).toBeUndefined();
});

it("입력 항목은 화면 낭독기가 듣던 문장을 그대로 남기고 상태를 따로 표시한다", () => {
  const fields = [
    { label: "이름", type: "text", visible: true, required: true, filled: true, sensitive: false, invalid: false, value: "김하늘" },
    { label: "주민번호", type: "text", visible: true, required: true, filled: false, sensitive: true, invalid: true },
    { label: "숨김", type: "text", visible: false, required: false, filled: false, sensitive: false, invalid: false },
    { label: "동의", type: "checkbox", visible: true, required: false, filled: false, sensitive: false, invalid: false },
  ];
  const step = { index: 2, total: 4, name: "기본 정보" };
  const v = viewOf(ui({ last: turn({ observation: { title: "신청서", fields, step }, accessMode: "full" }) }), env);
  expect(v.status.fields.map(f => f.name + f.between + f.value + f.after)).toEqual(["이름 (필수) — 입력됨: 김하늘", "주민번호 (필수) — 직접 입력 항목 · 오류"]);
  expect(v.status.fields.map(f => f.state)).toEqual(["filled", "invalid"]);
  expect(v.status).toMatchObject({ step: "2/4 — 기본 정보", title: "신청서", access: "지원 사이트(연습 신청 가능)", progress: { max: 4, value: 2, ratio: 0.5 } });
});

it("실행 내역은 성공·실패·차단을 나누고, 답변 카드의 출처는 근거 자료에서 뺀다", () => {
  const actions = [
    { action: { id: "1", reason: "열기" }, policy: { allowed: true, reason: "" }, result: { ok: true } },
    { action: { id: "2", reason: "누르기" }, policy: { allowed: true, reason: "" }, result: { ok: false, errorCode: "TIMEOUT" } },
    { action: { id: "3", reason: "제출" }, policy: { allowed: false, reason: "제출 금지" } },
  ];
  const source = { title: "보건복지부", url: "https://www.mohw.go.kr", lastCheckedAt: "2026-11-01" };
  const other = { title: "복지로", url: "https://www.bokjiro.go.kr", lastCheckedAt: "2026-11-02" };
  const answerCard = { answer: "월 최대 43만 원", serviceName: "장애인연금", grounded: true, source, dataKind: "stored", dataOrigin: "fixture", nextAction: "129에 문의" };
  const v = viewOf(ui({ last: turn({ actions, sources: [source, other], answerCard }) }), env);
  expect(v.actions.map(a => [a.result, a.state, a.resultIsWords])).toEqual([["성공", "ok", true], ["실패(TIMEOUT)", "failed", false], ["차단: 제출 금지", "blocked", false]]);
  expect(v.sources).toEqual([other]);
  expect(v.answer).toMatchObject({ origin: "연습용 예시 · 저장된 자료", date: "자료에 기준일 없음", next: "129에 문의" });
});

it("대화가 꺼져 있어도 녹음·안내·처리 중이면 단계 표시가 그것을 알린다", () => {
  expect(viewOf(ui({ listening: true }), env).conversation).toMatchObject({ phase: "listening", phaseLabel: "음성 입력: 듣고 있어요" });
  expect(viewOf(ui({ speaking: true }), env).conversation).toMatchObject({ phase: "speaking", phaseLabel: "음성 안내 중" });
  expect(viewOf(ui({ busy: true }), env).conversation).toMatchObject({ phase: "thinking", phaseLabel: "요청을 처리하고 있어요" });
  expect(viewOf(ui({ phase: "hearing" }), env).command.talkLabel).toBe("말 끝 (바로 보내기)");
  expect(viewOf(ui({ phase: "hearing", edge: true }), env).command.talkLabel).toBe("듣는 중 — 말씀하세요");
});

it("녹음 파일 받아쓰기와 자료 조사 칸은 동의하고 쓸 수 있을 때만 세션을 받는다", () => {
  expect(viewOf(ui(), env).recordingOwner).toBe("s1");
  expect(viewOf(ui({ state: "STOPPED" }), env).recordingOwner).toBeUndefined();
  expect(viewOf(ui({ consent: "declined" }), env).recordingOwner).toBeUndefined();
  expect(viewOf(ui(), env).workspaceOwner).toBeUndefined();
  expect(viewOf(ui({ workspaceAvailable: true }), env).workspaceOwner).toBe("s1");
  expect(viewOf(ui({ workspaceAvailable: true, recovery: { choice: "resume", title: "", message: "", yes: "", no: "", busy: false } }), env).workspaceOwner).toBeUndefined();
});

it("동의 안내는 화면 사진·외부 인공지능·키 입력 방법을 설정대로 말한다", () => {
  const roles = { understand: "gpt-5.5", goal: "rules", web: "mock-rule", vision: "disabled" };
  const text = consentText(ui({ consent: "ask", voiceMode: { known: true, stt: false, tts: false, label: "", llmRoles: roles } }), env);
  expect(text).toContain("이 설정에서는 웹페이지를 글로 읽어 드립니다.");
  expect(text).toContain("글 이해에 쓰는 인공지능은 역할마다 다를 수 있어요. 말씀 이해은 gpt-5.5.");
  expect(text.endsWith("동의하시면 Enter를, 동의하지 않으시면 Escape를 눌러 주세요.")).toBe(true);
  expect(consentText(ui({consent: "intro"}), { background: true, mac: true })).toContain("커맨드, 시프트, 스페이스 키를 함께 눌러 주세요.");
  expect(consentText(ui(), env)).not.toContain("동의하시면 Enter");
  expect(consentText(ui({ lang: "en" }), env)).toMatch(/^Cheongeum opens the website you request/);
});

it("shows the session's localized backend status in the conversation, including during Live listening", () => {
  expect(viewOf(ui(), env).conversation.backendStatus).toBe("");
  const backendStatus = "公式サイトの案内を確認しています。";
  expect(viewOf(ui({ lang: "ja", phase: "listening", edge: true, backendStatus }), env).conversation.backendStatus).toBe(backendStatus);
});
