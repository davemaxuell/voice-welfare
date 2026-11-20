import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { parseEnv } from "node:util";
import { practiceSite } from "../core/assets.ts";
import { createPracticeSite } from "../practice_site/serve.ts";

type Env = Record<string, string | undefined>;

function readEnvFile(file: string): Env {
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, "utf8").replace(/^﻿/, ""));
}

const INTEGER = /^\s*[+-]?\d+\s*$/;

export function toPort(text: string): number {
  const port = INTEGER.test(text) ? Number(text) : Number.NaN;
  if (!(port >= 0 && port <= 65535)) throw new Error("올바른 포트가 필요합니다.");
  return port;
}

function savedPort(file: string): number | undefined {
  try {
    const text = readFileSync(file, "ascii");
    const saved = INTEGER.test(text) ? Number(text) : Number.NaN;
    return saved >= 1024 && saved <= 65535 ? saved : undefined;
  } catch {
    return undefined;
  }
}

function listen(server: Server, host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, exclusive: true, ipv6Only: host === "::1" }, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

// Keeping the same origin preserves the user's microphone selection between app launches.
export async function bindLocal(server: Server, host: string, port: number, portFile: string | undefined) {
  const preferred = portFile === undefined ? port : (savedPort(portFile) ?? port);
  let bound: number;
  try {
    bound = await listen(server, host, preferred);
  } catch (error) {
    if (portFile === undefined) throw error;
    bound = await listen(server, host, 0);
  }
  if (portFile !== undefined) {
    try {
      writeFileSync(portFile, String(bound), "ascii");
    } catch {
      /* 저장하지 못하면 다음 실행에 새 포트 */
    }
  }
  return bound;
}

export async function startPracticeSite(env: Env, bundled: boolean) {
  if (bundled && (env.MOCK_SITE_URL === undefined || env.MOCK_SITE_URL === "")) {
    const site = await createPracticeSite(practiceSite).startMockSite(0);
    env.MOCK_SITE_URL = `http://localhost:${site.port}`;
    return site.close;
  }
  try {
    const existing = await fetch("http://localhost:5174/", { signal: AbortSignal.timeout(1500) });
    await existing.body?.cancel();
    if (existing.ok) return async () => {};
  } catch {
    /* 모의 사이트가 없으면 같은 포트에 띄운다. */
  }
  return (await createPracticeSite(practiceSite).startMockSite(5174)).close;
}


export function serviceEnvironment(file: string, isolated: boolean): Env {
  const settings = readEnvFile(file);
  if (isolated) return { ...settings, ...process.env };
  for (const [key, value] of Object.entries(settings)) process.env[key] ??= value;
  return { ...process.env };
}
