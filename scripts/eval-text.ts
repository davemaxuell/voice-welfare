import { hasText } from "../src/core/text.ts";

export function textOr(value: string | undefined, fallback: string): string {
  return hasText(value) ? value : fallback;
}

// Python formats exact halfway values toward the nearest even decimal digit.
export function fixed(value: number, places: number): string {
  const scale = 10 ** places;
  const scaled = value * scale;
  const lower = Math.floor(scaled);
  if (scaled - lower === 0.5 && Number.isInteger(value * 2 ** (places + 1))) {
    return ((lower + Math.abs(lower % 2)) / scale).toFixed(places);
  }
  return value.toFixed(places);
}
