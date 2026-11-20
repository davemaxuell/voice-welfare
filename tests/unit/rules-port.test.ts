import { expect, it } from "vitest";
import { isExactCommand } from "../../src/understanding/fastpath.ts";
import {
  afterProgressQuestion, downloadMode, isPictureRequest, isStopUtterance, wantsTextOnlyScreen,
} from "../../src/understanding/rules.ts";

// 기대값은 77aad3e의 Python understanding/rules.py와 fastpath.py로 계산했다.
it("사진을 보내지 말라는 말은 여러 언어에서 글로만 읽게 한다", () => {
  for (const [text, textOnly] of [
    ["사진 없이 글로만 읽어줘", true], ["캡처하지 마", true], ["글로만 알려줘", true], ["text only please", true],
    ["Without İt the screenshot", true], ["please don't take a screenshot", true], ["不要截图", true], ["别发截图", true],
    ["スクショなしで", true], ["テキストだけ", true], ["사진으로 설명해줘", false], ["", false], ["No SCREENSHOT", true],
    ["avoid page İmage", true], ["only read the text", true],
  ] as const) expect(wantsTextOnlyScreen(text), text).toBe(textOnly);
});

it("받은 파일 명령을 목록·그대로 읽기·분석으로 나눈다", () => {
  for (const [text, mode] of [
    ["받은 파일 읽어줘", "read"], ["받은 파일 목록", "list"], ["받은 파일 요약해줘", "analyze"], ["받은 PDF에서 신청 기한이 언제야?", "analyze"],
    ["pdf 원문 그대로 들려줘", "read"], ["화면 사진 설명해줘", undefined], ["이미지 파일 보여줘", undefined], ["이 문서에 뭐야?", "analyze"],
    ["어떤 파일 받았어", "list"], ["다운로드 버튼 눌러줘", undefined], ["hwpx 요약해줘", "analyze"], ["그 사진에 뭐 있어?", undefined],
    ["내려받은 이미지 설명해줘", "analyze"], ["", undefined],
  ] as const) expect(downloadMode(text), text).toBe(mode);
});

it("진행 상황 물음 뒤에 따로 붙은 요청만 떼어 낸다", () => {
  for (const [text, rest] of [
    ["지금 어디까지 했어? 그리고 본문 읽어줘", "본문 읽어줘"], ["청음아, 얼마나 남았어? 다음으로", "다음으로"], ["얼마나 남았어", undefined],
    ["어디까지 했어요. 그다음 멈춰", "멈춰"], ["뭐 하고 있어 화면 설명해줘", "화면 설명해줘"], ["아직 멀었어?   ", undefined],
    ["언제 끝나 그리고 ", "그리고"], ["", undefined],
  ] as const) expect(afterProgressQuestion(text), text).toBe(rest);
});

it("사진 요청은 전체 발화가 사진을 거절하지 않을 때만 받는다", () => {
  for (const [text, utterance, picture] of [
    ["화면 사진으로 설명해줘", undefined, true], ["화면 사진으로 설명해줘", "화면 사진으로 설명해줘 그리고 사진 보내지 마", false],
    ["스크린샷으로 차트의 추세를 알려줘", undefined, true], ["페이지 전체를 캡처해서 접수 기한을 알려줘", undefined, true],
    ["화면 설명해줘", undefined, false], ["지금 화면 사진 찍어서 보여줘?", undefined, true], ["화면 사진으로 설명해줘", "", true],
  ] as const) expect(isPictureRequest(text, { utterance }), text).toBe(picture);
});

it("멈춤은 절마다 전체가 멈춤 말일 때만이고 취소를 묻기만 하면 멈추지 않는다", () => {
  for (const [text, stop] of [
    ["청음아, 취소?", false], ["취소? 아니, 멈춰", true], ["please stop now", true], ["could you cancel?", true], ["cancel?", false],
    ["Stop talking please", true], ["PAUSE", true], ["잠깐만요", true], ["멈춰 줘요", true], ["하던 일을 그만해", true], ["停一下吧", true],
    ["今すぐ止めてください", true], ["신청 취소 방법을 알려줘", false], ["", false], ["stop it", true], ["ſtop", true], ["멈추지 마", false],
  ] as const) expect(isStopUtterance(text), text).toBe(stop);
});

it("등록된 조작 명령과 기관 열기만 공공업무 계획을 건너뛴다", () => {
  for (const [text, exact] of [
    ["복지로 열어줘", true], ["정부24로 가줘", true], ["멈춰", true], ["기초연금은 몇 살부터 받아?", false], ["본문 읽어줘", true],
    ["네이버 열어줘", false], ["한국장학재단으로 가줘", true], ["화면 설명해줘!", true],
  ] as const) expect(isExactCommand(text), text).toBe(exact);
});
