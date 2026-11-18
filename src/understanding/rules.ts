import type { Fill, Intent } from "../core/intents.ts";
import type { ModelIntentContext, Redacted } from "../core/llm.ts";
import { strip } from "../core/text.ts";
import { stripAddress } from "./filters.ts";
import { mentionsKnownSite } from "./sites.ts";

export interface IntentContext {
  state: string;
  awaitingFieldId?: string;
}

export interface IntentProvider {
  readonly name: string;
  parse(text: Redacted, ctx: ModelIntentContext): Promise<Intent>;
}

export const rulesPatterns = {
  metacharacters: /[.*+?^${}()|[\]\\]/gu,
  aliasSeparators: /[\p{White_Space}·.]/gu,
  stop: /(멈춰|멈추|멈춤|중지|중단|그만|정지|스톱|잠깐|취소|(?:(?<![A-Za-z0-9_İı])(?=[A-Za-z0-9_İı])|(?<=[A-Za-z0-9_İı])(?![A-Za-z0-9_İı]))(stop|halt)(?:(?<![A-Za-z0-9_İı])(?=[A-Za-z0-9_İı])|(?<=[A-Za-z0-9_İı])(?![A-Za-z0-9_İı]))|停止|停下|停一下|别动|暂停|請停|请停|別動|暫停|止めて|止まって|ストップ|やめて|中止)/iu,
  negatedStop: /(취소\p{White_Space}*(하지|안)|멈추지\p{White_Space}*마)/u,
  progress: /^(?:지금|현재|아직|그거)?\p{White_Space}*(?:어디까지\p{White_Space}*(?:했|됐|왔|갔|진행|하고\p{White_Space}*있)|얼마나\p{White_Space}*(?:남았|했|됐|걸려|더\p{White_Space}*걸려|진행)|(?:뭐|뭘|무엇을?)\p{White_Space}*(?:하고\p{White_Space}*있|하는\p{White_Space}*중)|멀었|언제\p{White_Space}*(?:끝나|다\p{White_Space}*돼))/u,
  edgeQuotes: /^["'“”‘’「」]+|["'“”‘’「」.,!?。]+(?=\n?$)/gu,
  quotedCommand: /\p{White_Space}*(이?라고)\p{White_Space}*(써|입력해|적어)?\p{White_Space}*줘?(요)?(?=\n?$)/u,
  valueCommand: /\p{White_Space}*(으로|로)\p{White_Space}*(해|입력해|적어|써|바꿔|수정해)\p{White_Space}*줘?(요)?(?=\n?$)/u,
  politeEnding: /(이에요|예요|입니다|이야|이요|이고요)(?=\n?$)/u,
  politeName: /[가-힣]{2,}(야|요)(?=\n?$)/u,
  digit: /\p{Nd}/u,
  serviceName: /([가-힣]{2,12}(?:연금|수당|급여|바우처|지원금|장려금|지원사업))/u,
  listedService: /(첫|두|세|네|다섯|\p{Nd}{1,2})\p{White_Space}*번\p{White_Space}*째\p{White_Space}*(제도|복지|서비스|혜택)/u,
  help: /^(?:(?:너|넌|너는|청음|청음은|청음이는)\p{White_Space}*)?(?:(?:뭐라고|어떻게)\p{White_Space}*(?:말|얘기)\p{White_Space}*(?:하면|해야)|뭐라고\p{White_Space}*(?:하면|해야)|(?:뭐라고|무슨\p{White_Space}*말을?)\p{White_Space}*(?:말\p{White_Space}*)?할\p{White_Space}*수\p{White_Space}*있|(?:뭘|뭐|무엇을?)\p{White_Space}*할\p{White_Space}*수\p{White_Space}*있|할\p{White_Space}*수\p{White_Space}*있는\p{White_Space}*(?:말|것|거|게)|도움말|사용\p{White_Space}*법|사용\p{White_Space}*방법|명령어|다른\p{White_Space}*(?:말|명령)(?!\p{White_Space}*로))/u,
  moreHelp: /^다른|(?:^|\p{White_Space})(?:더|또)(?:\p{White_Space}|(?=\n?$))/u,
  beforeGoThere: /(\P{White_Space}+?)\p{White_Space}*(?:에서|들어가서|가서|열고|열어서|접속해서)/gu,
  here: /(?:^|\p{White_Space})(?:이|여기|지금|현재|이곳)(?=\p{White_Space}|(?=\n?$))/u,
  commandSeparator: /\p{White_Space}*(?:[,，]|그리고|그\p{White_Space}*다음에?|그런\p{White_Space}*다음에?|다음에는|한\p{White_Space}*다음에?|하고\p{White_Space}*나서|그러고\p{White_Space}*나서)\p{White_Space}+/gu,
  sentenceEnd: /[.!。]+(?=\n?$)/u,
  spaces: /\p{White_Space}+/gu,
  serviceNumber: /(\p{Nd}{1,2})\p{White_Space}*번/u,
  search: /^(?:([^\n]+?)에서\p{White_Space}*)?["'“‘]?([^\n]+?)["'”’]?\p{White_Space}*(?:을|를)?\p{White_Space}*(?:검색|찾아\p{White_Space}*줘|찾아봐)/u,
  queryPrefix: /^(에서|좀)\p{White_Space}*/u,
  quotesAnywhere: /["'“”‘’「」]/gu,
  linkCommand: /\p{White_Space}*(링크|메뉴|탭|버튼)?\p{White_Space}*(을|를|좀)?\p{White_Space}*(눌러|클릭|열어|들어가|선택|가\p{White_Space}*줘)\P{White_Space}*[^\n]*(?=\n?$)/u,
  slot: /^([^\n]+?)\p{White_Space}*(?:칸|란|입력란|입력\p{White_Space}*칸)\p{White_Space}*에\p{White_Space}*([^\n]+?)\p{White_Space}*(?:을|를)?\p{White_Space}*(?:써|입력해|넣어|적어)\p{White_Space}*(?:줘|주세요|줄래)?(?=\n?$)/u,
  edit: /(수정|고칠|고쳐|바꿀|바꿔|변경|틀렸|잘못)/u,
  editCommand: /^(수정|고칠|고쳐|바꿀|바꿔|변경|틀렸|잘못)\P{White_Space}*\p{White_Space}*/u,
  punctuationPrefix: /^[:,]\p{White_Space}*/u,
  fieldSeparator: /\p{White_Space}*[,，]\p{White_Space}*|\p{White_Space}+(?:그리고|또)\p{White_Space}+/u,
};

export function escapeRe(value: string): string {
  return value.replace(rulesPatterns.metacharacters, "\\$&");
}

export function aliasExpressions(alias: string) {
  const pattern = Array.from(alias.replace(rulesPatterns.aliasSeparators, "")).map(escapeRe).join("[\\p{White_Space}·.]*");
  return {
    alias,
    re: new RegExp("^(?:(?:제|내|저의|신청인)\\p{White_Space}*)?(?:" + pattern
      + ")(?:\\p{White_Space}*(?:은|는|이|가|을|를|:)\\p{White_Space}*|\\p{White_Space}+)([^\\n]+)(?=\\n?$)", "u"),
    anyRe: new RegExp(pattern, "u"),
  };
}

export function isStopUtterance(text: string): boolean {
  return rulesPatterns.stop.test(text) && !rulesPatterns.negatedStop.test(text);
}

export function isProgressQuestion(text: string): boolean {
  const content = stripAddress(text);
  return Array.from(content).length <= 20 && rulesPatterns.progress.test(content);
}

export function cleanValue(raw: string): string {
  let value = strip(strip(raw).replace(rulesPatterns.edgeQuotes, ""))
    .replace(rulesPatterns.quotedCommand, "").replace(rulesPatterns.valueCommand, "").replace(rulesPatterns.politeEnding, "");
  if (rulesPatterns.politeName.test(value)) value = value.slice(0, -1);
  return strip(value.replace(rulesPatterns.edgeQuotes, ""));
}

export function goesToAnotherSite(text: string): boolean {
  if (rulesPatterns.here.test(text)) return false;
  for (const match of text.matchAll(rulesPatterns.beforeGoThere)) {
    if (match[1] !== undefined && mentionsKnownSite(match[1])) return true;
  }
  return false;
}

function optionalMention(mention: string | undefined) {
  return mention === undefined ? {} : { fieldMention: mention };
}

export class RuleBasedIntentProvider implements IntentProvider {
  readonly name = "mock-rule";
  readonly aliases: ReadonlyArray<ReturnType<typeof aliasExpressions>>;
  readonly commandBoundary: RegExp;

  constructor(vocabulary: readonly string[]) {
    const aliasLength = (name: string) => Array.from(name.replace(rulesPatterns.aliasSeparators, "")).length;
    this.aliases = [...vocabulary].sort((a, b) => aliasLength(b) - aliasLength(a)).map(aliasExpressions);
    const fieldWords = this.aliases.map(item => escapeRe(item.alias)).join("|");
    this.commandBoundary = new RegExp("(이)?고\\p{White_Space}+(?=(" + fieldWords
      + "|다음|이전|그리고|모의|제출|화면|본문|링크|검색|뒤로))", "gu");
  }

  mention(text: string): string | undefined {
    return this.aliases.find(item => item.anyRe.test(text))?.alias;
  }

  private fillSegment(segment: string): Fill | undefined {
    for (const item of this.aliases) {
      const capture = item.re.exec(strip(segment))?.[1];
      if (capture === undefined) continue;
      const value = cleanValue(capture);
      if (value.length > 0) return { fieldMention: item.alias, value };
    }
    return undefined;
  }

  splitCommands(input: string): string[] {
    const marked = strip(input).replace(this.commandBoundary, " ␟ ").replace(rulesPatterns.commandSeparator, " ␟ ");
    const parts = marked.split("␟").map(strip).filter(value => value.length > 0);
    return parts.length > 1 ? parts : [strip(input)];
  }

  async parse(input: string, ctx: IntentContext): Promise<Intent> {
    return this.parseSync(input, ctx);
  }

  parseSync(input: string, ctx: IntentContext): Intent {
    const text = strip(input).replace(rulesPatterns.spaces, " ").replace(rulesPatterns.sentenceEnd, "");
    const { state } = ctx;
    if (isStopUtterance(text)) {
      return { type: "STOP" };
    }
    if (isProgressQuestion(text)) {
      return { type: "PROGRESS" };
    }
    if (/(다시\p{White_Space}*시작|재개|계속\p{White_Space}*(해|하자|진행))/u.test(text)) {
      return { type: "RESUME" };
    }
    if (/(거절|승인\p{White_Space}*안|하지\p{White_Space}*마|안\p{White_Space}*할래)/u.test(text)
      || (state === "WAITING_FOR_USER_CONFIRMATION"
      && /^(아니|아뇨|아니요|아니야|틀렸어|취소)/u.test(text))) {
      return { type: "REJECT" };
    }
    if (/승인/u.test(text) || (state === "WAITING_FOR_USER_CONFIRMATION" && /^(네|예|응|눌러|진행)[,\p{White_Space}]*(접수해|진행해|좋아)?/u.test(text))) {
      return { type: "APPROVE" };
    }
    if (/(인증|로그인)[^\n]*(끝났|완료|했어)/u.test(text) || (state === "AUTH_HANDOFF" && /^다\p{White_Space}*했어/u.test(text))) {
      return { type: "AUTH_DONE" };
    }
    if (/로그\p{White_Space}*아웃|로그인\p{White_Space}*(기록|쿠키|정보)[^\n]*(지워|삭제|없애)|로그인\p{White_Space}*풀어/u.test(text)) {
      return { type: "CLEAR_LOGIN" };
    }
    if (/(받은\p{White_Space}*파일|다운로드)[^\n]*(읽어|들려|알려|목록|뭐\p{White_Space}*있)|파일\p{White_Space}*읽어/u.test(text)) {
      return { type: "READ_DOWNLOAD", list: /목록|뭐\p{White_Space}*있|어떤/u.test(text) };
    }
    if (state === "AUTH_HANDOFF" && /^(다\p{White_Space}*)?(입력|넣었)/u.test(text)) {
      return { type: "LOGIN" };
    }
    if (/(로그인|본인\p{White_Space}*인증|간편\p{White_Space}*인증)/u.test(text) && !/로그\p{White_Space}*아웃/u.test(text)) {
      return { type: "LOGIN" };
    }
    if (/(접수|제출)/u.test(text) && /(확인했|확인할게|최종|해\p{White_Space}*줘|해(?=\n?$)|할게|하자|진행)/u.test(text)) {
      return { type: "PREPARE_SUBMIT" };
    }
    if (/최종\p{White_Space}*확인/u.test(text)) {
      return { type: "PREPARE_SUBMIT" };
    }
    if (/(사람|상담원|상담사)[^\n]*(도움|연결|바꿔)|도움\p{White_Space}*요청/u.test(text)) {
      return { type: "HELP_HUMAN" };
    }
    if (rulesPatterns.help.test(text)) {
      return { type: "WHAT_CAN_I_SAY", more: rulesPatterns.moreHelp.test(text) };
    }
    // 다른 사이트를 찾아가는 요청과 현재 화면에 대한 질문을 구분한다.
    const elsewhere = goesToAnotherSite(text);
    if (!elsewhere
      && /(이|여기|지금|이곳)\p{White_Space}*(사이트|홈페이지|누리집|웹사이트|곳)\P{White_Space}*\p{White_Space}*(뭐|무슨|어떤|뭘|뭐\p{White_Space}*하는)|(무슨|어떤|뭐\p{White_Space}*하는)\p{White_Space}*(사이트|홈페이지|누리집|곳)(이야|야|인가요|예요|이에요|인지)/u.test(text)) {
      return { type: "ABOUT_SITE" };
    }
    if (!elsewhere && /(화면|페이지)[^\n]*(설명|읽어|뭐가|뭐\p{White_Space}*있|어떻게\p{White_Space}*생|전체|묘사)|뭐가\p{White_Space}*있어|화면에\p{White_Space}*뭐/u.test(text)) {
      return { type: "DESCRIBE_SCREEN" };
    }
    if (!elsewhere && /(지금|현재|어디)[^\n]*(단계|화면|위치)|(화면|단계)[^\n]*(설명|알려|어디)/u.test(text)) {
      return { type: "CURRENT_STEP" };
    }
    const selected = rulesPatterns.serviceNumber.exec(text)?.[0] ?? rulesPatterns.serviceName.exec(text.replace(rulesPatterns.spaces, ""))?.[1];
    const service = selected === undefined ? {} : { service: selected };
    if (/^(\p{Nd}{1,2})\p{White_Space}*번\p{White_Space}*(자세히|설명|뭐야|알려|내용)/u.test(text)) {
      return { type: "SERVICE_DETAIL", ...service };
    }
    if (/(자격|받을\p{White_Space}*수\p{White_Space}*있는지|해당(되는지|돼|될까)|대상인지|대상이야)/u.test(text)
      && /(확인|봐|알려|점검|살펴|될까|돼|맞아|야\?|인지)/u.test(text)
      && !/(뭐|어떤|무슨)\p{White_Space}*(복지|혜택|제도)/u.test(text)) {
      return { type: "PRECHECK", ...service };
    }
    if (/신청/u.test(text) && /(준비|서류|뭐가?\p{White_Space}*필요|필요한\p{White_Space}*(것|거|서류|게))/u.test(text)) {
      return { type: "PREPARE_APPLY", ...service };
    }
    if (!mentionsKnownSite(text)
      && !/(눌러|클릭)/u.test(text)
      && (/(받을\p{White_Space}*수\p{White_Space}*있는|해당\p{White_Space}*되는|나한테\p{White_Space}*맞는|나에게\p{White_Space}*맞는|맞춤|추천)[^\n]*(복지|혜택|지원|제도|서비스)/u.test(text)
      || /(복지|혜택|지원금?|제도)\p{White_Space}*(을|를|좀|가)?\p{White_Space}*(찾아|추천|뭐\p{White_Space}*있|있을까|알아봐)/u.test(text))) {
      return { type: "DISCOVER" };
    }
    if (/^(크롬|chrome|브라우저|인터넷)\p{White_Space}*(창\p{White_Space}*)?(좀\p{White_Space}*)?(켜|열어|띄워|실행|시작)/iu.test(text) && !mentionsKnownSite(text)) {
      return { type: "OPEN_BROWSER" };
    }
    if (mentionsKnownSite(text) && /(에서|가서|들어가서|열고|열어서|접속해서)/u.test(text) && /(알려|찾아|읽어|확인|보여|있는지|뭐\p{White_Space}*있|정리)/u.test(text)) {
      return { type: "GOAL", goal: text };
    }
    if (/(쉽게\p{White_Space}*(다시\p{White_Space}*)?(말해|설명|얘기)|무슨\p{White_Space}*말(이야|인지|이에요)|이해가?\p{White_Space}*(안|잘\p{White_Space}*안)\p{White_Space}*(돼|가)|못\p{White_Space}*알아듣|다시\p{White_Space}*(한\p{White_Space}*번\p{White_Space}*)?말해\p{White_Space}*줘|천천히\p{White_Space}*(다시\p{White_Space}*)?말해)/u.test(text)
      && this.mention(text) === undefined) {
      return { type: "REPHRASE" };
    }
    if (/(무슨\p{White_Space}*뜻|뜻이|뜻은|의미|설명해|뭘\p{White_Space}*써야|뭐\p{White_Space}*쓰는)/u.test(text) && !rulesPatterns.listedService.test(text)) {
      return { type: "EXPLAIN", ...optionalMention(this.mention(text)) };
    }
    if (/(지원\p{White_Space}*대상|신청\p{White_Space}*(방법|절차)|선정\p{White_Space}*기준|소득인정액|자격|받을\p{White_Space}*수\p{White_Space}*있|누가\p{White_Space}*받|얼마\p{White_Space}*(받|나와|줘|지급)|지원\p{White_Space}*금액|지급액|필요한?\p{White_Space}*서류|서식|어디에?\p{White_Space}*문의)/u.test(text)
      && !/(눌러|클릭)/u.test(text)) {
      return { type: "POLICY_QUESTION", topic: text };
    }
    if (/(지금|현재)[^\n]*(신청|접수)[^\n]*(할\p{White_Space}*수|가능|돼|되나)|(신청|접수)\p{White_Space}*(기간|마감|기한)/u.test(text) && !/(눌러|클릭|열어|시작|도와)/u.test(text)) {
      return { type: "POLICY_QUESTION", topic: text };
    }
    if ((/장애인\p{White_Space}*연금/u.test(text)
      && /(신청|도와)/u.test(text)
      && !/검색/u.test(text))
      || /신청\p{White_Space}*(페이지|화면|서)?\p{White_Space}*(를|을)?\p{White_Space}*(열어|시작|도와)/u.test(text)) {
      return { type: "START_APPLICATION" };
    }
    if (/(연금|수당|급여|바우처|지원금|장려금|복지|소득인정액|선정기준액)/u.test(text)
      && /(\?|뭐|무엇|어떻게|어디|언제|얼마|몇|되나요|돼|가능|알려\p{White_Space}*줘|궁금)/u.test(text)
      && !/(검색|열어|눌러)/u.test(text)) {
      return { type: "POLICY_QUESTION", topic: text };
    }
    const search = rulesPatterns.search.exec(text);
    if (search?.[2] !== undefined && /검색|찾아/u.test(text)) {
      const value = cleanValue(search[2]).replace(rulesPatterns.queryPrefix, "");
      if (value.length > 0) {
        const query = Array.from(value).slice(0, 100).join("");
        const site = strip(search[1] ?? "");
        return site.length > 0 ? { type: "SEARCH", query, site } : { type: "SEARCH", query };
      }
    }
    if (/(뒤로\p{White_Space}*가|이전\p{White_Space}*페이지|돌아가)/u.test(text)) {
      return { type: "PREV" };
    }
    if (/(링크|메뉴)\p{White_Space}*(더|나머지|계속)?\p{White_Space}*(목록|뭐|뭐가|알려|읽어|있)/u.test(text)) {
      return { type: "LIST_LINKS", more: /더|계속|나머지|다음/u.test(text) };
    }
    if ((/(링크|메뉴|탭|버튼)/u.test(text) && /(눌러|클릭|열어|들어가|선택|가\p{White_Space}*줘)/u.test(text))
      || /(눌러|클릭해)/u.test(text)) {
      const name = strip(text.replace(rulesPatterns.quotesAnywhere, "").replace(rulesPatterns.linkCommand, ""));
      if (name.length > 0) return { type: "FOLLOW_LINK", name };
    }
    if (/(열어|접속|들어가|이동해|가\p{White_Space}*줘|켜\p{White_Space}*줘|띄워)/u.test(text)
      && (mentionsKnownSite(text)
      || /(사이트|홈페이지|누리집|웹\p{White_Space}*페이지|모의\p{White_Space}*복지)/u.test(text))) {
      return { type: "OPEN_SITE", target: text };
    }
    if (/(본문|내용|기사|글)\p{White_Space}*(을|를)?\p{White_Space}*(읽어|알려|들려)|(더|계속|이어서)\p{White_Space}*읽어|다음\p{White_Space}*내용/u.test(text)
      && !/(지금까지|입력한|작성한|쓴)/u.test(text)) {
      return { type: "READ_MAIN", more: /더|계속|이어서|다음\p{White_Space}*내용/u.test(text) };
    }
    if (/(지금까지|전체|모든|입력한|작성한|쓴)\p{White_Space}*(내용|것|거|항목)?[^\n]*(읽어|알려|요약|확인)/u.test(text) && this.mention(text) === undefined) {
      return { type: "REVIEW" };
    }
    const slot = rulesPatterns.slot.exec(text);
    if (slot?.[1] !== undefined && slot[2] !== undefined) {
      const value = cleanValue(slot[2]);
      if (value.length > 0) return { type: "FILL", fills: [{ fieldMention: strip(slot[1]), value }] };
    }
    if (/실거주지[^\n]*(달라|다름|다릅니다|따로)/u.test(text)) {
      return { type: "FILL", fills: [{ fieldMention: "실거주지가 주민등록 주소와 다릅니다", value: "예" }] };
    }

    const mention = this.mention(text);
    if (mention !== undefined && mention.length > 0) {
      const edit = rulesPatterns.edit.exec(text);
      if (edit !== null) {
        const value = cleanValue(text.slice(edit.index).replace(rulesPatterns.editCommand, "").replace(rulesPatterns.punctuationPrefix, ""));
        if (Array.from(value).length >= 2) return { type: "FILL", fills: [{ fieldMention: mention, value }] };
        return { type: "EDIT_FIELD", fieldMention: mention };
      }
      if (/(읽어|다시\p{White_Space}*말해|뭐(야|였|라고|지)|뭐로|확인해\p{White_Space}*줘|알려\p{White_Space}*줘)/u.test(text)) {
        return { type: "READ_FIELD", fieldMention: mention };
      }
      const segments = text.split(rulesPatterns.fieldSeparator).filter(value => value.length > 0);
      if (segments.length > 1) {
        const fills = segments.map(value => this.fillSegment(value));
        if (fills.every(fill => fill !== undefined)) return { type: "FILL", fills };
      }
      const single = this.fillSegment(text);
      if (single !== undefined) return { type: "FILL", fills: [single] };
    }
    if (Array.from(text).length <= 16 && !rulesPatterns.digit.test(text)) {
      if (/(다음|넘어가|넘겨)/u.test(text)) return { type: "NEXT" };
      if (/(이전|뒤로|전\p{White_Space}*단계|앞\p{White_Space}*단계)/u.test(text)) return { type: "PREV" };
    }
    return { type: "UNKNOWN", text };
  }
}
