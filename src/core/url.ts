import { isIPv6 } from "node:net";
import { strip } from "./text.ts";

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
    if (!isIPv6(hostname) && !/^v[0-9a-fA-F]+\..+$/u.test(hostname)) invalid();
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
