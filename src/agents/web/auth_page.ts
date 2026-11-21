import type { WebObservation } from "./view.ts";

const head = (text: string, size: number) => [...text].slice(0, size).join("");

export const authPatterns = {
  captcha: /(보안\p{White_Space}*문자|자동\p{White_Space}*입력\p{White_Space}*방지|captcha|ver[iİ]fy (?:that )?you are human|are you a robot)/iu,
  accessBlock: /(접속이\p{White_Space}*차단|접근이\p{White_Space}*차단|비정상적인\p{White_Space}*접근|unusual traff[iİ]c|access den[iİ]ed)/iu,
  login: /(로그인|log\p{White_Space}*-?\p{White_Space}*[iİ]n|s[iİ]gn\p{White_Space}*-?\p{White_Space}*[iİ]n)/iu,
  verification: /(본인\p{White_Space}*인증|간편\p{White_Space}*인증|인증\p{White_Space}*화면|본인\p{White_Space}*확인|휴대\p{White_Space}*(폰|전화)\p{White_Space}*인증)/iu,
  verifyControl: /인증\p{White_Space}*번호|인증\p{White_Space}*(요청|받기)|간편\p{White_Space}*(인증|로그인)|인증서\p{White_Space}*로그인/u,
  verifyChoose: /간편\p{White_Space}*인증\p{White_Space}*(서비스를?\p{White_Space}*)?선택|인증\p{White_Space}*(수단|방법)을?\p{White_Space}*선택/u,
  // 본문은 '지금 인증하라'는 문장만 단서로 본다(주인 결정 2026-11-19). 절차를 설명하는 말은 단서가 아니다.
  doItNow: /하세요|해\p{White_Space}*주세요|하십시오|진행합니다|진행해|선택해|입력해|눌러/u,
  describes: /필요|뒤|후에|있어야|있으면|가능|할\p{White_Space}*수\p{White_Space}*있/u,
  // 이 화면에서 바로 누르라는 말은 '…한 뒤'가 있어도 지금 할 일이다.
  onPage: /(확인|완료|다음)\p{White_Space}*(버튼)?\p{White_Space}*(을|를)?\p{White_Space}*눌러/u,
  sentence: /(?<=[.!?。])\p{White_Space}+|\n/u,
  pass: /(?<![A-Za-zıİ0-9_])PASS(?![A-Za-zıİ0-9_])|패스\p{White_Space}*인증|모바일\p{White_Space}*PASS|통신사\p{White_Space}*PASS/iu,
  kakao: /카카오(\p{White_Space}*톡)?\p{White_Space}*(인증|로그인)|kakao\p{White_Space}*auth/iu,
  naver: /네이버\p{White_Space}*(인증|로그인)|naver\p{White_Space}*auth/iu,
  toss: /토스\p{White_Space}*(인증|로그인)|(?<![A-Za-zıİ0-9_])toss(?![A-Za-zıİ0-9_])/iu,
  certificate: /금융\p{White_Space}*인증|공동\p{White_Space}*인증|공동인증서/u,
  // 복지로는 모든 공개 화면 머리말에 '공동인증서 내보내기'가 있다. 인증하라는 단서가 아니다.
  certificateTool: /인증서\p{White_Space}*(내보내기|가져오기|복사|관리|안내|발급|갱신|찾기|삭제)|인증\p{White_Space}*마크|품질\p{White_Space}*인증/u,
  authNews: /점검|공지사항|이용\p{White_Space}*안내|서비스\p{White_Space}*안내|사용\p{White_Space}*방법|이용\p{White_Space}*방법/u,
};

const apps = [
  ["PASS", authPatterns.pass], ["카카오톡", authPatterns.kakao], ["네이버", authPatterns.naver],
  ["토스", authPatterns.toss], ["금융인증서", authPatterns.certificate],
] as const;
const textTypes = new Set(["text", "email", "tel", "password", "number"]);
export type AuthPageKind = "login" | "verification" | "captcha" | "other";

export function accessBlocked(view: WebObservation): boolean {
  return authPatterns.accessBlock.test(`${view.title ?? ""} ${head(view.outline?.mainText ?? "", 600)}`);
}

function instructions(mainText: string): string {
  return head(mainText, 800).split(authPatterns.sentence)
    .filter(sentence => authPatterns.doItNow.test(sentence) &&
      (authPatterns.onPage.test(sentence) || !authPatterns.describes.test(sentence)))
    .join(" ");
}

export function passwordFields(view: WebObservation) {
  return (view.fields ?? []).filter(field => field.visible === true && field.type === "password");
}

function authItems(outline: WebObservation["outline"]): string[] {
  return (outline?.items ?? []).flatMap(item => item.name !== undefined && item.name.length > 0 && item.region !== "menu" &&
    !authPatterns.certificateTool.test(item.name) && !authPatterns.authNews.test(item.name) ? [item.name] : []);
}

function viewHaystack(view: WebObservation): string {
  const outline = view.outline;
  return [
    view.title ?? "", head(outline?.mainText ?? "", 800),
    // 화면 위에 뜬 레이어 팝업(kind "layer")은 간편인증 홍보 같은 안내가 많아 인증 단서로 보지 않는다. 대화상자만 본다.
    ...(view.dialogs ?? []).filter(dialog => dialog.kind !== "layer")
      .flatMap(dialog => [dialog.title ?? "", dialog.text ?? "", ...(dialog.buttons ?? [])]),
    ...authItems(outline),
    ...(view.fields ?? []).flatMap(field => field.label !== undefined && field.label.length > 0 && field.visible === true ? [field.label] : []),
  ].join("\n");
}

export function verificationApp(view: WebObservation) {
  const text = viewHaystack(view);
  return apps.find(([, pattern]) => pattern.test(text))?.[0];
}

export function authPageKind(view: WebObservation): AuthPageKind {
  const title = view.title ?? "";
  const outline = view.outline;
  const visible = (view.fields ?? []).filter(field => field.visible === true);
  const controls = visible.map(field => field.label ?? "").join(" ") + " " + (outline?.items ?? []).map(item => item.name ?? "").join(" ");
  if (authPatterns.captcha.test(controls) ||
    (!accessBlocked(view) && authPatterns.captcha.test(`${title} ${head(outline?.mainText ?? "", 600)}`))) return "captcha";
  if (view.pageId === "mock-login" || passwordFields(view).length > 0) return "login";
  if (authPatterns.login.test(title)) return "login";
  const names = [...visible.map(field => field.label ?? ""), ...authItems(outline)];
  const told = instructions(outline?.mainText ?? "");
  if (authPatterns.verification.test(title) || names.some(name => authPatterns.verifyControl.test(name)) ||
    authPatterns.verifyChoose.test(told) || verificationApp({ ...view, outline: { ...outline, mainText: told } }) !== undefined) {
    return "verification";
  }
  return "other";
}

export function stillNeedsAuth(view: WebObservation): boolean {
  return authPageKind(view) !== "other";
}

export function firstFillField(view: WebObservation) {
  const fields = (view.fields ?? []).filter(field => field.visible === true && (field.fieldId?.length ?? 0) > 0 &&
    field.type !== undefined && textTypes.has(field.type));
  return fields.find(field => field.type !== "password") ?? fields[0];
}
