// 네 언어 화면 글: 작업 칸 낱말표(workspace-language.ts)와 첫 실행·설정·동의 안내(onboarding.ts).
import { expect, it } from "vitest";
import { fullGuide, keyHint, onboardingText, saveLabel } from "../../web/src/onboarding.ts";
import { workspaceText } from "../../web/src/workspace-language.ts";

it("작업 칸 글은 영어·중국어·일본어로 바꾸고, 한국어와 낱말표에 없는 글은 그대로 둔다", () => {
  const text = "링크 목록 알려줘";
  expect([workspaceText(text, "en"), workspaceText(text, "zh"), workspaceText(text, "ja"), workspaceText(text, "ko")])
    .toEqual(["List the links on this page.", "请列出这个页面的链接。", "このページのリンクを教えてください。", text]);
  expect(workspaceText("낱말표에 없는 글", "en")).toBe("낱말표에 없는 글");
  expect(workspaceText(text, undefined)).toBe(text);
  expect(workspaceText("constructor", "en")).toBe("constructor");
  expect(workspaceText(text, "toString")).toBe(text);
});

it("이름표 글은 그 언어 문구를 쓰고, 한국어처럼 문구가 없으면 화면의 원문을 쓴다", () => {
  expect(onboardingText("en", "title", "청음 이용 설정")).toBe("Cheongeum settings");
  expect(onboardingText("ko", "title", "청음 이용 설정")).toBe("청음 이용 설정");
  expect(onboardingText("fr", "title", "청음 이용 설정")).toBe("청음 이용 설정");
  expect(keyHint("ko", "saved")).toBe("설정된 키가 있어요. 교체할 때만 새 키를 입력하세요.");
  expect(keyHint("ja", undefined)).toBe("");
  expect([saveLabel("ko", false), saveLabel("ko", true), saveLabel("zh", true)]).toEqual(["저장하고 시작", "저장하고 대화 계속하기", "保存并继续"]);
});

it("외국어 안내 전문은 설정한 음성·인공지능·키 입력 방법에 맞춰 이어 붙인다", () => {
  const voice = { stt: true, tts: true, edge: "gpt-live", llmRoles: { understand: "gpt-5.5", goal: "gpt-5.5", web: "rules", vision: "disabled" } };
  const guide = fullGuide("en", voice, false, "Control");
  expect(guide).toContain("Audio and spoken replies use your speech API.");
  expect(guide).toContain("Starting a live voice call sends a short excerpt");
  expect(guide).toContain("Questions and page text may be sent to these configured services (gpt-5.5).");
  expect(guide).not.toContain("full-page screenshot");
  expect(guide.endsWith("Press Enter to agree or Escape to decline.")).toBe(true);
  const typed = fullGuide("ja", { stt: false, tts: false, llmRoles: {} }, true, "Command");
  expect(typed).toContain("文字で質問できます。");
  expect(typed).toContain("文字の指示はこのパソコンで処理します。");
  expect(typed.endsWith("同意するには Command、Shift、スペースを同時に押してください。同意しない場合はチョンウムのメニューから終了してください。")).toBe(true);
  expect(fullGuide("ko", voice, false, "Control")).toBe("");
});
