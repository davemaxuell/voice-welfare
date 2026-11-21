import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { expect, it } from "vitest";

const colorNames: unknown = createRequire(import.meta.url)("color-name");
if (typeof colorNames !== "object" || colorNames === null) throw new Error("CSS 색상 이름 표를 읽을 수 없습니다.");
const namedColor = new RegExp("\\b(?:" + Object.keys(colorNames).join("|") + ")\\b(?!-)", "iu");

const sheets = ["styles.css", "avatar/overlay.css"].map(name =>
  parse(readFileSync(new URL("../../web/src/" + name, import.meta.url), "utf8"), { from: name }));
const tokens = parse(readFileSync(new URL("../../web/src/tokens.css", import.meta.url), "utf8"));

it("두 화면의 색은 토큰을 쓰고 작은 글자도 14픽셀 이상이다", () => {
  for (const sheet of sheets) {
    sheet.walkDecls(decl => {
      // 아이콘 파일의 내부 그림과 선택자 이름은 CSS 색상값이 아니다.
      const value = decl.value.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/gu, "");
      expect(value, decl.toString()).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklab|oklch|lab|lch|color)\(/iu);
      expect(value.replace(/--[\w-]+/gu, ""), decl.toString()).not.toMatch(namedColor);
      if (decl.prop !== "font" && decl.prop !== "font-size") return;
      for (const [, number, unit] of value.matchAll(/([\d.]+)(px|rem)\b/gu)) {
        expect(Number(number) * (unit === "rem" ? 16 : 1), decl.toString()).toBeGreaterThanOrEqual(14);
      }
    });
  }
  tokens.walkDecls(decl => {
    expect(decl.prop).toMatch(/^--/u);
    if (decl.prop.startsWith("--type-")) expect(parseFloat(decl.value) * 16).toBeGreaterThanOrEqual(14);
  });
});

function luminance(color: string) {
  expect(color).toMatch(/^#(?:[\da-f]{3}|[\da-f]{6})$/iu);
  const hex = color.length === 4 ? [...color.slice(1)].map(c => c + c).join("") : color.slice(1);
  const channels = [0, 2, 4].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  return channels[0]! * .2126 + channels[1]! * .7152 + channels[2]! * .0722;
}

it.each(["light", "dark", "high-contrast"])("%s 테마의 글자와 바탕 명암비가 4.5 이상이다", theme => {
  const palette = new Map<string, string>();
  tokens.walkRules(rule => {
    if (rule.selector === ".high-contrast" && theme !== "high-contrast") return;
    if (rule.parent?.type === "atrule" && theme !== "dark") return;
    rule.walkDecls(decl => { palette.set(decl.prop, decl.value); });
  });
  for (const [fg, bg] of [
    ["ink", "paper"], ["muted", "paper"], ["muted", "surface"], ["accent", "soft"], ["on-accent", "accent"],
    ["on-accent", "accent-hover"], ["good", "good-soft"], ["warn", "warn-soft"], ["danger", "danger-soft"],
    ["bubble-user-ink", "bubble-user"], ["ink", "bubble-bot"],
  ]) {
    const a = luminance(palette.get("--" + fg) ?? ""), b = luminance(palette.get("--" + bg) ?? "");
    expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), fg + "/" + bg).toBeGreaterThanOrEqual(4.5);
  }
});
