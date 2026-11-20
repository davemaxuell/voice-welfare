import { isIPv4, isIPv6 } from "node:net";

const UNSAFE_URL_CHARACTERS = /[\t\r\n]/gu;
const LEADING_CONTROL_OR_SPACE = /^[\u0000- ]+/u;
const SCHEME_CHARACTERS = /^[A-Za-z0-9+.-]+$/u;
const IPV_FUTURE = /^v[a-fA-F0-9]+\.[^\n]+$/u;
const ASCII_ONLY = /^[\u0000-\u007f]*$/u;

/**
 * Python urllib.parse.urlsplit(url)가 netloc에서 뽑는 '사용자:비밀번호@' 부분.
 * urlsplit이 거부하는 주소(짝이 안 맞는 대괄호, 잘못된 IP, NFKC로 풀면 구분 문자가 생기는 호스트)는 ValueError 대신 RangeError를 낸다.
 */
export function urlCredentials(url: string): { username: string | undefined; password: string | undefined } {
  let rest = url.replace(LEADING_CONTROL_OR_SPACE, "").replace(UNSAFE_URL_CHARACTERS, "");
  const colon = rest.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/u.test(rest) && SCHEME_CHARACTERS.test(rest.slice(0, colon))) rest = rest.slice(colon + 1);
  const none = { username: undefined, password: undefined };
  if (!rest.startsWith("//")) return none;
  const delimiters = ["/", "?", "#"].map(mark => rest.indexOf(mark, 2)).filter(index => index >= 0);
  const netloc = rest.slice(2, delimiters.length > 0 ? Math.min(...delimiters) : rest.length);
  if ((netloc.includes("[") && !netloc.includes("]")) || (netloc.includes("]") && !netloc.includes("["))) throw new RangeError("Invalid IPv6 URL");
  if (netloc.includes("[") && netloc.includes("]")) {
    const bracketed = netloc.slice(netloc.indexOf("[") + 1).split("]")[0] ?? "";
    if (bracketed.startsWith("v")) {
      if (!IPV_FUTURE.test(bracketed)) throw new RangeError("IPvFuture address is invalid");
    } else if (isIPv4(bracketed)) {
      throw new RangeError("An IPv4 address cannot be in brackets");
    } else if (!isIPv6(bracketed)) {
      throw new RangeError(`'${bracketed}' does not appear to be an IPv4 or IPv6 address`);
    }
  }
  if (!ASCII_ONLY.test(netloc)) {
    const plain = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
    const folded = plain.normalize("NFKC");
    if (folded !== plain && /[/?#@:]/u.test(folded)) throw new RangeError(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
  }
  const at = netloc.lastIndexOf("@");
  if (at < 0) return none;
  const userinfo = netloc.slice(0, at);
  const split = userinfo.indexOf(":");
  return split < 0 ? { username: userinfo, password: undefined } : { username: userinfo.slice(0, split), password: userinfo.slice(split + 1) };
}
