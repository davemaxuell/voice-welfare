import type { WebObservation } from "./view.ts";

export const authPatterns = {
  login: /(로그인|log\p{White_Space}*-?\p{White_Space}*[iİ]n|s[iİ]gn\p{White_Space}*-?\p{White_Space}*[iİ]n)/iu,
  verification: /(본인\p{White_Space}*인증|간편\p{White_Space}*인증|인증\p{White_Space}*화면|본인확인)/iu,
  pass: /(?<![A-Za-zıİ0-9_])PASS(?![A-Za-zıİ0-9_])|패스\p{White_Space}*인증|모바일\p{White_Space}*PASS|통신사\p{White_Space}*PASS/iu,
  kakao: /카카오(\p{White_Space}*톡)?\p{White_Space}*(인증|로그인)|kakao\p{White_Space}*auth/iu,
  naver: /네이버\p{White_Space}*(인증|로그인)|naver\p{White_Space}*auth/iu,
  toss: /토스\p{White_Space}*(인증|로그인)|(?<![A-Za-zıİ0-9_])toss(?![A-Za-zıİ0-9_])/iu,
  certificate: /금융\p{White_Space}*인증|공동\p{White_Space}*인증|공동인증서/u,
};

const apps = [
  ["PASS", authPatterns.pass], ["카카오톡", authPatterns.kakao], ["네이버", authPatterns.naver],
  ["토스", authPatterns.toss], ["금융인증서", authPatterns.certificate],
] as const;
const textTypes = new Set(["text", "email", "tel", "password", "number"]);
export type AuthPageKind = "login" | "verification" | "other";

export function passwordFields(view: WebObservation) {
  return (view.fields ?? []).filter(field => field.visible === true && field.type === "password");
}

export function verificationApp(view: WebObservation) {
  const text = [
    view.title ?? "", [...(view.mainText ?? "")].slice(0, 800).join(""),
    ...(view.outline?.items ?? []).map(item => item.name).filter(name => name !== undefined && name.length > 0),
    ...(view.fields ?? []).map(field => field.label).filter(label => label !== undefined && label.length > 0),
  ].join("\n");
  return apps.find(([, pattern]) => pattern.test(text))?.[0];
}

export function authPageKind(view: WebObservation): AuthPageKind {
  if (view.pageId === "mock-login" || passwordFields(view).length > 0 || authPatterns.login.test(view.title ?? "")) return "login";
  return authPatterns.verification.test(view.title ?? "") || verificationApp(view) !== undefined ? "verification" : "other";
}

export function stillNeedsAuth(view: WebObservation): boolean {
  return authPageKind(view) !== "other";
}

export function firstFillField(view: WebObservation) {
  const fields = (view.fields ?? []).filter(field => field.visible === true && (field.fieldId?.length ?? 0) > 0 &&
    field.type !== undefined && textTypes.has(field.type));
  return fields.find(field => field.type !== "password") ?? fields[0];
}
