import type { Point, Rectangle, Size } from "electron";
import type { desktopText } from "./text.ts";

export type Corner = keyof typeof desktopText.ko.corners;

export function pickDisplay<T extends { id: number }>(displays: { primary: T; all: readonly T[] }, savedId: number | undefined): T {
  return displays.all.find(display => display.id === savedId) ?? displays.primary;
}

/** 화면 좌표와 작업 영역은 Electron이 제공하는 DIP 단위를 그대로 쓴다. */
function margin(length: number) {
  return Math.max(0, Math.min(12, Math.floor((length - 1) / 2)));
}

type FreePlacement = { position: Point; anchor: Point };

export function overlayLimits(area: Rectangle, free?: FreePlacement & { size: Size }) {
  function room(axis: "x" | "y", dimension: "width" | "height", cap: number) {
    const length = area[dimension], inset = margin(length);
    let available = length - 2 * inset;
    if (free !== undefined) {
      // The bubble grows toward the center of the display. Reserve its space without moving the mascot.
      const fraction = free.position[axis], anchor = free.anchor[axis];
      const space = fraction < .5 ? length * (1 - fraction) + anchor : length * fraction + free.size[dimension] - anchor;
      available = Math.min(available, Math.floor(space - inset));
    }
    return Math.max(1, Math.min(cap, available));
  }
  return { maxWidth: room("x", "width", 560), maxHeight: room("y", "height", 720) };
}

/** position은 작업 영역 안의 비율, anchor는 창 안에서 캐릭터 중심까지의 DIP 거리다. */
export function overlayBounds(area: Rectangle, corner: Corner, size: Size, free?: FreePlacement): Rectangle {
  const { maxWidth, maxHeight } = overlayLimits(area);
  const width = Math.min(size.width, maxWidth), height = Math.min(size.height, maxHeight);
  const horizontal = margin(area.width), vertical = margin(area.height);
  const left = area.x + horizontal, right = area.x + area.width - horizontal - width;
  const top = area.y + vertical, bottom = area.y + area.height - vertical - height;
  const x = free === undefined ? (corner.endsWith("right") ? right : left) : area.x + free.position.x * area.width - free.anchor.x;
  const y = free === undefined ? (corner.startsWith("bottom") ? bottom : top) : area.y + free.position.y * area.height - free.anchor.y;
  return {
    x: Math.round(Math.max(left, Math.min(right, x))),
    y: Math.round(Math.max(top, Math.min(bottom, y))),
    width, height,
  };
}
