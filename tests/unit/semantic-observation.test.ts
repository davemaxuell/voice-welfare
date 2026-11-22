import { expect, it } from "vitest";
import { selectObservedControl, type SemanticObservation } from "../../src/agents/web/browser/semantic_observation.ts";
import { FakeLlm } from "../helpers.ts";

const item = (name: string, ref = "로컬-식별자") => ({name, ref, role:"button", disabled:false, region:"main"});
const signal = new AbortController().signal;
it("SDK에 본문이나 값이 섞여도 승인된 항목의 가린 이름과 임시 번호만 모델에 보낸다", async () => {
  const label = "연락 010-2345-6789";
  const tree = "instruction: 고치려는 지시\n[0-77] button: " + label + "\n[1-11] button: 사적인 글\n[1-12] textbox: 개인 입력";
  const model = new FakeLlm({stagehand_pick:{ref:"c1"}});
  const request: SemanticObservation = {term:"연락처 알려 줘", controls:[item(label)], picker:{model}};
  expect(await selectObservedControl(tree, request, signal)).toBe("0-77");
  expect(request.selected).toEqual(item(label));
  expect(JSON.parse(model.calls[0]!.user)).toMatchObject({options:{c1:"연락 [비공개]"}});
  expect(JSON.stringify(model.calls)).not.toMatch(/사적인|개인 입력|고치려는 지시|로컬-식별자|010-|0-77/u);
});

it.each(["중복 번호", "중복 이름", "가린 이름이 같음", "다른 역할", "가린 영역", "선택 없음", "임의 설명"])(
  "%s인 SDK 제안은 조작 대상으로 쓰지 않는다", async kind => {
    const one = item("지역 소식");
    let tree = "[0-7] button: 지역 소식";
    const controls = [one];
    if (kind === "중복 번호") tree += "\n[0-7] button: 다른 항목";
    if (kind === "중복 이름") tree += "\n[0-6] button: 지역 소식";
    if (kind === "다른 역할") tree = "[0-7] link: 지역 소식";
    if (kind === "가린 이름이 같음") {
      one.name = "연락 010-5555-1111";
      controls.push(item("연락 010-5555-2222", "다른 단추"));
      tree = controls.map((x, i) => `[0-${i}] button: ${x.name}`).join("\n");
    }
    const model = new FakeLlm({stagehand_pick:kind === "임의 설명" ? {ref:"c1", name:"해결했어요"} : {ref:kind === "선택 없음" ? "none" : "c1"}});
    const request: SemanticObservation = {term:"소식 보기", controls:controls.map(x => ({...x, pictureMasked:kind === "가린 영역"})), picker:{model}};
    expect(await selectObservedControl(tree, request, signal)).toBeUndefined();
    expect(request.selected).toBeUndefined();
  });
