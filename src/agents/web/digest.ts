import type { Redacted } from "../../core/llm.ts";
import { strip } from "../../core/text.ts";
import { tryUrl } from "../../core/url.ts";
import type { PiiScanner } from "../../safety/pii_model.ts";
import { redactText, redactTextWindow } from "../../safety/privacy.ts";
import type { WebItem, WebObservation } from "./view.ts";

export const PAGE_KIND_LABEL = {
  blank: "빈 화면", blocked: "접속 차단 안내", form: "입력 양식", "search-results": "검색 결과",
  article: "글 본문", list: "목록", page: "일반 페이지",
} as const;
export type PageKind = keyof typeof PAGE_KIND_LABEL;
export interface PageControl {
  kind: "tab" | "menu" | "button"; name: string; selected?: boolean; expanded?: boolean;
}
export interface PageDigest {
  kind: PageKind; url: string; title: string; headings: string[]; main: string; body: string;
  contentLinks: string[]; menu: string[]; buttons: string[]; hasSearchBox: boolean; inputCount: number;
  dialogs: string[]; canDo: string[]; controls: PageControl[]; footer: string;
}

const p = {
  blocked: /(접속이\p{White_Space}*차단|접근이\p{White_Space}*차단|비정상적인\p{White_Space}*접근|자동\p{White_Space}*입력\p{White_Space}*방지|unusual traff[iİ]c|are you a robot|captcha|access den[iİ]ed)/iu,
  utility: /^(본문\p{White_Space}*바로\p{White_Space}*가기|(주|메인)\p{White_Space}*메뉴\p{White_Space}*바로\p{White_Space}*가기|건너뛰기|맨\p{White_Space}*위로|top|sk[iİ]p to (ma[iİ]n )?content)(?=\n?$)/iu,
  spaces: /\p{White_Space}+/gu,
  utilityButton: /^(글자\p{White_Space}*(크게|작게|확대|축소)|화면\p{White_Space}*(크게|작게|확대|축소|인쇄)|인쇄(하기)?|프린트|engl[iİ]sh|eng|中文|日本語|ch[iİ]nese|japanese|한국어|language|언어\p{White_Space}*선택|(이전|다음|정지|재생|일시\p{White_Space}*정지|멈춤)\p{White_Space}*(배너|슬라이드)|(배너|슬라이드)\p{White_Space}*(이전|다음|정지|재생)|정지|재생|일시\p{White_Space}*정지|공유(하기)?|페이스북|트위터|카카오\p{White_Space}*스토리|블로그|맨\p{White_Space}*위로|top|본문\p{White_Space}*바로\p{White_Space}*가기|건너뛰기)(?=\n?$)/iu,
  newlines: /\n+/gu, digit: /\p{Nd}/u,
  uiLine: /^(찜하기|신청하기|모의계산|목록|즐겨찾기|공유하기|공유|인쇄|프린트|더\p{White_Space}*보기|닫기|열기|top|맨\p{White_Space}*위로|로그인|로그아웃|회원가입|사이트맵|고객센터|검색|전체메뉴|메뉴|홈|home|이전|다음|확인|취소)(?=\n?$)/iu,
  trailer: /^(만족도\p{White_Space}*평가|이\p{White_Space}*페이지(에서|의)\p{White_Space}*(제공하는\p{White_Space}*)?정보에|페이지\p{White_Space}*만족도|저작권|copyr[iİ]ght|개인정보\p{White_Space}*처리\p{White_Space}*방침|이용\p{White_Space}*약관|관련\p{White_Space}*사이트)/iu,
  sentenceEnd: /([다요죠]|니다|세요)[.!?]?(?=\n?$)|[.!?](?=\n?$)/u,
  selected: /\p{White_Space}*선택됨(?=\n?$)/u,
  searchResults: /검색\p{White_Space}*결과|search results/iu,
};
export { p as digestPatterns };

function clean(text: string): string { return strip(text.replace(p.spaces, " ")); }
function unique(values: readonly string[]): string[] { return [...new Set(values.map(clean).filter(v => v.length > 0))]; }

function controls(view: WebObservation): PageControl[] {
  const outline = view.outline;
  const items: WebItem[] = outline?.items ?? (outline?.buttons ?? []).map(b => ({ ...b, role: "button" }));
  const seen = new Set<string>(), result: PageControl[] = [];
  for (const item of items) {
    const name = clean(item.name ?? "");
    if (item.role === "link" || item.role === "scriptlink" || item.disabled === true ||
        name.length === 0 || seen.has(name) || p.utilityButton.test(name)) continue;
    seen.add(name);
    result.push({
      kind: item.role === "tab" ? "tab" : item.role === "menuitem" ? "menu" : "button", name,
      ...(item.selected === undefined ? {} : { selected: item.selected }),
      ...(item.expanded === undefined ? {} : { expanded: item.expanded }),
    });
  }
  const rank = (control: PageControl) => control.kind === "tab" ? 0 : control.expanded !== undefined ? 1 : 2;
  return result.sort((a, b) => rank(a) - rank(b));
}

function readableBody(main: string): string {
  const lines = main.split("\n").map(line => strip(line.replace(p.selected, ""))).filter(line => line.length > 0 && !p.uiLine.test(line));
  const first = lines.findIndex(line => {
    const length = Array.from(line).length;
    return length >= 40 || (length >= 20 && p.sentenceEnd.test(line));
  });
  if (first < 0) return lines.join("\n");
  const start = first > 0 && Array.from(lines[first - 1]!).length <= 30 ? first - 1 : first;
  const end = lines.findIndex((line, i) => i > start && p.trailer.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

function classify(view: WebObservation, main: string, linkCount: number, inputCount: number): PageKind {
  const url = view.url ?? "", title = view.title ?? "";
  if (view.pageId === "blank" || url.length === 0 || url === "about:blank") return "blank";
  const body = Array.from(main);
  if (p.blocked.test(title + " " + body.slice(0, 600).join(""))) return "blocked";
  if (view.pageId === "mock-welfare" || inputCount >= 2) return "form";
  const parsed = tryUrl(url);
  if (["query", "q", "keyword", "search", "searchWrd", "kwd"].some(k => (parsed?.param(k) ?? "").length > 0) ||
      p.searchResults.test(title)) return "search-results";
  if (linkCount >= 15) return "list";
  return body.length > 600 ? "article" : "page";
}

export function digestPage(view: WebObservation, { preserveRows = false } = {}): PageDigest {
  const o = view.outline;
  const menu = unique(o?.menuLinks ?? []).filter(name => !p.utility.test(name));
  const menuSet = new Set(menu);
  const mainLinks = o?.mainLinks ?? unique(o?.links ?? []).filter(name => !menuSet.has(name));
  const contentLinks = unique(mainLinks).filter(name => !p.utility.test(name));
  const buttons = unique((o?.buttons ?? []).filter(b => b.disabled !== true).map(b => b.name ?? ""));
  const fields = (view.fields ?? []).filter(f => f.visible === true);
  const hasSearchBox = fields.some(f => f.searchable === true), inputCount = fields.filter(f => f.searchable !== true).length;
  const rows = (o?.mainText ?? "").split(p.newlines);
  // Evidence needs short values and repeated labels in their original row order.
  const main = (preserveRows ? rows.map(clean).filter(Boolean) : unique(rows)
    .filter(line => (Array.from(line).length > 2 || p.digit.test(line)) && !menuSet.has(line) && !p.utility.test(line))).join("\n");
  const title = view.title ?? "";
  const headings = unique((o?.headings ?? []).map(h => h.text ?? "")).filter(heading => heading !== strip(title));
  const kind = classify(view, main, contentLinks.length, inputCount);
  const canDo = [];
  if (main.length > 0) canDo.push("본문 읽기");
  if (contentLinks.length > 0) canDo.push(kind === "search-results" ? "검색 결과 열기" : "내용 링크 열기");
  if (hasSearchBox) canDo.push("이 사이트에서 검색");
  if (menu.length > 0) canDo.push("메뉴 이동");
  if (inputCount > 0) canDo.push("입력 칸 " + inputCount + "개 채우기");
  return {
    kind, url: view.url ?? "", title, headings, main, body: readableBody(main), contentLinks, menu, buttons,
    hasSearchBox, inputCount, canDo, dialogs: (view.dialogs ?? []).map(d => d.title ?? ""), controls: controls(view), footer: o?.footerText ?? "",
  };
}

export function flatMain(d: PageDigest): string { return d.main.replace(p.newlines, " / "); }

export function needlePattern(needle: string): RegExp | undefined {
  const letters = Array.from(needle.replace(p.spaces, ""), ch => ch.replace(/[.*+?^{}$()|[\]\\]/gu, "\\$&"));
  return letters.length === 0 ? undefined : new RegExp(letters.join("\\p{White_Space}*"), "u");
}

export function textOffset(d: PageDigest, needle: string): number | undefined {
  const flat = flatMain(d);
  const match = needlePattern(needle)?.exec(flat);
  if (match == null) return undefined;
  const prefix = flat.slice(0, match.index);
  const separator = prefix.lastIndexOf(" / ");
  return separator < 0 ? 0 : Array.from(prefix.slice(0, separator + 3)).length;
}

// 이미 가린 문장을 잘라도 사용자 원문이 다시 들어오지 않는다.
export function cutRedacted(text: Redacted, limit: number): Redacted {
  return Array.from(text).slice(0, limit).join("") as Redacted;
}

type Scanner = Pick<PiiScanner, "scan">;
export async function pageTextForLlm(d: PageDigest, { limit = 3000, scanner }: { limit?: number; scanner?: Scanner } = {}): Promise<[string, Redacted]> {
  const raw = [...d.headings.slice(0, 6), d.main].join("\n");
  const [spans] = await scanner?.scan([raw]) ?? [];
  return [Array.from(raw).slice(0, limit).join(""), cutRedacted(redactText(raw, spans), limit)];
}

export function digestItems(d: PageDigest, maxLinks = 30) {
  const content = d.contentLinks.slice(0, maxLinks);
  const menuAll = d.menu.filter(name => !content.includes(name));
  const controlsAll = d.controls.filter(control => !content.includes(control.name) && !menuAll.includes(control.name));
  let spare = Math.max(0, maxLinks - content.length) + Math.max(0, 12 - menuAll.length);
  const nControls = Math.min(controlsAll.length, 12 + spare);
  spare -= Math.max(0, nControls - 12);
  const menu = menuAll.slice(0, 12 + Math.max(0, spare));
  return [...content.map(name => ({ kind: "link" as const, name })), ...menu.map(name => ({ kind: "menu" as const, name })), ...controlsAll.slice(0, nControls)];
}

export async function digestForLlm(d: PageDigest, { offset = 0, mainChars = 1500, maxLinks = 30, scanner }: {
  offset?: number; mainChars?: number; maxLinks?: number; scanner?: Scanner;
} = {}) {
  const main = flatMain(d);
  const headings = d.headings.slice(0, 8);
  const texts = [d.title, ...headings, ...d.dialogs, main, d.footer];
  const spans = await scanner?.scan(texts);
  const safe = texts.map((text, index) => index === texts.length - 2
    ? redactTextWindow(text, offset, mainChars, spans?.[index])
    : redactText(text, spans?.[index]));
  return {
    url: d.url, title: safe[0]!, kind: PAGE_KIND_LABEL[d.kind], headings: safe.slice(1, 1 + headings.length),
    items: digestItems(d, maxLinks),
    hasSearchBox: d.hasSearchBox, dialogs: safe.slice(1 + headings.length, -2), mainText: safe.at(-2)!,
    moreText: Array.from(main).length > offset + mainChars, footer: cutRedacted(safe.at(-1)!, 400),
  };
}
