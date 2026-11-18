import type { Redacted } from "../core/llm.ts";

export const SENSITIVE_LABELS_KO = {
  password: "비밀번호", otp: "인증번호", rrn: "주민등록번호", account: "계좌번호",
  card: "카드번호", idnum: "신분증 번호", health: "건강정보",
};
export type SensitiveKind = keyof typeof SENSITIVE_LABELS_KO;
// 위치는 원문의 유니코드 코드 포인트 기준이다.
export type SecretSpan = readonly [kind: SensitiveKind, start: number, end: number];
export const REDACTED = "[비공개]";

const noticeStart = "보안을 위해 ";
const noticeMiddle = "는 저에게 말하지 마세요. 방금 말씀하신 값은 저장하거나 화면에 입력하지 않았습니다. ";
const loginInstructions = ["인증이 필요하면 '로그인하고 싶어'라고 말씀하시고, 열린 화면에 직접 입력해 주세요.", "인증 화면의 입력란에 키보드로 직접 입력해 주세요."];
const labels = new Set<string>(Object.values(SENSITIVE_LABELS_KO));
export const POSSIBLE_SECRET_NOTICE = "혹시 비밀번호나 인증번호라면 저에게 말하지 말고 화면의 입력란에 직접 입력해 주세요. 명령이었다면 한 번 더 말씀해 주세요.";

export function disclosureNotice(kinds: readonly SensitiveKind[], onLogin: boolean) {
  return noticeStart + (kinds.length === 0 ? "민감 정보" : kinds.map(k => SENSITIVE_LABELS_KO[k]).join(", ")) + noticeMiddle + loginInstructions[onLogin ? 1 : 0];
}

function isFixedGuidance(text: string) {
  if (text === POSSIBLE_SECRET_NOTICE) return true;
  if (/^(?:[1-9]|10)\. (?:비밀번호|인증번호), 보안 입력란, (?:선택|필수), 직접 입력해야 하는 칸\.$/u.test(text) && text.endsWith(".")) return true;
  if (!text.startsWith(noticeStart)) return false;
  const cut = text.indexOf(noticeMiddle, noticeStart.length);
  if (cut < 0 || !loginInstructions.includes(text.slice(cut + noticeMiddle.length))) return false;
  const names = text.slice(noticeStart.length, cut);
  return names === "민감 정보" || names.split(", ").every(name => labels.has(name));
}

export function joinRedacted(parts: readonly Redacted[]): Redacted {
  return parts.filter(s => s.length > 0).join(" ") as Redacted;
}

export function historyLine(role: "user" | "assistant", text: Redacted): Redacted {
  return ((role === "user" ? "사용자: " : "청음: ") + Array.from(text).slice(0,400).join("")) as Redacted;
}

const p = {
  passwordKo: /(비밀\p{White_Space}*번호|비번|패스\p{White_Space}*워드|암호(?!화)|핀\p{White_Space}*번호)/u,
  password: /(password|passcode|密码|密碼|パスワード|暗証番号|(?<![A-Za-z0-9_İı])P[Iı]N(?![A-Za-z0-9_İı]))/iu,
  otpKo: /(OTP|일회용\p{White_Space}*(비밀)?\p{White_Space}*번호|인증\p{White_Space}*번호|보안\p{White_Space}*코드)/iu,
  otp: /(验证码|驗證碼|認証コード|確認コード|ver[iİ]f[iİ]cat[iİ]on\p{White_Space}*code|one[-\p{White_Space}]?t[iİ]me\p{White_Space}*(pass(word|code)?|code))/iu,
  rrn: /(주민\p{White_Space}*(등록)?\p{White_Space}*번호|외국인\p{White_Space}*등록\p{White_Space}*번호)/u,
  account: /(계좌\p{White_Space}*(번호)?)/u,
  card: /(카드\p{White_Space}*번호)/u,
  idnum: /(여권\p{White_Space}*번호|운전\p{White_Space}*면허\p{White_Space}*(증\p{White_Space}*)?번호)/u,
  health: /(진단명|병명|질병명|병력|처방\p{White_Space}*내역)/u,
  rrnValue: /\p{Nd}{6}\p{White_Space}*-\p{White_Space}*[1-8]\p{Nd}{6}|(?<!\p{Nd})\p{Nd}{6}[1-8]\p{Nd}{6}(?!\p{Nd})/u,
  cardValue: /(?<!\p{Nd})(?:\p{Nd}{4}[- ]){3}\p{Nd}{4}(?!\p{Nd})/u,
  spoken: /[공영일이삼사오육륙칠팔구](?:[ -]?[공영일이삼사오육륙칠팔구]){3,}/u,
  separators: /[ -]/gu,
  lead: /^(?:은|는|이|가|을|를|도|의|란|이란|요)?[\p{White_Space}:：,.、~!?-]*/u,
  aboutIt: /^(어디|뭐|무엇|무슨|어떤|어떻게|어케|왜|몇|칸|란|창|입력|넣|써|쓰|적|채워|직접|잊|까먹|몰라|모르|기억|찾|변경|바꾸|바꿔|바꿀|재설정|초기화|틀|안\p{White_Space}|안(?=\n?$)|안돼|오류|에러|확인|규칙|조건|자리|글자|만들|설정|보여|보이|가려|가리|숨겨|화면|페이지|버튼|메뉴|필요|때문|대신|말고|없|다음|이전|그거|이거|저거|관련|문제|방법|요구|물어|있)/u,
  endingOnly: /^(이?야|예요|이에요|입니다|이다|임|요)[\p{White_Space}.!?~]*$/u,
  offer: /^(알려\p{White_Space}*(줄게|줄께|드릴게)|말할게|말해\p{White_Space}*줄게|불러\p{White_Space}*줄게|말씀\p{White_Space}*드릴게)/u,
  spokenRrn: /\p{Nd}{6}[1-8]\p{Nd}{6}/u,
  spokenCard: /\p{Nd}{16}/u,
  healthParticles: /[은는이가:\p{White_Space}]/gu,
  healthQuestion: /(뜻|의미|뭐)/u,
  digit: /\p{Nd}/u,
  latinWord: /[A-Za-z]{4,}/u,
  offerValue: /[^\p{White_Space},.!?。~]/u,
  nonDigit: /\P{Nd}/gu,
  hangul: /[가-힣]/u,
};
export { p as privacyPatterns };

const keywords: ReadonlyArray<readonly [SensitiveKind, RegExp, boolean]> = [
  ["password", p.passwordKo, true], ["password", p.password, false],
  ["otp", p.otpKo, true], ["otp", p.otp, false], ["rrn", p.rrn, false],
  ["account", p.account, false], ["card", p.card, false], ["idnum", p.idnum, false], ["health", p.health, false],
];
const valuePatterns: ReadonlyArray<readonly [SensitiveKind, RegExp]> = [["rrn", p.rrnValue], ["card", p.cardValue]];
const digitNames = "공영일이삼사오육륙칠팔구";
const digits = "001234566789";

export function spokenDigitSpans(text: string): Array<[number, number, string]> {
  const spans: Array<[number, number, string]> = [];
  let previousUnit = 0, previousPoint = 0;
  for (const match of text.matchAll(new RegExp(p.spoken, "gu"))) {
    const start = previousPoint + Array.from(text.slice(previousUnit, match.index)).length;
    const end = start + match[0].length; // Only Hangul syllables and ASCII separators.
    const number = Array.from(match[0].replace(p.separators, ""), ch => digits.charAt(digitNames.indexOf(ch))).join("");
    spans.push([start, end, number]);
    previousUnit = match.index + match[0].length;
    previousPoint = end;
  }
  return spans;
}

function spokenValueKind(number: string): SensitiveKind | undefined {
  if (p.spokenRrn.test(number)) return "rrn";
  if (p.spokenCard.test(number)) return "card";
  return undefined;
}

function hasValueAfter(kind: SensitiveKind, after: string, strict: boolean): boolean {
  if (kind === "health") return Array.from(after.replace(p.healthParticles, "")).length >= 2 && !p.healthQuestion.test(after);
  if (p.digit.test(after) || p.latinWord.test(after) || p.spoken.test(after)) return true;
  if (!strict) return false;
  const rest = after.replace(p.lead, "");
  if (rest.length === 0 || p.endingOnly.test(rest)) return false;
  const offer = p.offer.exec(rest);
  return offer === null ? !p.aboutIt.test(rest) : p.offerValue.test(rest.slice(offer[0].length));
}

export function detectSensitive(text: string, modelSpans: readonly SecretSpan[] = []) {
  const kinds = new Set<SensitiveKind>();
  let hasSecretValue = false;
  for (const [kind, pattern, strict] of keywords) {
    const match = pattern.exec(text);
    if (match === null) continue;
    kinds.add(kind);
    hasSecretValue ||= hasValueAfter(kind, text.slice(match.index + match[0].length), strict);
  }
  for (const [kind, pattern] of valuePatterns) {
    if (pattern.test(text)) {
      kinds.add(kind);
      hasSecretValue = true;
    }
  }
  for (const [, , number] of spokenDigitSpans(text)) {
    const kind = spokenValueKind(number);
    if (kind !== undefined) {
      kinds.add(kind);
      hasSecretValue = true;
    }
  }
  for (const [kind] of modelSpans) {
    kinds.add(kind);
    hasSecretValue = true;
  }
  return { kinds: [...kinds], hasSecretValue };
}

interface TextWindow { start: number; end: number }

// 가려진 값이 원문 범위와 겹치면 마스킹 문구 전체를 보여 준다. 경계만 맞닿으면 제외한다.
function projectMask(window: TextWindow | undefined, start: number, end: number, length: number): void {
  if (window === undefined) return;
  const delta = length - (end - start);
  if (window.start >= end) window.start += delta;
  else if (window.start > start) window.start = start;
  if (window.end >= end) window.end += delta;
  else if (window.end > start) window.end = start + length;
}

function redact(text: string, modelSpans: readonly SecretSpan[], window?: TextWindow): Redacted {
  if (modelSpans.length === 0 && isFixedGuidance(text)) return (window === undefined ? text : text.slice(window.start, window.end)) as Redacted;
  const spans: Array<[number, number]> = modelSpans.map(([, start, end]) => [start, end]);
  for (const [start, end, number] of spokenDigitSpans(text)) {
    if (spokenValueKind(number) !== undefined) spans.push([start, end]);
  }
  let out = text;
  if (spans.length > 0) {
    const merged: Array<[number, number]> = [];
    for (const [start, end] of spans.sort(([a], [b]) => a - b)) {
      const last = merged.at(-1);
      if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    const points = Array.from(text), parts: string[] = [];
    let cursor = 0, units = 0;
    for (const [start, end] of merged) {
      const plain = points.slice(cursor, start).join("");
      units += plain.length;
      if (window !== undefined) projectMask(window, units, units + points.slice(start, end).join("").length, REDACTED.length);
      parts.push(plain, REDACTED);
      units += REDACTED.length;
      cursor = end;
    }
    parts.push(points.slice(cursor).join(""));
    out = parts.join("");
  }
  for (const [, pattern] of valuePatterns) {
    let delta = 0;
    out = out.replace(new RegExp(pattern, "gu"), (match: string, rawIndex: number) => {
      const index = rawIndex + delta;
      projectMask(window, index, index + match.length, REDACTED.length);
      delta += REDACTED.length - match.length;
      return REDACTED;
    });
  }
  for (const [kind, pattern, strict] of keywords) {
    const match = pattern.exec(out);
    if (match === null) continue;
    const end = match.index + match[0].length;
    if (hasValueAfter(kind, out.slice(end), strict)) {
      projectMask(window, end, out.length, 1 + REDACTED.length);
      out = out.slice(0, end) + " " + REDACTED;
    }
  }
  return (window === undefined ? out : out.slice(window.start, window.end)) as Redacted;
}

export function redactText(text: string, modelSpans: readonly SecretSpan[] = []): Redacted {
  return redact(text, modelSpans);
}

/** 앞선 마스킹으로 글이 짧아져도 위치와 길이는 원문 코드 포인트로 센다. */
export function redactTextWindow(text: string, offset: number, length: number, modelSpans: readonly SecretSpan[] = []): Redacted {
  const points = Array.from(text);
  const start = points.slice(0, offset).join("").length;
  const end = points.slice(0, offset + length).join("").length;
  if (end <= start) return redactText("");
  return redact(text, modelSpans, { start, end });
}

export function maskValue(value: string): string {
  const number = Array.from(value.replace(p.nonDigit, ""));
  if (number.length >= 9) return number.slice(0, 3).join("") + "-****-" + number.slice(-4).join("");
  const points = Array.from(value);
  if (points.length <= 2) return "*".repeat(points.length);
  return points[0] + "*".repeat(points.length - 2) + points.at(-1);
}
