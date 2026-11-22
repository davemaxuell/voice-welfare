import { REDACTED, strip } from "./text.ts";
import type { Redacted } from "./llm.ts";

const defaultPorts = new Map([["http", 80], ["https", 443], ["ws", 80], ["wss", 443], ["ftp", 21]]);
const relativeSchemes = new Set("ftp http gopher nntp imap wais file https shttp mms prospero rtsp rtsps rtspu sftp svn svn+ssh ws wss".split(" "));
const paramsSchemes = new Set("ftp hdl prospero http imap https shttp rtsp rtsps rtspu sip sips mms sftp tel".split(" "));

function splitUrl(raw: string) {
  const input = raw.replace(/^[\u0000-\u0020]+/u, "").replace(/[\t\n\r]/gu, "");
  const parts = /^(?:([a-zA-Z][a-zA-Z\d+.\-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/u.exec(input);
  if (parts === null) throw new TypeError("주소 형식을 확인해 주세요.");
  return {
    scheme: (parts[1] ?? "").toLowerCase(), authority: parts[2] ?? "",
    path: parts[3] ?? "", query: parts[4] ?? "", fragment: parts[5] ?? "",
  };
}

function splitParams(path: string, scheme: string) {
  const index = paramsSchemes.has(scheme) ? path.indexOf(";", path.lastIndexOf("/") + 1) : -1;
  return index < 0 ? { path, params: "" } : { path: path.slice(0, index), params: path.slice(index + 1) };
}

function joinUrl(base: string, input: string) {
  if (base.length === 0) return input;
  if (input.length === 0) return base;
  const parent = splitUrl(base);
  const ref = splitUrl(input);
  const scheme = ref.scheme.length === 0 ? parent.scheme : ref.scheme;
  if (scheme !== parent.scheme || !relativeSchemes.has(scheme)) return input;
  const authority = ref.authority.length === 0 ? parent.authority : ref.authority;
  let { path, params } = splitParams(ref.path, scheme);
  let query = ref.query;
  if (ref.authority.length === 0) {
    const basePath = splitParams(parent.path, scheme);
    if (path.length === 0 && params.length === 0) {
      ({ path, params } = basePath);
      if (query.length === 0) query = parent.query;
    } else {
      const segments = path.startsWith("/") ? path.split("/") :
        [...basePath.path.split("/").slice(0, -1), ...path.split("/")]
          .filter((seg, i, all) => i === 0 || i === all.length - 1 || seg.length > 0);
      const resolved: string[] = [];
      for (const segment of segments) {
        if (segment === "..") resolved.pop();
        else if (segment !== ".") resolved.push(segment);
      }
      const last = segments.at(-1);
      if (last === "." || last === "..") resolved.push("");
      path = resolved.join("/");
      if (path.length === 0) path = "/";
    }
  }
  if (params.length > 0) path += ";" + params;
  if (path.length > 0 && !path.startsWith("/")) path = "/" + path;
  return `${scheme}://${authority}${path}${query.length > 0 ? "?" + query : ""}${ref.fragment.length > 0 ? "#" + ref.fragment : ""}`;
}

function hostParts(authority: string) {
  const invalid = () => { throw new TypeError("주소의 호스트나 포트가 올바르지 않습니다."); };
  const normalized = authority.replace(/[@:#?]/gu, "");
  if (/\p{White_Space}/u.test(authority) ||
      (normalized.normalize("NFKC") !== normalized && /[/?#@:]/u.test(normalized.normalize("NFKC")))) invalid();
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const brackets = /[[\]]/u.test(authority);
  let hostname: string, portText: string;
  if (brackets) {
    const match = /^\[([^\]]+)\](?::(.*))?$/u.exec(host);
    if (match?.[1] === undefined) throw new TypeError("잘못된 IPv6 주소입니다.");
    hostname = match[1];
    // WHATWG는 영역 ID를 받지 않는다. 영역을 분리한 주소만 IP 문법으로 검사한다.
    const [address, zone, extraZone] = hostname.split("%");
    const validIPv6 = address?.includes(":") === true && zone !== "" && extraZone === undefined &&
      URL.canParse("http://[" + address + "]/");
    if (!validIPv6 && !/^v[0-9a-fA-F]+\..+$/u.test(hostname)) invalid();
    portText = match[2] ?? "";
  } else {
    const colon = host.indexOf(":");
    hostname = colon < 0 ? host : host.slice(0, colon);
    portText = colon < 0 ? "" : host.slice(colon + 1);
  }
  if (portText.length > 0 && (!/^\d+$/u.test(portText) || Number(portText) > 65535)) invalid();
  hostname = hostname.toLowerCase();
  if (hostname.includes(":")) hostname = "[" + hostname + "]";
  return { hostname, portNumber: portText.length > 0 ? Number(portText) : undefined };
}

/** 원본 주소와 한글 경로를 그대로 보존한다. 승인 지문과 음성 안내가 이 값을 쓴다. */
export function parseUrl(url: string, base?: string) {
  if (typeof url !== "string") throw new TypeError("문자열 주소가 필요합니다.");
  const raw = strip(url);
  const href = base === undefined ? raw : joinUrl(base, raw);
  const { scheme, authority, path, query: search } = splitUrl(href);
  const { hostname, portNumber } = hostParts(authority);
  if (scheme.length === 0 || (defaultPorts.has(scheme) && hostname.length === 0)) throw new TypeError("잘못된 주소입니다.");
  const port = portNumber === undefined || defaultPorts.get(scheme) === portNumber ? "" : String(portNumber);
  const host = port.length > 0 ? hostname + ":" + port : hostname;
  const params = new URLSearchParams("?" + search);
  const query: Record<string, string[]> = Object.create(null);
  for (const [name, value] of params) (query[name] ??= []).push(value);
  return {
    href, protocol: scheme + ":", hostname, port, host,
    origin: defaultPorts.has(scheme) ? `${scheme}://${host}` : "null",
    pathname: path.length === 0 && (scheme === "file" || defaultPorts.has(scheme)) ? "/" : path,
    search: search.length > 0 ? "?" + search : "", query,
    param: (name: string) => query[name]?.[0],
  };
}

export function tryUrl(url: string | undefined | null) {
  if (url === undefined || url === null || url.length === 0) return undefined;
  try { return parseUrl(url); } catch { return undefined; }
}

/** 발화에서 누리집을 찾을 때와 모델에 보낼 주소를 가릴 때 같은 문법을 쓴다. */
export const spokenAddressPatterns = {
  domain: /(?:(?<![A-Za-z0-9_İı])(?=[A-Za-z0-9_İı])|(?<=[A-Za-z0-9_İı])(?![A-Za-z0-9_İı]))((?:https?:\/\/)?(?:(?:[a-zİ0-9-]+\.)+[a-zİ]{2,}|localhost|\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3})(?::\p{Nd}+)?(?:\/[^\p{White_Space}]*)?)/iu,
  domainWhole: /^(?:(?:(?<![A-Za-z0-9_İı])(?=[A-Za-z0-9_İı])|(?<=[A-Za-z0-9_İı])(?![A-Za-z0-9_İı]))((?:https?:\/\/)?(?:(?:[a-zİ0-9-]+\.)+[a-zİ]{2,}|localhost|\p{Nd}{1,3}(?:\.\p{Nd}{1,3}){3})(?::\p{Nd}+)?(?:\/[^\p{White_Space}]*)?))$/iu,
  linkEnding: /[.,)]+(?=\n?$)/gu,
  localAddress: /^(localhost|\p{Nd}{1,3}(\.\p{Nd}{1,3}){3})(:|\/|(?=\n?$))/iu,
  protocol: /^https?:\/\//iu,
  goalMarker: /에서|들어가서|가서|열어서|열고|접속해서/gu,
  explicitUrl: /https?:\/\/[A-Za-z0-9İı\-._~:/?#[\]@!$&'()*+,;=%]+/iu,
};

export function addressSite(address: string) {
  const raw = address.replace(spokenAddressPatterns.linkEnding, "");
  // 로컬 주소(localhost, IP)는 http, 그 외 도메인은 https로 연다.
  const scheme = spokenAddressPatterns.localAddress.test(raw) ? "http" : "https";
  const url = spokenAddressPatterns.protocol.test(raw) ? raw : `${scheme}://${raw}`;
  const parsed = tryUrl(url);
  return parsed === undefined ? undefined : { url, label: parsed.host };
}

const addressReferences = new RegExp(String.raw`https?:\/\/[^\s<>"“”]+|${spokenAddressPatterns.domain.source}(?:[?#][^\s<>"“”]*)?`, "giu");

/** 모델에는 출처만 보낸다. 브라우저는 이용자가 말한 정확한 주소를 기기 안에서 찾아 연다. */
type DestinationText<T extends string> = { text: T; urls: Map<string, string[]> };
export function destinationOrigins(text: Redacted, origins?: ReadonlySet<string>): DestinationText<Redacted>;
export function destinationOrigins(text: string, origins?: ReadonlySet<string>): DestinationText<string>;
export function destinationOrigins(text: string, origins?: ReadonlySet<string>): DestinationText<string> {
  const urls = new Map<string, string[]>();
  const masked = text.replace(addressReferences, (raw: string, _bare: string | undefined, at: number) => {
    // 경로가 없는 도메인은 이미 공개 정보이고 일반 문장에 쓰인 이름일 수도 있다.
    if (!spokenAddressPatterns.protocol.test(raw) && !/[/?#]/u.test(raw)) return raw;
    const marker = [...raw.matchAll(spokenAddressPatterns.goalMarker)].find(m => m.index + m[0].length === raw.length);
    // 문장이 더 이어질 때 탐색기가 쓰는 주소 문법으로 조사 앞의 주소를 확인한다.
    const suffix = marker && strip(text.slice(at + raw.length)).length > 0 &&
      spokenAddressPatterns.domainWhole.test(raw.slice(0, marker.index)) ? marker[0] : "";
    const token = raw.slice(0, raw.length - suffix.length);
    const address = spokenAddressPatterns.protocol.test(token) ? token : addressSite(token)?.url;
    const url = address === undefined ? null : URL.parse(address);
    if (address === undefined || !url || url.username.length > 0 || url.password.length > 0) return REDACTED;
    if (origins !== undefined && !origins.has(url.origin)) return raw;
    const matches = urls.get(url.origin) ?? [];
    if (!matches.includes(address)) matches.push(address);
    urls.set(url.origin, matches);
    return url.origin + suffix;
  });
  return {text: masked, urls};
}

/** 이용자가 하나의 구체적인 페이지를 주었는지 확인한다. */
export function suppliedPage(urls: ReadonlyMap<string, readonly string[]>): {origin: string; url: string} | undefined {
  if (urls.size !== 1) return undefined;
  const [entry] = urls;
  const address = entry?.[1].length === 1 ? entry[1][0] : undefined;
  const url = address === undefined ? null : URL.parse(address);
  return address !== undefined && url && (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) ? {origin: url.origin, url: address} : undefined;
}

export function referenceOrigin(token: string): string | undefined {
  const address = spokenAddressPatterns.protocol.test(token) ? token : addressSite(token)?.url;
  const url = address === undefined ? null : URL.parse(address);
  if (!url || ![url.origin, url.origin + "/", url.host, url.host + "/"].includes(token)) return undefined;
  return url.origin;
}

/** 번역기나 계획기가 돌려준 출처는 이용자가 이 출처의 주소를 하나만 말했을 때 복원한다. */
export function bindDestinations(text: string, bindings: ReadonlyMap<string, readonly string[]>): string {
  if (bindings.size === 0) return text;
  return text.replace(addressReferences, raw => {
    const token = spokenAddressPatterns.explicitUrl.exec(raw)?.[0] ?? raw;
    const origin = referenceOrigin(token);
    const matches = origin === undefined ? undefined : bindings.get(origin);
    return matches?.length === 1 ? matches[0] + raw.slice(token.length) : raw;
  });
}
