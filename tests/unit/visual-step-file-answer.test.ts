import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, expect, it } from "vitest";
import { answerFile, readForUpload } from "../../src/agents/web/file_answer.ts";
import { choices } from "../../src/agents/web/visual_step.ts";
import { DocumentLimit } from "../../src/agents/web/docs.ts";
import type { WebObservation } from "../../src/agents/web/view.ts";
import type { LlmRequest } from "../../src/core/llm.ts";
import { redactText } from "../../src/safety/privacy.ts";

// 기대값은 pyref(77aad3e)의 visual_step.choices를 같은 화면에 돌린 결과다.
const item = (ref: string, role: "link" | "button" | "tab" | "menuitem" | "generic", name: string, region: "main" | "menu" | "other", disabled = false) =>
  ({ ref, role, name, region, disabled });
const view: WebObservation = {
  url: "https://example.kr/a", title: "안내", fields: [], errors: [], dialogs: [],
  outline: { mainText: "안내 본문", items: [
    item("r1", "link", "자세히", "menu"), item("r2", "link", "자세히", "main"), item("r3", "button", "신청하기", "main"),
    item("r4", "tab", "지원 대상", "other"), item("r5", "link", "문의 010-1234-5678", "main"), item("r6", "generic", "그림", "main"),
    item("r7", "menuitem", "복지 서비스", "menu"), item("r8", "link", "닫힘", "main", true), item("r9", "link", "공지", "main"),
  ] },
};
const url = "https://example.kr/a";

it("사진으로 고를 이동용 조작은 Python과 같은 순서와 이름만 남긴다", () => {
  expect([...choices(view)?.controls ?? []]).toEqual([["공지", [url, "r9", "link"]], ["지원 대상", [url, "r4", "tab"]], ["복지 서비스", [url, "r7", "menuitem"]]]);
  expect([...choices(view, ["공지", "지원 대상"])?.controls.keys() ?? []]).toEqual(["공지", "지원 대상"]);
  expect(choices({ ...view, title: "로그인" })).toBeUndefined();
});

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function saved(name: string, content: Uint8Array | string) {
  const folder = mkdtempSync(join(tmpdir(), "cheongeum-file-answer-"));
  folders.push(folder);
  const path = join(folder, name);
  writeFileSync(path, content);
  return { name, path };
}
const hwpx = (text: string) => zipSync({ "Contents/section0.xml": strToU8(`<r><t>${text}</t></r>`) });
const signal = new AbortController().signal;
const model = (reply: unknown, sent: LlmRequest[] = []) => ({ name: "fake", generate: async (request: LlmRequest) => { sent.push(request); return reply; } });

it("받은 파일의 답은 원문에 근거가 있을 때만 말하고 그림 답에는 주의를 붙인다", async () => {
  const record = saved("안내.hwpx", hwpx("기초연금 문의는 129입니다."));
  const [data] = await readForUpload(record);
  const sent: LlmRequest[] = [];
  const question = redactText("문의처 알려줘");
  expect(await answerFile(model({ answer: "129로 문의하세요.", evidence: ["기초연금 문의는 129입니다."] }, sent), record, data, question, signal, "ko"))
    .toEqual(["129로 문의하세요.", "ko"]);
  expect(JSON.parse(sent[0]?.user ?? "{}")).toEqual({ question: "문의처 알려줘", document: "기초연금 문의는 129입니다." });
  expect(await answerFile(model({ answer: "130으로 하세요.", evidence: ["없는 문장"] }), record, data, question, signal, "ko"))
    .toEqual(["파일의 원문에서 답의 근거를 확인하지 못했어요.", "ko"]);
  expect(await answerFile(model({ answer: " ", evidence: [] }), record, data, question, signal, "ko")).toEqual(["이 파일에서 답을 확인하지 못했어요.", "ko"]);
  expect(await answerFile(model("x"), record, data, question, signal, "ko"))
    .toEqual(["파일 분석에 실패했어요. 파일을 읽을 수 있는 모델인지 설정을 확인해 주세요.", "ko"]);
  const image = saved("사진.png", "png");
  const [bytes] = await readForUpload(image);
  expect(await answerFile(model({ answer: "안내문이에요.", evidence: [] }), image, bytes, question, signal, "en"))
    .toEqual(["AI read this image and may have made a mistake. 안내문이에요.", "en"]);
});

it("받을 수 없는 파일은 이유를 말한다", async () => {
  await expect(readForUpload(saved("a.txt", "x"))).rejects.toThrow(DocumentLimit);
  await expect(readForUpload(saved("a.pdf", ""))).rejects.toThrow("파일이 비어 있어요.");
  const broken = saved("깨진.hwpx", "not a zip");
  const [data] = await readForUpload(broken);
  expect(await answerFile(model({}), broken, data, redactText("요약"), signal, "ko")).toEqual(["파일을 열지 못했어요. 손상되었거나 암호가 걸려 있을 수 있어요.", "ko"]);
});
