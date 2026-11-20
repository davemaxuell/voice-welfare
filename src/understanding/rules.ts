import type { Fill, Intent } from "../core/intents.ts";
import { approval, authInputDone, doneReply, EXPLICIT_APPROVE_KO } from "../core/lexicon.ts";
import type { ModelIntentContext, Redacted } from "../core/llm.ts";
import { isPlaceRequest } from "../core/places.ts";
import { hasText, rstripChars, strip } from "../core/text.ts";
import { stripAddress } from "./filters.ts";
import { isSiteName, mentionsKnownSite, publicServiceSite } from "./sites.ts";

/** 결정적 한국어 규칙 파서(모델 없이). 입력은 이미 비식별화된 사용자 발화뿐이며, 화면 텍스트는 넣지 않는다. */
export interface IntentContext {
  state: string;
  awaitingFieldId?: string;
}

export interface IntentProvider {
  readonly name: string;
  parse(text: Redacted, ctx: ModelIntentContext): Promise<Intent>;
}

const QUESTION_END = "(?:어요?|나요?|니|죠|습니까|을까(?:요)?)";
const PROGRESS = String.raw`(?:지금|현재|아직|그거)?\p{White_Space}*(?:`
  + String.raw`어디까지\p{White_Space}*(?:(?:진행\p{White_Space}*)?(?:했|됐|왔|갔)|(?:진행)?하고\p{White_Space}*있)${QUESTION_END}`
  + String.raw`|얼마나\p{White_Space}*(?:(?:남았|(?:진행\p{White_Space}*)?(?:했|됐))${QUESTION_END}|(?:더\p{White_Space}*)?걸(?:려(?:요)?|리(?:나요|죠|니)))`
  + String.raw`|(?:뭐|뭘|무엇을?)\p{White_Space}*(?:하고\p{White_Space}*있${QUESTION_END}|하는\p{White_Space}*중(?:이야|이에요|인가요|이니)?)`
  + String.raw`|멀었${QUESTION_END}`
  + String.raw`|언제\p{White_Space}*(?:끝나(?:나요|요|니)?|끝날까(?:요)?|다\p{White_Space}*돼(?:요)?|다\p{White_Space}*되(?:나요|죠))`
  + ")";
const DOWNLOAD_NOUN = "(?:파일|문서|다운로드|PDF|피디에프|HWPX|이미지|사진)";
// 하지 말라는 말: "로그인하거나 신청하지 말고", "로그인 없이", "제출 금지", "제출은 나중에 하고".
// '못 하'·'되지 않'은 넣지 않는다: "로그인 못 하겠어, 도와줘", "로그인이 되지 않아요"는 로그인을 도와 달라는 말
const NEGATION = String.raw`[^,.?!]{0,12}?(\P{White_Space}*(?<!되)지\p{White_Space}*(말|마|않)|없이|말고|안\p{White_Space}*(하|해|할|함)|하면\p{White_Space}*안\p{White_Space}*(돼|되)|필요\p{White_Space}*없|빼고|나중에|금지|(게|건)\p{White_Space}*아니|하기\p{White_Space}*전에)`;

export const rulesPatterns = {
  restartSetup: /^(?:청음\p{White_Space}*)?(?:처음\p{White_Space}*)?설정(?:을)?\p{White_Space}*(?:처음부터\p{White_Space}*)?다시\p{White_Space}*(?:해|할래|하고\p{White_Space}*싶)/u,
  metacharacters: /[.*+?^${}()|[\]\\]/gu,
  aliasSeparators: /[\p{White_Space}·.]/gu,
  // 멈춤은 언어와 상관없이 규칙으로 즉시(번역·모델을 거치지 않음). 중국어 '停'은 '停车场' 같은 낱말에 흔해 묶음 표현만.
  stop: /^(?:(?:청음(?:아|이)?\p{White_Space}*)?(?:(?:잠깐만?|당장|긴급|지금|이제|그냥|제발|하던\p{White_Space}*일을?|이?\p{White_Space}*작업을?)\p{White_Space}*)*(?:멈춰(?:\p{White_Space}*(?:줘요?|주세요|주실래요|요|라))?|멈추(?:세요|자|어|라고)|멈춤|잠깐(?:만요?|요)?|(?:중지|중단|정지|스톱|취소|그만)(?:\p{White_Space}*(?:해(?:\p{White_Space}*(?:줘|주세요|요))?|하세요|시켜(?:줘|주세요)?|요))?)|(?:hey\p{White_Space}+)?(?:(?:can|could|would)\p{White_Space}+you\p{White_Space}+)?(?:please\p{White_Space}+)?(?:stop|halt|cancel|pause)(?:\p{White_Space}+(?:talk[iİ]ng|speak[iİ]ng|everyth[iİ]ng|[iİ]t|that|th[iİ]s|the task|the current task|now|please))*|(?:请|請|先|马上|馬上)*(?:停止|停下|停一下|别动|暂停|停|別動|暫停)(?:吧|来|來|操作|任务|任務)?|(?:今すぐ|ちょっと)?(?:止めて|止まって|ストップ|やめて|中止)(?:ください|下さい|して|してください)?)$/iu,
  stopImperative: /(?:^|\p{White_Space})(?:멈춰\p{White_Space}*(?:줘|주세요|라)|멈추세요|중단해\p{White_Space}*(?:줘|주세요))(?=\n?$)/u,
  stopClauses: /([^,.!?;，。！？、\n]+)([,.!?;，。！？、\n]*)/gu,
  cancelWord: /^(?:취소(?:요)?|cancel)$/iu,
  pictureRequest: /^(?:(?:지금|현재|이|브라우저)\p{White_Space}*)*(?:(?:전체\p{White_Space}*)?(?:웹\p{White_Space}*)?(?:페이지|화면)(?:\p{White_Space}*전체)?(?:을|를)?\p{White_Space}*(?:사진|캡처|캡쳐|스크린\p{White_Space}*샷)|스크린\p{White_Space}*샷)(?:으로|로|에서|해서|하고|을?\p{White_Space}*찍(?:어|어서|고)|을?\p{White_Space}*보고)\p{White_Space}*[^?!]*(?:설명해|알려|읽어|말해|비교해|찾아|확인해|보여)\p{White_Space}*(?:줘|주세요|주실래요)[?？]?$/u,
  noPicture: /없이|말고|하지\p{White_Space}*마|찍지\p{White_Space}*마|보내지\p{White_Space}*마|안\p{White_Space}*찍/u,
  pictureWord: /사진|캡처|캡쳐|스크린\p{White_Space}*샷|촬영/u,
  textOnly: /글로만|글만|텍스트로만|텍스트만|text[ -]only|only (?:use |read )?(?:the )?text|(?:no |w[iİ]thout |don['’]t |do not |avo[iİ]d |sk[iİ]p |never )[^.!?]{0,45}(?:screenshot|screen ?capture|page [iİ]mage)|(?:截图|截屏|屏幕截图)[^\n]{0,8}(?:不要|不用)|(?:别|不要|不用|不发|不传)[^\n]{0,12}(?:截图|截屏)|只(?:读|看|用)文字|(?:スクリーンショット|画面写真|画像|スクショ)[^\n]{0,10}(?:なし|不要|使わず|撮らず|送らず|送らない)|(?:文字|テキスト)だけ/iu,
  downloadNoun: new RegExp(DOWNLOAD_NOUN, "iu"),
  downloaded: new RegExp(String.raw`(?:받은|내려받은|다운로드한)\p{White_Space}*` + DOWNLOAD_NOUN, "iu"),
  screenWord: /(?:화면|페이지|사이트|검색|버튼|링크)/u,
  imageWord: /이미지|사진/u,
  fileWord: /파일|문서|다운로드/u,
  downloadList: /(파일|다운로드|문서)\p{White_Space}*(목록|리스트|뭐\p{White_Space}*있)|어떤\p{White_Space}*파일[^\n]*(받|있)/u,
  downloadRead: new RegExp(DOWNLOAD_NOUN + "[^\\n]*(그대로|원문|읽어|들려)", "iu"),
  downloadAnalyze: new RegExp(DOWNLOAD_NOUN + String.raw`(?:을|를|도)?\p{White_Space}*(요약|설명해)`, "iu"),
  downloadTarget: new RegExp(String.raw`(?:받은|내려받은|다운로드한|이|그)\p{White_Space}*` + DOWNLOAD_NOUN + "|" + DOWNLOAD_NOUN + "(?:에|에서|에는|의)", "iu"),
  downloadQuestion: /요약|설명해|알려|뭐야|무엇|언제|얼마|뭔가요|어떤|어떻게|몇|\?(?=\n?$)/u,
  progress: new RegExp("^(?:" + PROGRESS + ")$", "u"),
  progressStart: new RegExp("^(?:" + PROGRESS + ")", "u"),
  afterQuestion: /(?:[?!.,，。！？~]+\p{White_Space}*|\p{White_Space}+)(?:(?:그리고|그다음에?)\p{White_Space}+)?/uy,
  edgeQuotes: /^["'“”‘’「」]+|["'“”‘’「」.,!?。]+(?=\n?$)/gu,
  quotedCommand: /\p{White_Space}*(이?라고)\p{White_Space}*(써|입력해|적어)?\p{White_Space}*줘?(요)?(?=\n?$)/u,
  valueCommand: /\p{White_Space}*(으로|로)\p{White_Space}*(해|입력해|적어|써|바꿔|수정해)\p{White_Space}*줘?(요)?(?=\n?$)/u,
  politeEnding: /(이에요|예요|입니다|이야|이요|이고요)(?=\n?$)/u,
  politeName: /[가-힣]{2,}(야|요)(?=\n?$)/u,
  digit: /\p{Nd}/u,
  serviceName: /([가-힣]{2,12}(?:연금|수당|급여|바우처|지원금|장려금|지원사업))/u,
  // 찾기 결과 목록 속 제도를 순서로 가리킴("두 번째 제도"). 입력 항목 설명(EXPLAIN)이 아니다.
  listedService: /(첫|두|세|네|다섯|\p{Nd}{1,2})\p{White_Space}*번\p{White_Space}*째\p{White_Space}*(제도|복지|서비스|혜택)/u,
  // 할 수 있는 말 안내. 말 앞쪽에서만 본다("이 사이트에서 뭘 할 수 있어?"는 사이트 소개). "다른 말로 해줘"는 쉬운 말 다시 설명이라 뺀다.
  help: /^(?:(?:너|넌|너는|청음|청음은|청음이는)\p{White_Space}*)?(?:(?:뭐라고|어떻게)\p{White_Space}*(?:말|얘기)\p{White_Space}*(?:하면|해야)|뭐라고\p{White_Space}*(?:하면|해야)|(?:뭐라고|무슨\p{White_Space}*말을?)\p{White_Space}*(?:말\p{White_Space}*)?할\p{White_Space}*수\p{White_Space}*있|(?:뭘|뭐|무엇을?)\p{White_Space}*할\p{White_Space}*수\p{White_Space}*있|할\p{White_Space}*수\p{White_Space}*있는\p{White_Space}*(?:말|것|거|게)|도움말|사용\p{White_Space}*법|사용\p{White_Space}*방법|명령어|다른\p{White_Space}*(?:말|명령)(?!\p{White_Space}*로))/u,
  moreHelp: /^다른|(?:^|\p{White_Space})(?:더|또)(?:\p{White_Space}|(?=\n?$))/u,
  // 사이트 이름·주소 바로 뒤에 붙은 '에서·가서·열어서'만 '그 사이트에 가서'로 본다('화면에서'는 아니다).
  // '국민연금공단 사이트에서'처럼 사이트·홈페이지 낱말이 사이에 끼어도 같다.
  beforeGoThere: /(\P{White_Space}+?)\p{White_Space}*(?:(?:사이트|홈페이지|누리집|웹\p{White_Space}*사이트)\p{White_Space}*)?(?:에서|들어가서|가서|열고|열어서|접속해서)/gu,
  goThere: /(에서|가서|들어가서|열고|열어서|접속해서)/u,
  goalAsk: /(알려|찾아|읽어|확인|보여|있는지|뭐\p{White_Space}*있|정리)/u,
  // "공식 안내 열어줘", "2번 공식 안내 열어줘", "장애인연금 공식 안내 열어줘": 말 첫머리에서만('삼성전자 공식 사이트'는 사이트 열기)
  openOfficial: /^(?:(?:그|이|방금|아까)\p{White_Space}*)?(?:(?<num>\p{Nd}{1,2})\p{White_Space}*번\p{White_Space}*(?:의\p{White_Space}*)?|(?<name>(?!(?:그|이|방금|아까)\p{White_Space})[가-힣0-9·\p{White_Space}]{2,24}?)\p{White_Space}*(?:의\p{White_Space}*)?(?=공식\p{White_Space}*(?:안내|페이지|화면|자료)))?공식\p{White_Space}*(?:안내|페이지|화면|자료|누리집|사이트)?\p{White_Space}*(?:만|을|를|도)?\p{White_Space}*(?:좀\p{White_Space}*)?(?:열어|보여|띄워)(?!\P{White_Space}*지\p{White_Space}*(?:말|마|않))/u,
  submitNegated: new RegExp("(접수|제출)" + NEGATION, "u"),
  // 로그인은 목적어와 수행 요청이 붙어 있을 때만. 언급만 하면 정보 질문의 대상으로 남긴다.
  loginAsk: /(?:로그인|본인\p{White_Space}*인증|간편\p{White_Space}*인증)(?:만|을|이)?\p{White_Space}*(?:좀\p{White_Space}*)?(?:(?=\n?$)|해\p{White_Space}*(?:줘|주세|줄래)|하자|할래|하고\p{White_Space}*싶(?!지)|해야\p{White_Space}*해|(?:화면|페이지|창)(?:을|를)?\p{White_Space}*열어|(?:버튼\p{White_Space}*)?눌러\p{White_Space}*줘|도와\p{White_Space}*(?:줘|주세요|줄래)|연습할래|못\p{White_Space}*하|안\p{White_Space}*(?:돼|되)|되지\p{White_Space}*않)/u,
  submitAsk: /(?:접수|제출)(?:을|를)?\p{White_Space}*(?:해\p{White_Space}*(?:줘|주세요|(?=\n?$))|할게|하자|진행|(?:내용을?\p{White_Space}*)?확인(?:했|할게))/u,
  // 앞의 것을 빼고 뒤의 것만: "장애수당 말고 장애인연금", "장애수당 아니고 …", "장애수당이 아니라 …"
  notThis: /\P{White_Space}+?\p{White_Space}*(?:말고|아니고|이?\p{White_Space}*아니라)\p{White_Space}*/gu,
  // 지금 연 화면·사이트·결과의 제목이나 이름을 묻는 말(입력 칸 '이름'이 아니다)
  pageName: /(?<![가-힣])(사이트|페이지|화면|결과|글|기사|누리집|홈페이지)\p{White_Space}*(의\p{White_Space}*)?(이름|제목)/u,
  // 방금 들은 것을 한 번만 천천히 다시: "그 번호를 다시 천천히", "확인한 전화번호를 천천히 읽어줘"
  slowRepeat: /(천천히|느리게)\p{White_Space}*(다시\p{White_Space}*)?(말해|읽어)/u,
  // '다시'만으로는 아니다: "주소 다시 천천히 읽어줘"는 입력 칸 읽기
  justSaid: /(?:^|\p{White_Space})그\p{White_Space}|확인한|방금|아까/u,
  // 지금 화면·사이트를 가리키는 말
  here: /(?:^|\p{White_Space})(?:이|여기|지금|현재|이곳)(?=\p{White_Space}|(?=\n?$))/u,
  commandSeparator: /\p{White_Space}*(?:[,，]|그리고|그\p{White_Space}*다음에?|그런\p{White_Space}*다음에?|다음에는|한\p{White_Space}*다음에?|하고\p{White_Space}*나서|그러고\p{White_Space}*나서)\p{White_Space}+/gu,
  sentenceEnd: /[.!。]+(?=\n?$)/u,
  spaces: /\p{White_Space}+/gu,
  space: /\p{White_Space}/gu,
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

/** 모델과 무관하게 항상 규칙으로 즉시 판정하는 중단 명령. */
export function isStopUtterance(text: string): boolean {
  for (const [, words = "", punctuation = ""] of text.matchAll(rulesPatterns.stopClauses)) {
    const clause = strip(words);
    // 취소만 묻는 말은 결정을 열어 둔다. 분명한 멈춤 명령은 여전히 멈춘다.
    if ((punctuation.includes("?") || punctuation.includes("？")) && rulesPatterns.cancelWord.test(stripAddress(clause))) continue;
    if (rulesPatterns.stop.test(clause) || rulesPatterns.stopImperative.test(clause)) return true;
  }
  return false;
}

/** 사진 전송을 거절한 발화는 번역이나 모델의 결정 뒤에도 글로만 읽는다. */
export function wantsTextOnlyScreen(text: string): boolean {
  if (rulesPatterns.noPicture.test(text) && rulesPatterns.pictureWord.test(text)) return true;
  return rulesPatterns.textOnly.test(text);
}

export function isPictureRequest(text: string, { utterance }: { utterance?: string } = {}): boolean {
  return rulesPatterns.pictureRequest.test(text) && !rulesPatterns.noPicture.test(hasText(utterance) ? utterance : text);
}

/** READ_DOWNLOAD의 세 가지 동작. 외부 전송 여부는 사용자가 실제로 한 말에서만 정한다. */
export function downloadMode(text: string): "list" | "read" | "analyze" | undefined {
  if (!rulesPatterns.downloadNoun.test(text)) return undefined;
  const downloaded = rulesPatterns.downloaded.test(text);
  if (!downloaded && rulesPatterns.screenWord.test(text)) return undefined;
  if (!downloaded && rulesPatterns.imageWord.test(text) && !rulesPatterns.fileWord.test(text)) return undefined;
  if (rulesPatterns.downloadList.test(text)) return "list";
  if (rulesPatterns.downloadRead.test(text) && !text.includes("요약")) return "read";
  if (rulesPatterns.downloadAnalyze.test(text)) return "analyze";
  if (rulesPatterns.downloadTarget.test(text) && rulesPatterns.downloadQuestion.test(text)) return "analyze";
  return undefined;
}

/**
 * 멈춤처럼 규칙으로만 판정한다: 일하는 중에도 턴 대기열을 거치지 않고 바로 답하기 위해. 맨 앞의 부름말은 떼고 본다.
 * 다른 명령이 붙은 긴 말은 아니라고 본다(물음에만 답하고 뒤의 명령을 버리지 않게).
 */
export function isProgressQuestion(text: string): boolean {
  return rulesPatterns.progress.test(rstripChars(stripAddress(text), " .!?。！？~"));
}

/** 완전한 진행 상황 물음 뒤에 따로 붙은 요청 */
export function afterProgressQuestion(text: string): string | undefined {
  const t = stripAddress(text);
  const question = rulesPatterns.progressStart.exec(t);
  if (question === null) return undefined;
  const separator = rulesPatterns.afterQuestion;
  separator.lastIndex = question[0].length;
  const found = separator.exec(t);
  if (found === null) return undefined;
  const rest = strip(t.slice(found.index + found[0].length));
  return rest.length > 0 ? rest : undefined;
}

export function cleanValue(raw: string): string {
  let value = strip(strip(raw).replace(rulesPatterns.edgeQuotes, ""))
    .replace(rulesPatterns.quotedCommand, "").replace(rulesPatterns.valueCommand, "").replace(rulesPatterns.politeEnding, "");
  if (rulesPatterns.politeName.test(value)) value = value.slice(0, -1);
  return strip(value.replace(rulesPatterns.edgeQuotes, ""));
}

function short(text: string): boolean {
  return Array.from(text).length <= 16 && !rulesPatterns.digit.test(text);
}

/**
 * '복지로 가서 첫 화면에 뭐가 있는지 알려줘'처럼 다른 사이트에 가서 볼 일인지. 지금 화면 질문 규칙보다 먼저 본다.
 * 사이트 목록에는 '기초연금'처럼 복지 낱말도 있으므로 이름이 '에서·가서' 바로 앞에 올 때만, 그리고
 * '이·여기·지금'으로 지금 화면을 가리키지 않을 때만 그렇다고 본다.
 */
export function goesToAnotherSite(text: string, fuzzy = true): boolean {
  if (rulesPatterns.here.test(text)) return false;
  for (const match of text.matchAll(rulesPatterns.beforeGoThere)) {
    if (match[1] !== undefined && mentionsKnownSite(match[1], fuzzy)) return true;
  }
  return false;
}

export class RuleBasedIntentProvider implements IntentProvider {
  readonly name = "mock-rule";
  readonly aliases: ReadonlyArray<ReturnType<typeof aliasExpressions>>;
  readonly commandBoundary: RegExp;

  constructor(vocabulary: readonly string[]) {
    const aliasLength = (name: string) => Array.from(name.replace(rulesPatterns.aliasSeparators, "")).length;
    this.aliases = [...vocabulary].sort((a, b) => aliasLength(b) - aliasLength(a)).map(aliasExpressions);
    const fieldWords = this.aliases.map(item => escapeRe(item.alias)).join("|");
    // "…김하늘이고 주소는" / "…신청하고 이름은": 연결 어미 뒤에 항목·명령이 오면 나눈다
    this.commandBoundary = new RegExp("(?<!그리)(이)?고\\p{White_Space}+(?=(" + fieldWords
      + "|다음|이전|그리고|모의|제출|화면|본문|링크|검색|뒤로|공식))", "gu");
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

  /** 여러 명령을 한 번에 말했을 때 문장을 나눈다(예: "이름은 김하늘이고 주소는 …, 다음으로 넘어가줘"). 나누지 못하면 원문 하나. */
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
    const awaiting = hasText(ctx.awaitingFieldId);
    if (isStopUtterance(text)) return { type: "STOP" };
    if (isPictureRequest(text)) return { type: "DESCRIBE_PICTURE", question: text };
    if (isProgressQuestion(text)) return { type: "PROGRESS" };
    if (/(?:시작|처음|첫\p{White_Space}*이용|개인정보|이용)\p{White_Space}*(?:할\p{White_Space}*때\p{White_Space}*)?안내(?:문|사항|\p{White_Space}*전문)?(?:를|을)?\p{White_Space}*(?:다시\p{White_Space}*)?(?:들려|읽어|듣고|알려|말해|보여)/u.test(text)) {
      return { type: "READ_START_GUIDE" };
    }
    // 첫 실행: 청음 소개 다시 듣기 · 처음 설정 다시 하기('말하기 설정 …'은 말하기 설정 명령이라 앞에 다른 말이 없을 때만)
    if (/(?:청음|자기)\p{White_Space}*소개\p{White_Space}*(?:를\p{White_Space}*)?(?:다시\p{White_Space}*)?(?:해|들려|알려|보여)/u.test(text)) {
      return { type: "INTRO_REPLAY" };
    }
    if (rulesPatterns.restartSetup.test(text)) {
      return { type: "SETUP_RESTART" };
    }
    if (/(다시\p{White_Space}*시작|재개|계속\p{White_Space}*(해|하자|진행))/u.test(text)) return { type: "RESUME" };
    if (/(거절|승인\p{White_Space}*안|하지\p{White_Space}*마|안\p{White_Space}*할래)/u.test(text)
      || (state === "WAITING_FOR_USER_CONFIRMATION" && approval(text) === "reject")) {
      return { type: "REJECT" };
    }
    if (EXPLICIT_APPROVE_KO.test(text) || (state === "WAITING_FOR_USER_CONFIRMATION" && approval(text) === "approve")) {
      return { type: "APPROVE" };
    }
    if (state === "AUTH_HANDOFF" && authInputDone(text)) return { type: "LOGIN" };
    if ((state === "AUTH_HANDOFF" || /(?:인증|로그\p{White_Space}*인)/u.test(text)) && doneReply(text)) return { type: "AUTH_DONE" };
    // 로그아웃·로그인 기록 삭제(로그인보다 먼저: '로그아웃'에 '로그인'이 들어 있음)
    if (/로그\p{White_Space}*아웃|로그인\p{White_Space}*(기록|쿠키|정보)[^\n]*(지워|삭제|없애)|로그인\p{White_Space}*풀어/u.test(text)) {
      return { type: "CLEAR_LOGIN" };
    }
    const mode = downloadMode(text);
    if (mode !== undefined) return { type: "READ_DOWNLOAD", list: mode === "list" };
    if (rulesPatterns.loginAsk.test(text)) return { type: "LOGIN" };
    if (rulesPatterns.submitAsk.test(text) && !rulesPatterns.submitNegated.test(text)) return { type: "PREPARE_SUBMIT" };
    if (/최종\p{White_Space}*확인/u.test(text)) return { type: "PREPARE_SUBMIT" };
    if (/(사람|상담원|상담사)[^\n]*(도움|연결|바꿔)|도움\p{White_Space}*요청/u.test(text)) return { type: "HELP_HUMAN" };
    if (rulesPatterns.help.test(text)) return { type: "WHAT_CAN_I_SAY", more: rulesPatterns.moreHelp.test(text) };
    if (isSiteName(text) && !awaiting) return { type: "OPEN_SITE", target: text };
    const agency = publicServiceSite(text);
    if (agency !== undefined && !awaiting && !/눌러|클릭|링크\p{White_Space}*목록/u.test(text)) {
      const compact = text.replace(rulesPatterns.space, "");
      const hasTask = agency.services.some(term => compact.includes(term));
      if (hasTask || /신청|발급|서류|방법|절차|자격|기한|기간|공지|검색|찾아|알려|확인|읽어|뭐가|문의|고객센터/u.test(text)) {
        return { type: "GOAL", goal: text };
      }
      if (/열어|접속|들어가|이동|가\p{White_Space}*줘|켜|띄워/u.test(text)) return { type: "OPEN_SITE", target: text };
    }
    // "복지로 가서 첫 화면에 뭐가 있는지 알려줘"는 지금 화면이 아니라 그 사이트에 가서 볼 일(아래 목표 규칙)
    const elsewhere = goesToAnotherSite(text);
    // "국민연금공단 고객센터 전화번호 알려줘": 지사(지역) 찾기가 아니라 그 기관의 대표 연락처 → 그 기관 사이트에서 확인
    if (mentionsKnownSite(text, false) && /고객\p{White_Space}*센터|콜\p{White_Space}*센터|대표\p{White_Space}*(전화|번호)/u.test(text)
      && rulesPatterns.goalAsk.test(text) && !/지사|가까운|동네/u.test(text)) {
      return { type: "GOAL", goal: text };
    }
    if (!elsewhere && isPlaceRequest(text)) return { type: "FIND_PLACE" };
    if (!elsewhere
      && /(이|여기|지금|이곳)\p{White_Space}*(사이트|홈페이지|누리집|웹사이트|곳)\P{White_Space}*\p{White_Space}*(뭐|무슨|어떤|뭘|뭐\p{White_Space}*하는)|(무슨|어떤|뭐\p{White_Space}*하는)\p{White_Space}*(사이트|홈페이지|누리집|곳)(이야|야|인가요|예요|이에요|인지)/u.test(text)) {
      return { type: "ABOUT_SITE" };
    }
    if (!elsewhere
      && /(화면|페이지)[^\n]*(설명|읽어|뭐가|뭐\p{White_Space}*있|어떻게\p{White_Space}*생|전체|묘사)|뭐가\p{White_Space}*있어|화면에\p{White_Space}*뭐|(?:(이|그|선택한|가리킨)\p{White_Space}*(부분|문구|표시|그림|차트|버튼)|(선택한|가리킨)\p{White_Space}*항목)[^\n]*(설명|무슨\p{White_Space}*뜻|뭐야|뭔가요|뭐예요)/u.test(text)) {
      return { type: "DESCRIBE_SCREEN" };
    }
    if (!elsewhere && /(지금|현재|어디)[^\n]*(단계|화면|위치)|(화면|단계)[^\n]*(설명|알려|어디)/u.test(text)) return { type: "CURRENT_STEP" };
    // 사이트를 말하고 거기서 찾아 달라면 복지 제도 답보다 그 사이트에서 찾는다:
    // "복지로에서 장애인연금 신청할 때 필요한 서류 확인해줘", "portal2.html에서 이의 신청 기한과 서류를 찾아줘"
    if (elsewhere && rulesPatterns.goalAsk.test(text) && !/(눌러|클릭)/u.test(text) && goesToAnotherSite(text, false)) {
      return { type: "GOAL", goal: text };
    }
    // 뺀 것("기초연금 말고")은 아래 제도·사이트 판단에 넣지 않는다
    const kept = text.replace(rulesPatterns.notThis, "");
    // "공식 안내 열어줘": 방금 찾은 제도의 공식 상세(사이트 이름을 말했으면 그 사이트 열기)
    const official = rulesPatterns.openOfficial.exec(kept);
    if (official !== null && !elsewhere && !mentionsKnownSite(kept)) {
      const { num, name } = official.groups ?? {};
      const ref = num !== undefined ? `${num}번` : name;
      return hasText(ref) ? { type: "OPEN_OFFICIAL", service: ref } : { type: "OPEN_OFFICIAL" };
    }
    // ---- 맞춤 복지 찾기 ----
    const selected = rulesPatterns.serviceNumber.exec(kept)?.[0] ?? rulesPatterns.serviceName.exec(kept.replace(rulesPatterns.spaces, ""))?.[1];
    const service = selected === undefined ? {} : { service: selected };
    if (/^(\p{Nd}{1,2})\p{White_Space}*번\p{White_Space}*(자세히|설명|뭐야|알려|내용)/u.test(text)) return { type: "SERVICE_DETAIL", ...service };
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
    // "크롬 켜줘", "브라우저 열어줘": 사이트 없이 브라우저만
    if (/^(크롬|chrome|브라우저|인터넷)\p{White_Space}*(창\p{White_Space}*)?(좀\p{White_Space}*)?(켜|열어|띄워|실행|시작)/iu.test(text) && !mentionsKnownSite(text)) {
      return { type: "OPEN_BROWSER" };
    }
    // 목표(사이트 + 찾기/알려줘)는 복지 질문 규칙보다 먼저: "네이버에서 오늘 뉴스 알려줘" → 여러 단계를 알아서
    if (mentionsKnownSite(text) && rulesPatterns.goThere.test(text) && rulesPatterns.goalAsk.test(text)) return { type: "GOAL", goal: text };
    // "쉽게 말해줘", "무슨 말이야?" → 직전 안내를 쉬운 말로 다시(항목 이름이 없을 때만)
    if (/(쉽게\p{White_Space}*(다시\p{White_Space}*)?(말해|설명|얘기)|무슨\p{White_Space}*말(이야|인지|이에요)|이해가?\p{White_Space}*(안|잘\p{White_Space}*안)\p{White_Space}*(돼|가)|못\p{White_Space}*알아듣|다시\p{White_Space}*(한\p{White_Space}*번\p{White_Space}*)?말해\p{White_Space}*줘|천천히\p{White_Space}*(다시\p{White_Space}*)?말해)/u.test(text)
      && this.mention(text) === undefined) {
      return { type: "REPHRASE" };
    }
    // "확인한 전화번호를 천천히 읽어줘": 입력 칸 이름이 섞여도 방금 들은 것을 가리키면 다시 말하기.
    // 신청서에서 "방금 입력한 주소 천천히 읽어줘"는 그 칸 읽기
    if (rulesPatterns.slowRepeat.test(text) && rulesPatterns.justSaid.test(text)
      && !(state === "APPLICATION_OPEN" && this.mention(text) !== undefined)) {
      return { type: "REPHRASE" };
    }
    if (/(무슨\p{White_Space}*뜻|뜻이|뜻은|의미|설명해|뭘\p{White_Space}*써야|뭐\p{White_Space}*쓰는)/u.test(text) && !rulesPatterns.listedService.test(text)) {
      const mention = this.mention(text);
      return mention === undefined ? { type: "EXPLAIN" } : { type: "EXPLAIN", fieldMention: mention };
    }
    if (/(지원\p{White_Space}*대상|신청\p{White_Space}*(방법|절차)|선정\p{White_Space}*기준|소득인정액|자격|받을\p{White_Space}*수\p{White_Space}*있|누가\p{White_Space}*받|얼마\p{White_Space}*(받|나와|줘|지급)|지원\p{White_Space}*금액|지급액|필요한?\p{White_Space}*서류|서식|어디에?\p{White_Space}*문의)/u.test(text)
      && !/(눌러|클릭)/u.test(text)) {
      return { type: "POLICY_QUESTION", topic: text };
    }
    // "지금 신청할 수 있어?"는 신청 시작이 아니라 기간 확인(START_APPLICATION보다 먼저).
    if (/(지금|현재)[^\n]*(신청|접수)[^\n]*(할\p{White_Space}*수|가능|돼|되나)|(신청|접수)\p{White_Space}*(기간|마감|기한)/u.test(text) && !/(눌러|클릭|열어|시작|도와)/u.test(text)) {
      return { type: "POLICY_QUESTION", topic: text };
    }
    // "언제 신청을 시작할 수 있는지"는 신청을 시작하라는 말이 아니라 묻는 말
    const asksWhen = /언제[^.?!]{0,10}신청|(시작|신청)\p{White_Space}*할\p{White_Space}*수\p{White_Space}*있/u.test(text);
    if ((/장애인\p{White_Space}*연금/u.test(text) && /(신청|도와)/u.test(text) && !/검색/u.test(text))
      || (/신청\p{White_Space}*(페이지|화면|서)?\p{White_Space}*(를|을)?\p{White_Space}*(열어|시작|도와)/u.test(text) && !asksWhen)) {
      return { type: "START_APPLICATION" };
    }
    // 제도 이름 + 질문 형태면 복지 질문(예: "기초연금은 몇 살부터 받아?", "주거급여 신청 방법 알려줘")
    if (/(연금|수당|급여|바우처|지원금|장려금|복지|소득인정액|선정기준액)/u.test(text)
      && /(\?|뭐|무엇|어떻게|어디|언제|얼마|몇|되나요|돼|가능|알려\p{White_Space}*줘|궁금)/u.test(text)
      && !/(검색|열어|눌러)/u.test(text)) {
      return { type: "POLICY_QUESTION", topic: text };
    }

    // ---- 웹 읽기 모드 명령 ----
    const search = rulesPatterns.search.exec(text);
    if (search?.[2] !== undefined && /(검색|찾아)/u.test(text)) {
      const query = cleanValue(search[2]).replace(rulesPatterns.queryPrefix, "");
      if (query.length > 0) {
        const site = strip(search[1] ?? "");
        const bounded = Array.from(query).slice(0, 100).join("");
        return site.length > 0 ? { type: "SEARCH", query: bounded, site } : { type: "SEARCH", query: bounded };
      }
    }
    if (/(뒤로\p{White_Space}*가|이전\p{White_Space}*페이지|돌아가)/u.test(text)) return { type: "PREV" };
    if (/(링크|메뉴)\p{White_Space}*(더|나머지|계속)?\p{White_Space}*(목록|뭐|뭐가|알려|읽어|있)/u.test(text)) {
      return { type: "LIST_LINKS", more: /(더|계속|나머지|다음)/u.test(text) };
    }
    if ((/(링크|메뉴|탭|버튼)/u.test(text) && /(눌러|클릭|열어|들어가|선택|가\p{White_Space}*줘)/u.test(text)) || /(눌러|클릭해)/u.test(text)) {
      const name = strip(text.replace(rulesPatterns.quotesAnywhere, "").replace(rulesPatterns.linkCommand, ""));
      if (name.length > 0) return { type: "FOLLOW_LINK", name };
    }
    if (/(열어|접속|들어가|이동해|가\p{White_Space}*줘|켜\p{White_Space}*줘|띄워)/u.test(text)
      && (mentionsKnownSite(text) || /(사이트|홈페이지|누리집|웹\p{White_Space}*페이지|모의\p{White_Space}*복지)/u.test(text))) {
      return { type: "OPEN_SITE", target: text };
    }
    if (/(본문|내용|기사|글)\p{White_Space}*(을|를)?\p{White_Space}*(읽어|알려|들려)|(더|계속|이어서)\p{White_Space}*읽어|다음\p{White_Space}*내용/u.test(text)
      && !/(지금까지|입력한|작성한|쓴)/u.test(text)) {
      return { type: "READ_MAIN", more: /(더|계속|이어서|다음\p{White_Space}*내용)/u.test(text) };
    }
    if (/(지금까지|전체|모든|입력한|작성한|쓴)\p{White_Space}*(내용|것|거|항목)?[^\n]*(읽어|알려|요약|확인)/u.test(text) && this.mention(text) === undefined) {
      return { type: "REVIEW" };
    }
    // 실제 사이트 입력란: "휴대전화번호 칸에 010… 써줘", "이메일란에 … 입력해줘"
    const slot = rulesPatterns.slot.exec(text);
    if (slot?.[1] !== undefined && slot[2] !== undefined) {
      const value = cleanValue(slot[2]);
      if (value.length > 0) return { type: "FILL", fills: [{ fieldMention: strip(slot[1]), value }] };
    }
    if (/실거주지[^\n]*(달라|다름|다릅니다|따로)/u.test(text)) {
      return { type: "FILL", fills: [{ fieldMention: "실거주지가 주민등록 주소와 다릅니다", value: "예" }] };
    }

    // "그 페이지 제목이 뭐야?": 지금 화면 이름. 결과·글의 제목처럼 화면 속 내용을 묻는 말은 아래로(입력 칸 읽기가 아님).
    if (!elsewhere && /(페이지|화면)\p{White_Space}*(의\p{White_Space}*)?제목/u.test(text) && !/결과|글|기사/u.test(text)) {
      return { type: "CURRENT_STEP" };
    }
    const mention = rulesPatterns.pageName.test(text) && !rulesPatterns.edit.test(text) ? undefined : this.mention(text);
    if (hasText(mention)) {
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
    if (short(text)) {
      if (/(다음|넘어가|넘겨)/u.test(text)) return { type: "NEXT" };
      if (/(이전|뒤로|전\p{White_Space}*단계|앞\p{White_Space}*단계)/u.test(text)) return { type: "PREV" };
    }
    return { type: "UNKNOWN", text };
  }
}
