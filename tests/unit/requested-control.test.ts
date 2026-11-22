import { expect, it } from "vitest";
import { ExecContext } from "../../src/agents/web/agent.ts";
import { redactText } from "../../src/safety/privacy.ts";
import { confirmsClick, PolicyGuard } from "../../src/safety/guard.ts";
import { decisionReply } from "../../src/understanding/decision_reply.ts";
import { interactionLimit, requestedControl } from "../../src/understanding/rules.ts";

it("여러 단계의 마지막 실행 요청은 사용자가 말한 항목에만 적용한다", () => {
  const context = new ExecContext({actor: "goal", requestedControl: requestedControl("설정을 열고 알림 저장해 주세요"),
    signal: new AbortController().signal, isStopped: () => false, trace() {}});
  expect(context.requested("알림 저장")).toBe(true);
  expect(context.requested("계정 삭제")).toBe(false);
  expect(requestedControl("알림 저장 방법이 뭐야?")).toBeUndefined();
});

it("사이트 확인창의 목적과 범위가 원래 요청과 일치하는지 확인한다", () => {
  expect(confirmsClick("계속할까요?", "다음", false)).toBe(true);
  expect(confirmsClick("신청서를 제출하시겠습니까?", "신청서 제출", true)).toBe(true);
  expect(confirmsClick("모든 신청서를 제출할까요?", "신청서 제출", true)).toBe(false);
  expect(confirmsClick("새 소식도 이메일로 받아 보시겠어요?", "다음", true)).toBe(false);
  expect(confirmsClick("Do you want to delete your account?", "View details", true)).toBe(false);
});

it("탐색 목표만 받은 모델은 링크나 버튼으로 계정 상태를 바꿀 수 없다", () => {
  const guard = new PolicyGuard({allowedOrigins: ["https://known.example"], allowedActionTypes: ["click"],
    allowedFieldIds: [], secretFieldIds: [], readOnlyWeb: true, directActions: true, maxActionsPerTurn: 12});
  for (const currentUrl of ["https://known.example", "https://another.example"]) {
    for (const role of ["button", "link"]) {
      for (const name of ["계정 변경", "계정 삭제"]) {
        const click = {type: "click", id: "named-click", target: {ref: "r1", name, role}, reason: "목표 탐색", risk: "low", requiresConfirmation: false};
        expect(guard.check(click, {currentUrl, userCommand: false}).allowed).toBe(false);
        expect(guard.check(click, {currentUrl, userCommand: true}).allowed).toBe(true);
      }
    }
  }
});

it("현재 제안에 답한 부탁과 거절은 모델 없이 처리하고, 질문과 새 명령은 구별한다", async () => {
  const reply = (text: string) => decisionReply(redactText(text), "ko", undefined, new AbortController().signal);
  expect(await reply("네, 그렇게 해 주세요.")).toBe("approve");
  expect(await reply("그대로 진행해 주시겠어요?")).toBe("approve");
  expect(await reply("네, 그 버튼은 누르셔도 괜찮아요.")).toBe("approve");
  expect(await reply("그 링크 열어도 돼요")).toBe("approve");
  expect(await reply("눌러도 될까요")).toBeUndefined();
  expect(await reply("그건 열지 말아 주세요")).toBe("reject");
  expect(await reply("네?")).toBeUndefined();
  expect(await reply("아니, 다른 기관을 열어줘")).toBeUndefined();
});

it("조작을 허락하는 평서문과 허락을 묻는 질문을 구별한다", () => {
  expect(interactionLimit("알림 저장 버튼을 눌러도 돼요.")).toBeUndefined();
  expect(interactionLimit("알림 저장 버튼을 눌러도 돼요?")).toBe("question");
  expect(interactionLimit("알림 저장 버튼을 눌러도 될까요")).toBe("question");
  expect(interactionLimit("알림 저장 버튼을 눌러도 되는지 알려줘")).toBe("question");
});
