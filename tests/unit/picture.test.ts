import { globSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inspect } from "node:util";
import ts from "typescript";
import { expect, it } from "vitest";
import { z } from "zod";
import { REPO_ROOT } from "../../src/core/assets.ts";
import {
  MaskReport, PICTURE_SCHEMA, PICTURE_SCHEMA_NAME, PICTURE_SCREENS, PICTURE_SYSTEM, Picture, pngSize,
} from "../../src/core/picture.ts";

// 화면 사진(Picture)은 가린 뒤에만 생기고, 만드는 곳은 화면을 가리고 찍는 코드뿐이다.
const SRC = join(REPO_ROOT, "src");
// 사진을 만들어도 되는 곳. 뒤의 것은 앱 창 사진이 들어올 자리다.
const SEALERS = new Set(["agents/web/browser/index.ts", "agents/desktop/capture.ts"]);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const MASKS = new MaskReport(2, 1, 0, true);
const seal = (details: Partial<{ source: "web" | "app"; masks: MaskReport }> = {}) =>
  Picture._sealed(PNG, { source: "web", width: 1, height: 1, masks: MASKS, ...details });

/** Picture를 만드는 코드가 있는 줄: _sealed를 부르거나 이름으로 꺼내는 곳, 생성자를 거치지 않고 Picture 겉모양을 만드는 곳. */
function sealingLines(source: string): number[] {
  const file = ts.createSourceFile("scan.ts", source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  function visit(node: ts.Node) {
    const parent = node.parent;
    const accessed = ts.isPropertyAccessExpression(node) && node.name.text === "_sealed";
    const declared = (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node;
    const bare = ts.isIdentifier(node) && node.text === "_sealed" && !declared && !(ts.isPropertyAccessExpression(parent) && parent.name === node);
    const quoted = ts.isStringLiteralLike(node) && node.text === "_sealed";
    const forged = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ["create", "construct", "setPrototypeOf"].includes(node.expression.name.text) &&
      node.arguments.some(argument => argument.getText(file).includes("Picture"));
    if (accessed || bare || quoted || forged) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(file, visit);
  return lines;
}

it("test_picture_cannot_be_constructed_directly", () => {
  expect(() => Reflect.construct(Picture, [])).toThrow(TypeError);
  expect(() => Reflect.construct(Picture, [PNG, "web", 1, 1, MASKS])).toThrow(TypeError);
});

it("test_sealing_needs_a_mask_report_and_a_png", () => {
  const loose = (png: Uint8Array, masks: unknown) => Reflect.apply(Picture._sealed, Picture, [png, { source: "web", width: 1, height: 1, masks }]);
  expect(() => loose(PNG, null)).toThrow(TypeError);
  expect(() => loose(PNG, { inputs: 2, frames: 1, blocks: 0, cursorHidden: true })).toThrow(TypeError);
  expect(() => loose(Buffer.from("GIF89a not a png at all....."), MASKS)).toThrow(RangeError);
});

it("test_sealed_picture_shows_facts_but_not_bytes", () => {
  const picture = seal();
  expect([picture.source, picture.width, picture.height, picture.masks]).toEqual(["web", 1, 1, MASKS]);
  const names = [...Object.getOwnPropertyNames(picture), ...Object.getOwnPropertyNames(Object.getPrototypeOf(picture))];
  const shown = names.filter(name => name !== "dataUrl" && name !== "constructor").map(name => Reflect.get(picture, name));
  expect(shown.some(value => value instanceof ArrayBuffer || ArrayBuffer.isView(value))).toBe(false);
  expect(Object.getOwnPropertySymbols(picture)).toEqual([]);
  for (const text of [String(picture), JSON.stringify(picture), inspect(picture, { depth: 5, showHidden: true })]) {
    expect(text).not.toContain("iVBOR");
  }
  expect(String(picture)).toBe("Picture(source='web', 1x1, masks=MaskReport(inputs=2, frames=1, blocks=0, cursorHidden=True))");
  expect(Reflect.set(picture, "masks", new MaskReport(0, 0, 0, false))).toBe(false);
  expect(picture.masks).toBe(MASKS);
});

it("test_data_url_carries_the_png", () => {
  const url = seal({ source: "app" }).dataUrl();
  const comma = url.indexOf(",");
  expect(url.slice(0, comma)).toBe("data:image/png;base64");
  expect(Buffer.from(url.slice(comma + 1), "base64").equals(PNG)).toBe(true);
});

it("test_png_size_reads_the_header", () => {
  expect(pngSize(PNG)).toEqual([1, 1]);
  expect(() => pngSize(new Uint8Array())).toThrow(RangeError);
  expect(() => pngSize(PNG.subarray(0, 23))).toThrow(RangeError);
  const wide = Buffer.from(PNG);
  wide.writeUInt32BE(1920, 16);
  wide.writeUInt32BE(5000, 20);
  expect(pngSize(wide)).toEqual([1920, 5000]);
});

it("test_scan_sees_every_way_of_sealing", () => {
  expect(sealingLines("const p = Picture._sealed(png, { source: 'web', width: 1, height: 1, masks });")).toEqual([1]);
  expect(sealingLines("import { Picture } from './picture.ts';\nconst make = Reflect.get(Picture, '_sealed');")).toEqual([2]);
  expect(sealingLines("const { _sealed } = Picture;")).toEqual([1]);
  expect(sealingLines("const p = Object.create(Picture.prototype);")).toEqual([1]);
  expect(sealingLines("const p = Reflect.construct(Picture, []);")).toEqual([1]);
  expect(sealingLines("const p = picture.dataUrl();")).toEqual([]);
});

it("test_only_capture_code_seals_pictures", () => {
  const found = new Map<string, number[]>();
  const shooters: string[] = [];
  for (const file of globSync("**/*.ts", { cwd: SRC })) {
    const text = readFileSync(join(SRC, file), "utf8");
    const name = relative(SRC, join(SRC, file)).split(sep).join("/");
    const lines = sealingLines(text);
    if (lines.length > 0) found.set(name, lines);
    if (/\.screenshot\(/u.test(text)) shooters.push(name);
  }
  const outside = [...found].filter(([name]) => !SEALERS.has(name));
  expect(outside, `가리고 찍는 코드 밖에서 Picture를 만듭니다: ${JSON.stringify(outside)}`).toEqual([]);
  // 화면을 찍는 코드는 반드시 Picture._sealed로 가린 사진만 내보낸다. 찍는 코드가 아직 없으면 비어 있다.
  for (const name of shooters) {
    expect(SEALERS.has(name), `${name}은 사진 찍는 코드인데 허용 목록에 없습니다`).toBe(true);
    expect(found.has(name), `${name}의 화면 찍기가 Picture._sealed를 쓰지 않습니다`).toBe(true);
  }
});

it("test_answer_schema_is_strict_and_has_no_room_for_actions", () => {
  expect(PICTURE_SCHEMA.additionalProperties).toBe(false);
  expect(new Set(PICTURE_SCHEMA.required)).toEqual(new Set(Object.keys(PICTURE_SCHEMA.properties)));
  expect(new Set(PICTURE_SCHEMA.required)).toEqual(new Set(["screen", "description", "pressable"]));
  expect(PICTURE_SCHEMA.properties.pressable).toEqual({ type: "array", items: { type: "integer" } });
});

const fixture = z.object({
  schemaName: z.string(), screens: z.array(z.string()), schema: z.unknown(), system: z.string(),
}).parse(JSON.parse(readFileSync(new URL("../fixtures/core/picture.json", import.meta.url), "utf8")));

it("사진 답의 스키마 이름·화면 종류·모델 지시문이 Python과 한 글자도 다르지 않다", () => {
  expect(PICTURE_SCHEMA_NAME).toBe(fixture.schemaName);
  expect([...PICTURE_SCREENS]).toEqual(fixture.screens);
  expect(PICTURE_SCHEMA).toEqual(fixture.schema);
  expect(PICTURE_SYSTEM).toBe(fixture.system);
});

it("생성자를 거치지 않고 만든 겉모양은 사진이 아니다", () => {
  expect(Picture.isPicture(seal())).toBe(true);
  expect(Picture.isPicture(Object.create(Picture.prototype))).toBe(false);
  for (const other of [PNG, "data:image/png;base64,AAAA", "C:/shot.png", null, undefined, {}]) expect(Picture.isPicture(other)).toBe(false);
});

it("사진은 넘겨 준 바이트가 나중에 바뀌어도 그대로다", () => {
  const bytes = Uint8Array.from(PNG);
  const picture = Picture._sealed(bytes, { source: "web", width: 1, height: 1, masks: MASKS });
  bytes.fill(0);
  expect(Buffer.from(picture.dataUrl().split(",")[1] ?? "", "base64").equals(PNG)).toBe(true);
});
