/** 데스크톱 메인 프로세스와 로컬 서비스(유틸리티 프로세스) 사이의 메시지. */

import type { Lang } from "../../../src/core/turn.ts";

export function isDesktopLanguage(value: unknown): value is Lang {
  return value === "ko" || value === "en" || value === "zh" || value === "ja";
}

export interface ShutdownMessage {
  readonly type: "shutdown";
}

export interface ReadyMessage {
  readonly type: "ready";
  readonly url: string;
}

export const SHUTDOWN: ShutdownMessage = { type: "shutdown" };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isShutdown(data: unknown): boolean {
  return isRecord(data) && data.type === "shutdown";
}

/** 서비스가 알린 주소는 루프백 http 출처일 때만 믿는다. */
export function readyUrl(data: unknown): string | undefined {
  if (!isRecord(data) || data.type !== "ready" || typeof data.url !== "string") return undefined;
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(data.url) ? data.url : undefined;
}
