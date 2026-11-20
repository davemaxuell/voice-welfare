// 루프백 API의 호스트, 출처, 본문 계약.
import { strip } from "../core/text.ts";

/** 같은 이름의 머리글을 줄마다 따로 돌려준다. fetch의 Headers는 쉼표로 합쳐 중복을 숨긴다. */
export interface HeaderList { getAll(name: string): readonly string[] }

/** Node IncomingMessage.rawHeaders([이름, 값, 이름, 값, …])에서 만든다. */
export function rawHeaderList(rawHeaders: readonly string[]): HeaderList {
  return {
    getAll(name) {
      const wanted = name.toLowerCase();
      const values: string[] = [];
      for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
        if (rawHeaders[i]?.toLowerCase() === wanted) values.push(rawHeaders[i + 1] ?? "");
      }
      return values;
    },
  };
}

const HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i;
export const AUDIO_TYPES: ReadonlySet<string> = new Set(["application/octet-stream", "audio/webm", "audio/mp4", "audio/mpeg", "audio/ogg",
  "audio/wav", "audio/x-wav", "audio/flac", "audio/aac", "audio/x-m4a"]);
const AUDIO_ROUTES = new Set(["/api/audio/turn", "/api/audio/stop", "/api/audio/transcribe", "/api/audio/recording"]);
const EMPTY_POST = /^\/api\/session\/[^/]+\/(?:cancel|detach|resume)$/;
export const JSON_LIMIT = 16 * 1024;
export const AUDIO_LIMIT = 10 * 1024 * 1024;
export const TURN_TEXT_LIMIT = 500;

export type Refusal = readonly [status: number, code: string];

export function originRefusal(headers: HeaderList, scheme: string, port: number | undefined, { required = false } = {}): Refusal | undefined {
  const hosts = headers.getAll("host");
  const host = hosts.length === 1 ? HOST.exec(hosts[0] ?? "") : null;
  if (host === null) return [400, "INVALID_HOST"];
  const hostPort = Number(host[1] ?? (scheme === "https" ? "443" : "80"));
  if (!(hostPort > 0 && hostPort < 65536) || (port !== undefined && hostPort !== port)) return [400, "INVALID_HOST"];
  const origins = headers.getAll("origin");
  const expected = (scheme + "://" + (hosts[0] ?? "")).toLowerCase();
  const fetchSite = headers.getAll("sec-fetch-site")[0];
  if ((required && origins.length === 0) || (origins.length > 0 && (origins.length !== 1 || origins[0]?.toLowerCase() !== expected))
    || fetchSite === "cross-site" || fetchSite === "same-site") {
    return [403, "INVALID_ORIGIN"];
  }
  return undefined;
}

export interface PolicyRequest { method: string; path: string; scheme: string; headers: HeaderList }

export function requestRefusal(request: PolicyRequest, port: number | undefined): Refusal | undefined {
  const denied = originRefusal(request.headers, request.scheme, port);
  if (denied !== undefined) return denied;
  if (request.method !== "POST" && request.method !== "DELETE") return undefined;

  const path = request.path;
  const audio = AUDIO_ROUTES.has(path);
  const empty = request.method === "DELETE" || EMPTY_POST.test(path);
  const contentTypes = request.headers.getAll("content-type");
  const mediaType = contentTypes.length === 1 ? strip((contentTypes[0] ?? "").split(";")[0] ?? "").toLowerCase() : "";
  let expectedTypes: ReadonlySet<string> = audio ? AUDIO_TYPES : new Set(["application/json"]);
  if (path === "/api/audio/turn" || path === "/api/audio/stop") expectedTypes = new Set([...AUDIO_TYPES, "application/json"]);
  const allowEmptyType = empty || path === "/api/session";
  if (contentTypes.length > 1 || (!expectedTypes.has(mediaType) && (contentTypes.length > 0 || !allowEmptyType))) {
    return [415, "UNSUPPORTED_MEDIA_TYPE"];
  }
  const length = request.headers.getAll("content-length")[0];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || length.length > 12)) return [400, "INVALID_LENGTH"];
  const limit = empty ? 0 : AUDIO_TYPES.has(mediaType) ? AUDIO_LIMIT : JSON_LIMIT;
  if (Number(length ?? "0") > limit) return [413, "BODY_TOO_LARGE"];
  return undefined;
}

/** 본문을 끝까지 읽되 한도를 넘으면 그 자리에서 멈추고 undefined를 돌려준다. */
export async function boundedBody(chunks: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | undefined> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    if (size + chunk.length > limit) return undefined;
    parts.push(chunk);
    size += chunk.length;
  }
  return Buffer.concat(parts, size);
}
