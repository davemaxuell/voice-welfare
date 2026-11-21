import { expect, it } from "vitest";
import { nativeSpeech, noticeKey, noticeSaid, noticeSpeech, questionSpeech } from "../../src/agents/web/notice.ts";
import type { NativeDialogRecord, NoticeFacts } from "../../src/core/actions.ts";

// A2: 묻지 않고 닫은 안내와 취소한 사이트의 질문을 사용자에게 알리는 말은 코드가 만든다.
function facts(text: string, title = "점검 공지"): NoticeFacts {
  return { kind: "dialog", title, text, textLength: text.length, buttons: ["확인"], buttonCount: 1, others: 0, hasInputs: false, popups: 1, signature: "sig", root: "r2-popup", shadows: 0 };
}
const record = (over: Partial<NativeDialogRecord> = {}): NativeDialogRecord => ({
  tab: "t", document: "1", url: "https://www.example.go.kr/", hash: "h", length: 12, actionId: "a1", preview: "다음 쪽으로 이동할까요?", risk: "routine", ...over,
});

it("닫은 안내의 제목과 내용을 단추 이름 없이 돌려준다", () => {
  expect(noticeSaid(facts("점검 공지 서버 점검이 있어요. 확인"), "확인")).toEqual({ title: "점검 공지", text: "서버 점검이 있어요." });
  // 제목이 없는 안내는 글 전체가 내용이다.
  expect(noticeSaid(facts("서버 점검이 있어요. 확인", ""), "확인")).toEqual({ title: "", text: "서버 점검이 있어요." });
});

it("짧게 듣는 설정에서도 첫 문장에서 사이트 질문의 선택지를 모두 들을 수 있다", () => {
  const speech = questionSpeech({title: "목록 선택", text: "새 목록이 있어요. 다음 목록을 볼까요?", choices: ["확인", "취소"], cut: false, dialogIndex: 0});
  expect(speech.split(".")[0]).toContain("'확인', '취소'");
  expect(speech).toContain("다음 목록을 볼까요?");
});

it("단추 이름과 같은 말이 본문에 있으면 맨 뒤의 단추만 뺀다", () => {
  expect(noticeSaid(facts("점검 공지 내용을 확인해 주세요. 확인"), "확인").text).toBe("내용을 확인해 주세요.");
});

it("안내 문장은 장애인연금 연습 신청서에서 쓰던 말을 따른다", () => {
  expect(noticeSpeech([{ title: "점검 공지", text: "서버 점검이 있어요." }]))
    .toBe("안내 팝업 '점검 공지'가 떠서 닫았어요. 내용은 서버 점검이 있어요.");
  // 받침 있는 제목은 '이'로 받는다.
  expect(noticeSpeech([{ title: "안내문", text: "" }])).toBe("안내 팝업 '안내문'이 떠서 닫았어요.");
  expect(noticeSpeech([{ title: "", text: "서버 점검이 있어요" }])).toBe("안내 팝업이 떠서 닫았어요. 내용은 서버 점검이 있어요.");
  expect(noticeSpeech([])).toBe("");
  expect(noticeSpeech([{ title: "하나", text: "첫째." }, { title: "둘", text: "둘째." }])).toContain("첫째. 안내 팝업 '둘'이 떠서");
});

it("안내의 글에 든 민감한 값은 비식별화해서 읽는다", () => {
  const said = noticeSaid(facts("점검 공지 조회 번호 900101-1234567 을 확인해 주세요. 확인"), "확인");
  expect(said.text).not.toContain("1234567");
  expect(noticeSpeech([said])).not.toContain("1234567");
});

it("같은 안내인지는 출처와 제목·글로 가린다", () => {
  const same = { title: "점검 공지", text: "서버 점검이 있어요." };
  expect(noticeKey("https://a.example", same)).toBe(noticeKey("https://a.example", { ...same }));
  expect(noticeKey("https://a.example", same)).not.toBe(noticeKey("https://b.example", same));
  expect(noticeKey("https://a.example", same)).not.toBe(noticeKey("https://a.example", { ...same, text: "다른 내용이에요." }));
});

it("대신 답해도 되는 질문은 알리고 진행할지 묻는다", () => {
  expect(nativeSpeech({ record: record(), answerable: true, count: 1 })).toBe(
    "사이트가 '다음 쪽으로 이동할까요?'라고 물어서 아직 진행하지 않았어요. 진행할까요? 진행하려면 '진행해', 그만두려면 '거절'이라고 말씀해 주세요.");
});

it("대신 답하면 안 되는 질문은 묻지 않고 직접 하시게 알린다", () => {
  const important = nativeSpeech({ record: record({ preview: "정말 삭제하시겠어요?", risk: "consequential" }), answerable: false, count: 1 });
  expect(important).toContain("'정말 삭제하시겠어요?'라고 물었어요");
  expect(important).toContain("제가 대신 답하지 않았어요");
  expect(important).not.toContain("진행할까요");
  const long = nativeSpeech({ record: record({ preview: "가".repeat(200), risk: "long", length: 250 }), answerable: false, count: 1 });
  expect(long).toContain("긴 안내문");
  expect(long).not.toContain("진행할까요");
  const several = nativeSpeech({ record: record(), answerable: false, count: 2 });
  expect(several).toContain("여러 번");
  expect(several).not.toContain("진행할까요");
});

it("질문에 든 민감한 값도 비식별화해서 읽는다", () => {
  const said = nativeSpeech({ record: record({ preview: "900101-1234567로 조회할까요?" }), answerable: true, count: 1 });
  expect(said).not.toContain("1234567");
});
