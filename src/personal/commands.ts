import { asciiDecimalDigits, strip } from "../core/text.ts";
import { speakDate } from "../speech/phrasing.ts";
import { localDay } from "./action_log.ts";
import { SECRET, type Application, type SpeechPatch, type Vault, type VaultKey } from "./store.ts";

export const commandsPatterns = {
  space: /\p{White_Space}/gu,
  labelName: /(성명|이름|신청인명|성함)/u,
  labelAddress: /(주소|거주지|도로명)/u,
  labelPhone: /(연락처|전화|휴대폰|휴대전화|핸드폰|휴대번호)/u,
  labelEmail: /(이메일|전자우편|email)/iu,
  labelBirth: /(생년월일|생일)/u,
  valueName: /(?:이름|성명|성함)\p{White_Space}*(?:은|는|이|가)?\p{White_Space}*([가-힣a-zA-Z ]{2,20}?)(?=\p{White_Space}*(?:이라고|라고|이고|이며|이야|이에요|예요|야|고|,|\.|(?=\n?$)|그리고|주소|연락처|전화|이메일|생년월일))/u,
  valueAddress: /주소\p{White_Space}*(?:는|은|가)?\p{White_Space}*([^\n]+?)(?=\p{White_Space}*(?:이라고|라고|이고|이며|이야|이에요|예요|고\p{White_Space}|,\p{White_Space}*(?:이름|연락처|전화|이메일|생년월일)|\.|(?=\n?$)|그리고))/u,
  valuePhone: /(?:연락처|전화\p{White_Space}*번호|전화|휴대폰\p{White_Space}*번호|휴대폰)\p{White_Space}*(?:는|은|가)?\p{White_Space}*(0\p{Nd}{1,2}[-\p{White_Space}]?\p{Nd}{3,4}[-\p{White_Space}]?\p{Nd}{4})/u,
  valueEmail: /(?:이메일|메일)\p{White_Space}*(?:은|는)?\p{White_Space}*([A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.]+)/iu,
  valueBirth: /(?:생년월일|생일)\p{White_Space}*(?:은|는)?\p{White_Space}*(\p{Nd}{4}\p{White_Space}*년\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*월\p{White_Space}*\p{Nd}{1,2}\p{White_Space}*일|\p{Nd}{4}[-.]\p{Nd}{1,2}[-.]\p{Nd}{1,2})/u,
  punctuation: /[.,](?=\n?$)/u,
  monthDay: /(\p{Nd}{1,2})\p{White_Space}*월\p{White_Space}*(\p{Nd}{1,2})\p{White_Space}*일/u,
  daysLater: /(\p{Nd}{1,3})\p{White_Space}*일\p{White_Space}*(뒤|후)/u,
  tomorrow: /내일/u,
  dayAfterTomorrow: /모레/u,
  service: /([가-힣]{2,20}(?:연금|수당|급여|바우처|지원금|장려금|지원|사업|감면|할인|보험료))/u,
  spaces: /\p{White_Space}+/gu,
  settingsRead: /(말하기\p{White_Space}*)?(설정|음성\p{White_Space}*설정)\p{White_Space}*(알려|읽어|뭐|확인)/u,
  prefsRead: /(말하는\p{White_Space}*속도|답\p{White_Space}*길이|목소리|진행\p{White_Space}*상황)\p{White_Space}*(알려|읽어)/u,
  resetPrefs: /(말하기\p{White_Space}*)?(설정|음성\p{White_Space}*설정)\p{White_Space}*(지워|초기화|기본)/u,
  progressOn: /(진행\p{White_Space}*상황|중간\p{White_Space}*보고)[^\n]*(말해|알려|켜)|진행\p{White_Space}*상황\p{White_Space}*말해/u,
  progressOff: /(진행\p{White_Space}*상황|중간\p{White_Space}*보고)[^\n]*(끄|조용|그만)|조용히\p{White_Space}*해/u,
  slow: /(천천히|느리게)\p{White_Space}*(말해|말해줘|읽어)/u,
  fast: /(빨리|빠르게)\p{White_Space}*(말해|말해줘|읽어)/u,
  normalSpeed: /(보통\p{White_Space}*속도|원래\p{White_Space}*속도|속도\p{White_Space}*원래)/u,
  short: /(짧게|간단히|짧게만)\p{White_Space}*(말해|말해줘|답)/u,
  detailed: /(자세히|길게|자세히만)\p{White_Space}*(말해|말해줘|답)/u,
  normalLength: /(보통\p{White_Space}*길이|답\p{White_Space}*길이\p{White_Space}*원래)/u,
  voice: /목소리\p{White_Space}*(?:는|을|를)?\p{White_Space}*([^\n]+?)(?:으로|로)?\p{White_Space}*(?:해\p{White_Space}*줘|해줘|바꿔|변경)?(?=\n?$)/u,
  queryVoice: /(알려|읽어|뭐)/u,
  logRead: /(오늘\p{White_Space}*)?(한\p{White_Space}*일|한\p{White_Space}*거|조작\p{White_Space}*기록|행동\p{White_Space}*기록)\p{White_Space}*(들려|알려|읽어)|오늘\p{White_Space}*(뭐\p{White_Space}*했|한\p{White_Space}*일)/u,
  siteRead: /(정보\p{White_Space}*공유|사이트\p{White_Space}*허용|허용한\p{White_Space}*사이트|공유\p{White_Space}*허용)[^\n]*(알려|읽어|뭐|목록)/u,
  whichSite: /어느\p{White_Space}*사이트[^\n]*(정보|허용)/u,
  siteClear: /(정보\p{White_Space}*공유|사이트\p{White_Space}*허용|허용한\p{White_Space}*사이트)[^\n]*(지워|삭제|취소|초기화)/u,
  asking: /\?(?=\n?$)|(해야\p{White_Space}*(해|돼|하나|되나)|언제|되나요|했나|했어\?|했나요)/u,
  mine: /(내|제|저장된|저장한)\p{White_Space}*(개인\p{White_Space}*)?정보/u,
  clear: /(지워|삭제|없애)/u,
  read: /(알려|읽어|뭐|확인)/u,
  saveVerbs: /(저장해|기억해)/u,
  save: /(저장|기억|등록)\p{White_Space}*(해|해줘|해\p{White_Space}*줘|해\p{White_Space}*주세요|할래)/u,
  fieldList: /(정보|이름|성명|주소|연락처|전화|이메일|생년월일)/u,
  appStatus: /(신청\p{White_Space}*(한|했던)\p{White_Space}*(거|것|제도|내역)|신청\p{White_Space}*(현황|내역|목록)|접수\p{White_Space}*(상태|현황)|어떻게\p{White_Space}*됐)/u,
  deadline: /(보완|서류|제출|마감|기한|까지)/u,
  supplementary: /보완/u,
  done: /(결과\p{White_Space}*(나왔|받았)|지급\p{White_Space}*(됐|받았)|처리\p{White_Space}*(됐|끝났)|선정\p{White_Space}*됐)/u,
  applied: /([^\n]+?)\p{White_Space}*(?:을|를)?\p{White_Space}*(?:신청|접수)\p{White_Space}*(?:했어|했어요|했다|했습니다|완료했|마쳤|끝냈)/u,
  intro: /^(나|저|방금|오늘|어제|드디어)\p{White_Space}*/u,
  receipt: /(?:접수|신청)\p{White_Space}*번호\p{White_Space}*(?:는|은|가)?\p{White_Space}*([0-9A-Za-z-]{4,30})/u,
};

const patterns = commandsPatterns;
const labels = [
  ["name", patterns.labelName, patterns.valueName], ["address", patterns.labelAddress, patterns.valueAddress],
  ["phone", patterns.labelPhone, patterns.valuePhone], ["email", patterns.labelEmail, patterns.valueEmail],
  ["birth", patterns.labelBirth, patterns.valueBirth],
] as const;

export function vaultKeyForLabel(label: string): VaultKey | undefined {
  const text = label.replace(patterns.space, "");
  return labels.find(([, pattern]) => pattern.test(text))?.[0];
}
export function parseVaultValues(text: string): Vault {
  const values: Vault = {};
  for (const [key, ,pattern] of labels) {
    const value = strip(pattern.exec(text)?.[1] ?? "").replace(patterns.punctuation, "");
    if (value.length > 0 && !SECRET.test(value)) values[key] = value;
  }
  return values;
}
// 달력 계산만 UTC에서 하므로 일광 절약 시간 변경에 영향받지 않는다.
function shiftedDay(today: string, days: number) {
  const date = new Date(today + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function parseDate(text: string, today = localDay()): string | undefined {
  const md = patterns.monthDay.exec(text);
  if (md !== null) {
    const year = Number(today.slice(0, 4));
    const month = Number(asciiDecimalDigits(md[1]!)) - 1;
    const day = Number(asciiDecimalDigits(md[2]!));
    const calendar = (year: number) => new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
    const date = calendar(year);
    return date < today ? calendar(year + 1) : date;
  }
  const after = patterns.daysLater.exec(text);
  if (after !== null) return shiftedDay(today, Number(asciiDecimalDigits(after[1]!)));
  if (patterns.tomorrow.test(text)) return shiftedDay(today, 1);
  if (patterns.dayAfterTomorrow.test(text)) return shiftedDay(today, 2);
  return undefined;
}
export function daysUntil(target: string, today = localDay()) {
  return (Date.parse(target + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000;
}
type SpeechCommand = { kind: "speech-read" | "speech-clear" } | { kind: "speech-set"; values: SpeechPatch };
export type PersonalCommand = SpeechCommand | { kind: "action-log-read" | "site-allow-read" | "site-allow-clear" |
  "vault-read" | "app-status" } | { kind: "vault-clear" } | { kind: "vault-save"; values: Vault } |
  { kind: "app-due"; service?: string; dueDate: string; note: string } | { kind: "app-done"; service?: string } |
  { kind: "app-record"; service: string; receiptNo?: string };

export function parseSpeechPref(text: string): SpeechCommand | undefined {
  const t = strip(text.replace(patterns.spaces, " "));
  if (patterns.settingsRead.test(t) || patterns.prefsRead.test(t)) return { kind: "speech-read" };
  if (patterns.resetPrefs.test(t)) return { kind: "speech-clear" };
  const settings = [
    [patterns.progressOn, { progressSpoken: true }], [patterns.progressOff, { progressSpoken: false }],
    [patterns.slow, { rate: 0.9 }, "천천히"], [patterns.fast, { rate: 1.5 }, "빨리"], [patterns.normalSpeed, { rate: 1.25 }],
    [patterns.short, { length: "short" }, "짧게"], [patterns.detailed, { length: "detailed" }, "자세히"],
    [patterns.normalLength, { length: "normal" }],
  ] satisfies [RegExp, SpeechPatch, string?][];
  for (const [pattern, values, also] of settings) {
    if (pattern.test(t) || t === also) return { kind: "speech-set", values };
  }
  const voice = strip(patterns.voice.exec(t)?.[1] ?? "");
  if (voice.length > 0 && !patterns.queryVoice.test(t)) {
    if (["기본", "원래", "기본값"].includes(voice)) return { kind: "speech-set", values: { voice: null } };
    const length = Array.from(voice).length;
    if (length > 1 && length <= 40) return { kind: "speech-set", values: { voice } };
  }
  return undefined;
}
export function parsePersonalCommand(text: string, today = localDay()): PersonalCommand | undefined {
  const t = strip(text.replace(patterns.spaces, " "));
  const speech = parseSpeechPref(t);
  if (speech !== undefined) return speech;
  if (patterns.logRead.test(t)) return { kind: "action-log-read" };
  if (patterns.siteRead.test(t) || patterns.whichSite.test(t)) return { kind: "site-allow-read" };
  if (patterns.siteClear.test(t)) return { kind: "site-allow-clear" };
  if (patterns.mine.test(t)) {
    if (patterns.clear.test(t)) return { kind: "vault-clear" };
    if (patterns.read.test(t) && !patterns.saveVerbs.test(t)) return { kind: "vault-read" };
  }
  if (patterns.save.test(t) && patterns.fieldList.test(t)) return { kind: "vault-save", values: parseVaultValues(t) };
  if (patterns.appStatus.test(t)) return { kind: "app-status" };
  if (patterns.asking.test(t)) return undefined;
  const dueDate = parseDate(t, today);
  if (dueDate !== undefined && patterns.deadline.test(t)) return {
    kind: "app-due", dueDate, service: patterns.service.exec(t)?.[1], note: patterns.supplementary.test(t) ? "보완 서류 제출" : "제출 기한",
  };
  if (patterns.done.test(t)) return { kind: "app-done", service: patterns.service.exec(t)?.[1] };
  const subject = patterns.applied.exec(t)?.[1];
  if (subject !== undefined) {
    const service = patterns.service.exec(subject)?.[1] ?? strip(subject.replace(patterns.intro, ""));
    const length = Array.from(service).length;
    if (length >= 2 && length <= 30) return { kind: "app-record", service, receiptNo: patterns.receipt.exec(t)?.[1] };
  }
  return undefined;
}
export function dueReminder(apps: readonly Application[], today = localDay()): string | undefined {
  const notices = [];
  for (const app of apps) {
    if (app.done === true || app.dueDate === undefined) continue;
    const left = daysUntil(app.dueDate, today);
    if (left > 3) continue;
    const when = left < 0 ? `${-left}일 지났어요` : left === 0 ? "오늘까지예요" : `${left}일 남았어요`;
    notices.push(`${app.service} ${app.dueNote !== undefined && app.dueNote.length > 0 ? app.dueNote : "기한"}이 ${speakDate(app.dueDate)}까지, ${when}.`);
  }
  return notices.length > 0 ? notices.join(" ") : undefined;
}
