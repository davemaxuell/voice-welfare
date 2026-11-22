import { createHash } from "node:crypto";
import type { PlanStep, RememberedRoute } from "../core/plan.ts";
import { isInspectionUrl, planControlAllowed } from "./guard.ts";
import { REDACTED, redactPictureText, redactText, type SecretSpan } from "./privacy.ts";

export const routeDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const privatePath = /(?:^|[./_-])(?:me|my|mypage|myinfo|private|user[s]?|member[s]?|profile|account|auth|login|session|token|secret|receipt|orders?|customer[s]?)(?:$|[./_-])/iu;
const personalText = /(?:비밀번호|인증번호|계좌|주민등록|휴대폰|전화번호|아이디|이메일|생년월일|내\s*(?:정보|계정|기록|신청)|님(?:의|께|$)|\d{3}|@|[a-z\d_-]{24,})/iu;
export function cleanRouteText(value: string, privateValues: readonly string[], spans?: readonly SecretSpan[]): boolean {
  return value.length > 0 && !value.includes(REDACTED) && !privateValues.some(v => v.length > 0 && value.includes(v)) &&
    redactText(value, spans) === value && redactPictureText(value, spans) === value;
}
export function routeGoalKey(goal: string, privateValues: readonly string[], spans?: readonly SecretSpan[]): string | undefined {
  if (!cleanRouteText(goal, privateValues, spans) || personalText.test(goal) || goal.length > 400) return undefined;
  return routeDigest(redactText(goal, spans).normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " "));
}
export function routePage(raw: string, privateValues: readonly string[]): string | undefined {
  const url = URL.parse(raw);
  if (!url || !isInspectionUrl(raw) || url.search.length > 0 || url.hash.length > 0 || /[?#]/u.test(raw) ||
      !cleanRouteText(url.hostname + url.pathname, privateValues) || privatePath.test(url.hostname + url.pathname) || /(?:^|[._-])(?:[a-f\d]{12,}|[a-z]*\d{5,}[a-z\d-]*)[.-]/iu.test(url.hostname) ||
      !/^\/(?:[a-zA-Z0-9./_-]*)$/u.test(url.pathname) ||
      url.pathname.split("/").some(segment => segment.length > 40 || /\d{2}|[a-z\d]{24}|^[-\d]+$/iu.test(segment))) return undefined;
  return url.origin + url.pathname;
}
export function safeRouteStep(step: PlanStep, privateValues: readonly string[]): boolean {
  return step.kind === "click" && routePage(step.page, privateValues) === step.page && planControlAllowed(step.role, step.name) &&
    cleanRouteText(step.name, privateValues) && step.name.length <= 80 && !personalText.test(step.name) &&
    /^[\p{L}\p{M} \d·()_-]+$/u.test(step.name);
}
export function routeMetadataSafe(route: RememberedRoute, values: readonly string[]): boolean {
  return routePage(route.endPage, values) === route.endPage && new URL(route.endPage).origin === route.site &&
    route.steps.length > 0 && route.steps.every(step => safeRouteStep(step, values) && new URL(step.page).origin === route.site);
}
