import type { Browser } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { PlaywrightExecutionAdapter, launchBrowser, stopPlaywright } from "../../src/agents/web/browser/index.ts";

// A1: 관찰에 팝업 사실(dialogs[].kind·hasInputs, outline.items[].dialog)이 들어간다. 이 파일은 사실만 확인하고 동작은 바꾸지 않는다.
let browser: Browser;
const adapters: PlaywrightExecutionAdapter[] = [];
beforeAll(async () => { browser = await launchBrowser(true); });
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });
afterAll(() => stopPlaywright());

const frame = (popups: string) => "<!doctype html><html lang=\"ko\"><head><title>팝업 사실</title></head><body>"
  + "<main><h1>복지 안내</h1><p>이 화면은 팝업 사실을 확인하는 시험 화면입니다.</p><button type=\"button\">신청 안내 보기</button></main>"
  + popups + "</body></html>";

async function observe(popups: string) {
  const adapter = new PlaywrightExecutionAdapter({ browser, allowedOrigins: [], readOnlyWeb: true });
  adapters.push(adapter);
  await adapter.start();
  if (adapter.page === undefined) throw new Error("Missing browser page");
  await adapter.page.setContent(frame(popups));
  const observation = await adapter.observe();
  const items = observation.outline?.items ?? [];
  const named = (name: string) => {
    const found = items.find(item => item.name === name);
    if (found === undefined) throw new Error("Missing item: " + name);
    return found;
  };
  return { observation, dialogs: observation.dialogs, items, named };
}

it("ARIA 대화상자는 입력이 없다고 확인하고 안의 단추에 팝업 번호를 붙인다", async () => {
  const { dialogs, named } = await observe(
    "<div role=\"dialog\" aria-labelledby=\"t\"><h2 id=\"t\">점검 공지</h2><p>오늘 밤 점검이 있어요.</p><button type=\"button\">닫기</button></div>");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toMatchObject({ title: "점검 공지", buttons: ["닫기"], hasInputs: false, kind: "dialog" });
  expect(dialogs[0]?.text).toContain("오늘 밤 점검이 있어요.");
  expect(named("닫기").dialog).toBe(0);
  expect(named("신청 안내 보기")).not.toHaveProperty("dialog");
});

it("<dialog>의 입력 칸은 hasInputs로, [role=button]과 입력 단추는 단추로 센다", async () => {
  const { dialogs, named } = await observe(
    "<dialog open><h2>신청 확인</h2><form><label>이름 <input name=\"n\"></label><button type=\"button\">저장</button>"
    + "<div role=\"button\" tabindex=\"0\">나중에</div><input type=\"button\" value=\"도움말\"></form></dialog>");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toMatchObject({ buttons: ["저장", "나중에", "도움말"], hasInputs: true, kind: "dialog" });
  for (const name of ["저장", "나중에", "도움말"]) expect(named(name).dialog, name).toBe(0);
});

it("div 레이어 팝업은 layer로 잡고 제목은 첫 제목에서 읽는다", async () => {
  const { dialogs, named } = await observe(
    "<div style=\"position:fixed;left:200px;top:120px;width:360px;height:160px;z-index:100;background:#fff\">"
    + "<h3>복지 소식</h3><p>이번 달 안내가 바뀌었어요.</p><a href=\"#\" onclick=\"return false\">닫기</a></div>");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toMatchObject({ title: "복지 소식", hasInputs: false, kind: "layer" });
  expect(dialogs[0]?.text).toContain("이번 달 안내가 바뀌었어요.");
  // 링크 모양 닫기는 단추 목록에 없고, items에서 팝업 번호로 찾는다.
  expect(dialogs[0]?.buttons).toEqual([]);
  expect(named("닫기")).toMatchObject({ role: "scriptlink", dialog: 0 });
  expect(named("신청 안내 보기")).not.toHaveProperty("dialog");
});

it("가리개가 감싼 대화상자는 레이어로 한 번 더 세지 않는다", async () => {
  const { dialogs, named } = await observe(
    "<div style=\"position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.5)\">"
    + "<div role=\"dialog\" aria-label=\"안내\"><p>내용입니다.</p><button type=\"button\">닫기</button></div></div>");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toMatchObject({ title: "안내", kind: "dialog", hasInputs: false });
  expect(named("닫기").dialog).toBe(0);
});

it("레이어 안의 입력 칸이나 양식은 hasInputs를 true로 한다", async () => {
  const layer = (inner: string) => "<div style=\"position:fixed;left:200px;top:120px;width:360px;height:160px;z-index:100;background:#fff\">"
    + inner + "<button type=\"button\">닫기</button></div>";
  const typed = await observe(layer("<p>번호를 알려 주세요.</p><input type=\"text\" aria-label=\"번호\">"));
  expect(typed.dialogs[0]).toMatchObject({ kind: "layer", hasInputs: true });
  // 양식 안에 든 팝업은 단추가 그 양식을 보낼 수 있다.
  const inForm = await observe("<form action=\"/x\" method=\"post\">" + layer("<p>안내입니다.</p>") + "</form>");
  expect(inForm.dialogs[0]).toMatchObject({ kind: "layer", hasInputs: true });
});

// 단추 줄은 보이는 단추를 하나도 빼지 않는다. 이름이 없어도, 이름이 같아도 센다(팝업 안내가 단추 하나로 잘못 읽히지 않게).
it("이름 없는 단추와 밖의 양식에 속한 button[form]을 지나치지 않는다", async () => {
  const { dialogs } = await observe(
    "<form id=\"other\"></form><div role=\"dialog\" aria-label=\"안내\"><button type=\"button\">닫기</button>"
    + "<button form=\"other\" style=\"width:30px;height:30px\"></button></div>");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]?.buttons).toEqual(["닫기", ""]);
  expect(dialogs[0]).toMatchObject({ hasInputs: true, kind: "dialog" });
});

it("이름이 없거나 같은 단추도 하나씩 센다", async () => {
  const unnamed = await observe("<div role=\"dialog\" aria-label=\"안내\"><button type=\"button\"></button></div>");
  expect(unnamed.dialogs[0]?.buttons).toEqual([""]);
  expect(unnamed.dialogs[0]).toMatchObject({ hasInputs: false });
  const twice = await observe("<div role=\"dialog\" aria-label=\"안내\"><button type=\"button\">확인</button>"
    + "<button type=\"button\">확인</button><div role=\"button\" tabindex=\"0\" style=\"width:30px;height:30px\"></div><input type=\"submit\"></div>");
  expect(twice.dialogs[0]?.buttons).toEqual(["확인", "확인", "", ""]);
});

it("보이지 않는 단추는 단추 줄에 넣지 않는다", async () => {
  const { dialogs } = await observe("<div role=\"dialog\" aria-label=\"안내\"><button type=\"button\">닫기</button>"
    + "<button type=\"button\" hidden>숨김</button><button type=\"button\" style=\"display:none\"></button></div>");
  expect(dialogs[0]?.buttons).toEqual(["닫기"]);
  expect(dialogs[0]).toMatchObject({ hasInputs: false });
});

// 양식 소속은 눈에 보이든 안 보이든, 단추 줄이 잘렸든 아니든, 짝 양식이 있든 없든 입력이 있는 것으로 센다.
const formBound: [name: string, popupButtons: string][] = [
  ["밖의 양식을 가리키는 입력 단추", "<input type=\"submit\" value=\"보내기\" form=\"other\">"],
  ["밖의 양식을 가리키는 type=button 단추", "<button type=\"button\" form=\"other\">저장</button>"],
  ["보이지 않는 button[form]", "<button type=\"button\" form=\"other\" hidden>숨김</button>"],
  ["짝 양식이 없는 form 속성", "<button type=\"button\" form=\"missing\">저장</button>"],
];
it.each(formBound)("양식에 속한 단추는 hasInputs로 센다: %s", async (_name, popupButtons) => {
  const { dialogs } = await observe("<form id=\"other\"></form><div role=\"dialog\" aria-label=\"안내\">"
    + "<button type=\"button\">닫기</button>" + popupButtons + "</div>");
  expect(dialogs[0]).toMatchObject({ kind: "dialog", hasInputs: true });
});

it("단추가 여섯 개를 넘어 줄이 잘려도 잘린 뒤의 button[form]을 센다", async () => {
  const many = Array.from({ length: 7 }, (_, i) => "<button type=\"button\">단추" + (i + 1) + "</button>").join("");
  const { dialogs } = await observe("<form id=\"other\"></form><div role=\"dialog\" aria-label=\"안내\">" + many
    + "<button type=\"button\" form=\"other\">여덟째</button></div>");
  expect(dialogs[0]?.buttons).toEqual(["단추1", "단추2", "단추3", "단추4", "단추5", "단추6"]);
  expect(dialogs[0]).toMatchObject({ hasInputs: true });
});

it("레이어 팝업의 button[form]도 hasInputs로 센다", async () => {
  const { dialogs } = await observe("<form id=\"other\"></form>"
    + "<div style=\"position:fixed;left:200px;top:120px;width:360px;height:160px;z-index:100;background:#fff\">"
    + "<p>안내입니다.</p><button type=\"button\">닫기</button><button form=\"other\" style=\"width:30px;height:30px\"></button></div>");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toMatchObject({ kind: "layer", hasInputs: true });
  expect(dialogs[0]?.buttons).toEqual(["닫기", ""]);
});

it("열린 shadow root가 든 팝업은 안을 볼 수 없으므로 hasInputs로 센다", async () => {
  const { dialogs } = await observe("<div role=\"dialog\" aria-label=\"안내\"><button type=\"button\">닫기</button><div id=\"host\"></div></div>"
    + "<script>const field = document.createElement('input'); field.setAttribute('aria-label', '번호');"
    + " document.getElementById('host').attachShadow({ mode: 'open' }).append(field);</script>");
  expect(dialogs[0]?.buttons).toEqual(["닫기"]);
  expect(dialogs[0]).toMatchObject({ kind: "dialog", hasInputs: true });
});

it("대화상자 둘과 레이어는 대화상자가 먼저, 문서 순서대로 번호를 받고 가장 안쪽 팝업이 이긴다", async () => {
  const { dialogs, named } = await observe(
    "<div role=\"dialog\" aria-label=\"바깥\"><button type=\"button\">바깥 단추</button>"
    + "<div role=\"dialog\" aria-label=\"안쪽\"><button type=\"button\">안쪽 단추</button></div></div>"
    + "<div style=\"position:fixed;left:200px;top:120px;width:360px;height:160px;z-index:100;background:#fff\">"
    + "<p>레이어 안내</p><a href=\"#\" onclick=\"return false\">창 닫기</a></div>");
  expect(dialogs.map(d => [d.title, d.kind])).toEqual([["바깥", "dialog"], ["안쪽", "dialog"], ["", "layer"]]);
  expect(named("바깥 단추").dialog).toBe(0);
  expect(named("안쪽 단추").dialog).toBe(1);
  expect(named("창 닫기").dialog).toBe(2);
});

// 애매하면 팝업으로 세지 않는다. 팝업이 아니면 뒤에서도 지금처럼 묻는다.
const notPopups: [name: string, html: string][] = [
  ["닫기 단추가 그냥 화면 안에 있다", "<button type=\"button\">닫기</button>"],
  ["겹쳐 뜨지 않은(z-index 없는) 상자", "<div style=\"position:absolute;left:100px;top:100px;width:300px;height:120px\"><p>안내</p><a href=\"#\" onclick=\"return false\">닫기</a></div>"],
  ["고정된 머리말", "<header style=\"position:fixed;top:0;left:0;width:100%;height:60px;z-index:50;background:#eee\"><a href=\"#\" onclick=\"return false\">닫기</a></header>"],
  ["확인 단추뿐인 하단 고정 줄", "<div style=\"position:fixed;bottom:0;left:0;width:100%;height:60px;z-index:50;background:#eee\"><button type=\"button\">확인</button></div>"],
  ["숨겨진 레이어", "<div style=\"display:none;position:fixed;left:100px;top:100px;width:300px;height:120px;z-index:9\"><a href=\"#\" onclick=\"return false\">닫기</a></div>"],
  ["화면 밖 레이어", "<div style=\"position:fixed;left:-5000px;top:100px;width:300px;height:120px;z-index:9\"><a href=\"#\" onclick=\"return false\">닫기</a></div>"],
  ["화면 전체를 덮는 절대 위치 틀", "<div style=\"position:absolute;left:0;top:0;width:100%;height:100%;z-index:9\"><a href=\"#\" onclick=\"return false\">닫기</a></div>"],
];
it.each(notPopups)("팝업으로 세지 않는다: %s", async (_name, html) => {
  const { dialogs, items } = await observe(html);
  expect(dialogs).toEqual([]);
  expect(items.filter(item => item.dialog !== undefined)).toEqual([]);
});
