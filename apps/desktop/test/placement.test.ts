import assert from "node:assert/strict";
import test from "node:test";
import { overlayBounds, pickDisplay } from "../src/placement.ts";

test("저장한 화면을 찾고, 분리된 화면이 돌아오면 같은 화면을 다시 고른다", () => {
  const primary = { id: 8 }, other = { id: 42 };
  const displays = { primary, all: [other, primary] };
  assert.equal(pickDisplay(displays, undefined), primary);
  assert.equal(pickDisplay(displays, 42), other);
  assert.equal(pickDisplay({ primary, all: [primary] }, 42), primary);
  assert.equal(pickDisplay(displays, 42), other);
});

test("각 배율에서 DIP 작업 영역의 네 구석에 12만큼 여유를 둔다", () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const area = { x: -Math.round(1920 / scaleFactor), y: 32, width: Math.round(1920 / scaleFactor), height: Math.round(1080 / scaleFactor) - 32 };
    const size = { width: 280, height: 360 };
    for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      const rect = overlayBounds(area, corner, size);
      assert.equal(rect.width, size.width);
      assert.equal(rect.height, size.height);
      assert.equal(rect.x, corner.endsWith("right") ? area.x + area.width - 12 - size.width : area.x + 12);
      assert.equal(rect.y, corner.startsWith("bottom") ? area.y + area.height - 12 - size.height : area.y + 12);
    }
  }
});

test("카드가 작업 영역보다 클 때에는 여백과 카드 크기를 영역 안으로 줄인다", () => {
  assert.deepEqual(overlayBounds({ x: 50, y: 40, width: 80, height: 60 }, "bottom-right", { width: 500, height: 600 }),
    { x: 62, y: 52, width: 56, height: 36 });
  for (const corner of ["top-left", "bottom-right"] as const) {
    const area = { x: -15, y: 5, width: 10, height: 8 };
    const bounds = overlayBounds(area, corner, { width: 500, height: 600 });
    assert(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
    assert(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
  }
});
