import { casefold, rstrip, rstripChars, splitWhitespace, strip, stripChars } from "./text.ts";

// 행동 승인과 대화 선택에 쓰는 말. 승인에는 문장 전체가 맞아야 한다.
//
// 정규식 옮긴 규칙(Python regex 모듈 기준)
// - \s는 White_Space다(re와 달리 U+001C~U+001F를 넣지 않는다).
// - I 표지에서 소문자 i는 İ(U+0130)에도, 대문자 I는 ı(U+0131)에도 맞는다. JS는 k↔K(켈빈), s↔ſ만 같으므로 i를 [iİ]로 쓴다.
// - 원본의 B는 ASCII 경계다. I 표지 아래에서는 [A-Za-z]가 ı와 İ도 받는다.
const S = String.raw`\p{White_Space}`;
const WORD = String.raw`A-Za-zıİ0-9_`;
const B = String.raw`(?:(?<![${WORD}])(?=[${WORD}])|(?<=[${WORD}])(?![${WORD}]))`;

const ENGLISH_APPROVE = String.raw`^(yes|yeah|yep|ok|okay|sure|approve[d]?|[iİ] approve|conf[iİ]rm(ed)?|go ahead|do [iİ]t|proceed)${B}[${S},.!]*(please|approve|go ahead|proceed)?[.!]*$`;
const ENGLISH_REJECT = String.raw`^(no|nope|don'?t|cancel|reject|not now)${B}`;
const AUTH_SUBJECT = String.raw`(?:(?:본인${S}*인증|인증|로그${S}*인)(?:[을를이가은는])?${S}*)?`;
const AUTH_INPUT_DONE = String.raw`${AUTH_SUBJECT}(?:다${S}*)?(?:입력했|넣었)(?:어요?|습니다|다)`;

const KOREAN = {
  explicitApprove: String.raw`(?:(?:모의${S}*접수|네|예|응)[,${S}]*)?승인(?:합니다|할게요?|해${S}*줘|이요)?`,
  plainYes: String.raw`(?:네|예|응|눌러(?:${S}*줘|주세요)?|진행(?:해${S}*줘|해|하세요)?|보내${S}*줘|보내세요)[,${S}]*(?:접수해|진행해|좋아)?`,
  reject: String.raw`^(아니|아뇨|아니요|아니야|틀렸어|취소|거절)|(승인${S}*안|하지${S}*마|안${S}*할래|보내지${S}*마)`,
};

const sources = {
  approve: {
    en: ENGLISH_APPROVE,
    zh: String.raw`^(是的?|好的?|对|行|可以|确认|同意|批准|继续)[吧啊。！!，, ]*(确认|同意|批准|继续)?[吧。！!]*$`,
    ja: String.raw`^(はい|ええ|うん|承認(します)?|お願いします|確認しました|進めて(ください)?|オーケー|オッケー)[、。！! ]*(承認します|お願いします|進めてください)?[。！!]*$`,
  },
  reject: {
    en: ENGLISH_REJECT,
    zh: String.raw`^(不|不要|不用|取消|拒绝|算了)`,
    ja: String.raw`^(いいえ|いや|やめて|キャンセル|拒否|結構です)`,
  },
};

/** 앞뒤를 고정한 정규식: Python의 fullmatch */
function whole(source: string, flags: string): RegExp {
  return new RegExp(String.raw`^(?:${source})$`, flags);
}

export const lexiconPatterns = {
  approve: new Map([
    ["en", new RegExp(sources.approve.en, "iu")],
    ["zh", new RegExp(sources.approve.zh, "u")],
    ["ja", new RegExp(sources.approve.ja, "u")],
  ]),
  reject: new Map([
    ["en", new RegExp(sources.reject.en, "iu")],
    ["zh", new RegExp(sources.reject.zh, "u")],
    ["ja", new RegExp(sources.reject.ja, "u")],
  ]),
  rejectWhole: new Map([
    ["ko", whole(KOREAN.reject, "u")],
    ["en", whole(sources.reject.en, "iu")],
    ["zh", whole(sources.reject.zh, "u")],
    ["ja", whole(sources.reject.ja, "u")],
  ]),
  rejectKo: new RegExp(KOREAN.reject, "u"),
  explicitApproveKo: whole(KOREAN.explicitApprove, "u"),
  plainYesKo: whole(KOREAN.plainYes, "u"),
  authAck: new RegExp(String.raw`^(?:네|예|응|yes|yeah|はい|好的)[${S},.，、。]+`, "iu"),
  authInputDone: whole(AUTH_INPUT_DONE, "u"),
  done: [
    whole(AUTH_INPUT_DONE, "u"),
    whole(String.raw`${AUTH_SUBJECT}(?:다${S}*)?(?:(?:완료했|완료됐|했|끝났|마쳤|됐)(?:어요?|습니다|다)|완료|끝)`, "u"),
    whole(String.raw`(?:[iİ](?:['’]?m|${S}+am)${S}+)?(?:all${S}+)?(?:done|f[iİ]n[iİ]shed)(?:${S}+(?:w[iİ]th${S}+)?(?:s[iİ]gn[ -]?[iİ]n|log[ -]?[iİ]n|ver[iİ]f[iİ]cat[iİ]on))?`, "iu"),
    whole(String.raw`(?:我)?(?:已经|已經)?(?:好了|完成了|做完了|弄好了)`, "u"),
    whole(String.raw`(?:(?:ログイン|認証)(?:が|は|を)?)?(?:終わりました|終わった|完了しました|できました)`, "u"),
  ],
  cancel: [
    whole(String.raw`${AUTH_SUBJECT}(?:취소|그만)(?:해${S}*(?:줘요?|주세요|요)?|하세요|할게요?|요)?`, "u"),
    whole(String.raw`(?:please${S}+)?cancel(?:${S}+(?:the${S}+|my${S}+)?(?:s[iİ]gn[ -]?[iİ]n|log[ -]?[iİ]n|ver[iİ]f[iİ]cat[iİ]on|authent[iİ]cat[iİ]on))?(?:,?${S}+please)?`, "iu"),
    whole(String.raw`(?:请|請)?取消(?:登录|登入|验证|驗證)?`, "u"),
    whole(String.raw`(?:(?:ログイン|認証)を)?(?:キャンセル|取り消し)(?:して(?:ください)?|します)?`, "u"),
  ],
  ackTail: new RegExp(String.raw`[.!~?,${S}]+$`, "u"),
  ack: /^(응\p{White_Space}*)?(알았어|알았어요|알겠어|알겠어요|알겠습니다|알았습니다|알았고|오케이|오키|그래|그래요|그렇구나|그렇군요|고마워|고마워요|감사합니다|네\p{White_Space}*알겠어요|응\p{White_Space}*그래)$/u,
  no: /^(아니|아니야|아니요|아뇨|아니에요|아냐|됐어|괜찮아|괜찮아요|아니\p{White_Space}*괜찮아)$/u,
};

/** Python의 EXPLICIT_APPROVE_KO.fullmatch(text)가 필요한 곳은 이 정규식의 test를 쓴다(앞뒤를 이미 고정했다). */
export const EXPLICIT_APPROVE_KO = lexiconPatterns.explicitApproveKo;

const YES = new Set(["네", "예", "응", "어", "맞아", "맞아요", "맞습니다", "그래", "그래요", "좋아", "네맞아요", "응맞아",
  "yes", "yeah", "はい", "是", "是的", "对"]);
const NO = new Set(["아니", "아니요", "아뇨", "아니야", "아냐", "아니에요", "틀렸어", "no", "nope", "いいえ", "不是", "不对", "不用了"]);

export function commandKey(text: string): string {
  return splitWhitespace(stripChars(casefold(text), " .!?。！？")).join("");
}

export type Approval = "approve" | "reject";

const permissionEnding = String.raw`도\s*(?:돼요?|됩니다|괜찮(?:아요?|습니다))[.!。！~]*$`;
const grantedEnding = new RegExp(permissionEnding, "u");
const offeredPermission = new RegExp(
  String.raw`^(?:(?:네|예|응|그래요?|좋아요?)[\s,!.]*)?(?:(?:그거|그걸|그것|그|이)\s*(?:버튼|링크|항목)?(?:은|는|을|를)?\s*)?(?:(?:그대로|그렇게|바로|그냥|계속)\s*)?(?:눌러|누르셔|열어|여셔|(?:클릭|선택|진행|계속)?(?:해|하셔))` + permissionEnding, "u",
);

export function permitsOfferedAction(text: string): boolean {
  return offeredPermission.test(text.trim());
}

export function asksActionPermission(text: string): boolean {
  const permission = /(?:눌러|누르셔|열어|여셔|(?:클릭|선택|입력|제출|저장|삭제|진행)(?:해|하셔))도\s*(?:돼|되|될|됩|괜찮)/u;
  return permission.test(text) && !grantedEnding.test(text.trim());
}

export function approval(text: string, lang = "ko"): Approval | undefined {
  let t = strip(text);
  if (lang === "ko") {
    t = rstrip(rstripChars(t, ".!。"));
    if (lexiconPatterns.explicitApproveKo.test(t) || lexiconPatterns.plainYesKo.test(t)) return "approve";
    if (lexiconPatterns.rejectKo.test(t)) return "reject";
    return undefined;
  }
  const approve = lexiconPatterns.approve.get(lang);
  if (approve === undefined) return undefined;
  if (approve.test(t)) return "approve";
  if (lexiconPatterns.reject.get(lang)?.test(t) === true) return "reject";
  return undefined;
}

export function foreignApproval(text: string, lang: string): Approval | undefined {
  return lang === "ko" ? undefined : approval(text, lang);
}

export function wholeRejection(text: string, lang: string): boolean {
  const pattern = lexiconPatterns.rejectWhole.get(lang);
  return pattern !== undefined && pattern.test(rstrip(rstripChars(strip(text), ".!。！~")));
}

export function agree(text: string): "yes" | "no" | undefined {
  const key = commandKey(text);
  if (YES.has(key)) return "yes";
  if (NO.has(key)) return "no";
  return undefined;
}

function authStatement(text: string, whole = false): string {
  const t = rstrip(rstripChars(strip(text), ".!。！~"));
  return whole ? t : t.replace(lexiconPatterns.authAck, "");
}

export function authInputDone(text: string): boolean {
  return lexiconPatterns.authInputDone.test(authStatement(text));
}

export function doneReply(text: string, { whole = false }: { whole?: boolean } = {}): boolean {
  const statement = authStatement(text, whole);
  return lexiconPatterns.done.some(pattern => pattern.test(statement));
}

export function cancelReply(text: string): boolean {
  const t = rstrip(rstripChars(strip(text), ".!。！~"));
  return lexiconPatterns.cancel.some(pattern => pattern.test(t));
}

/** 맞장구("알았어")만 한 말이면 "ack", 부정("아니")만 한 말이면 "no", 둘 다 아니면 undefined. 끝의 문장부호·공백은 무시한다. */
export function ackKind(text: string): "ack" | "no" | undefined {
  const t = strip(text.replace(lexiconPatterns.ackTail, ""));
  const ack = lexiconPatterns.ack.test(t);
  const no = lexiconPatterns.no.test(t);
  if (!ack && !no) return undefined;
  return no ? "no" : "ack";
}
