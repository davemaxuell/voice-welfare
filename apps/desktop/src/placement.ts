import type { Rectangle, Size } from "electron";
import type { desktopText } from "./text.ts";

export type Corner = keyof typeof desktopText.ko.corners;

export function pickDisplay<T extends { id: number }>(displays: { primary: T; all: readonly T[] }, savedId: number | undefined): T {
  return displays.all.find(display => display.id === savedId) ?? displays.primary;
}

/** 화면 좌표와 작업 영역은 Electron이 제공하는 DIP 단위를 그대로 쓴다. */
function margin(length: number) {
  return Math.max(0, Math.min(12, Math.floor((length - 1) / 2)));
}

export function overlayLimits(area: Rectangle) {
  return {
    maxWidth: Math.max(1, Math.min(560, area.width - 2 * margin(area.width))),
    maxHeight: Math.max(1, Math.min(720, area.height - 2 * margin(area.height))),
  };
}

export function overlayBounds(area: Rectangle, corner: Corner, size: Size): Rectangle {
  const { maxWidth, maxHeight } = overlayLimits(area);
  const width = Math.min(size.width, maxWidth), height = Math.min(size.height, maxHeight);
  const horizontal = margin(area.width), vertical = margin(area.height);
  return {
    x: Math.round(corner.endsWith("right") ? area.x + area.width - width - horizontal : area.x + horizontal),
    y: Math.round(corner.startsWith("bottom") ? area.y + area.height - height - vertical : area.y + vertical),
    width, height,
  };
}
