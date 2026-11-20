import { redactedJson, type StructuredLlm } from "../core/llm.ts";
import { KNOWN_SITES, type KnownSite } from "../core/sites.ts";
import { strip } from "../core/text.ts";
import { detectSensitive, REDACTED, redactText } from "../safety/privacy.ts";
import { oneEditApart, publicServiceSite } from "../understanding/sites.ts";

interface Suggestion { text: string; label: string }
type Suggestions = [Suggestion[], boolean];

const vocabulary = new Map<string, KnownSite>();
for (const site of KNOWN_SITES) {
  for (const term of [...site.names, ...site.services]) {
    if (/^[가-힣0-9 ]{3,}$/u.test(term)) vocabulary.set(term.replaceAll(" ", ""), site);
  }
}
export const VOCAB: ReadonlyMap<string, KnownSite> = vocabulary;
const ending = /(?:에서|으로|까지|인가요|이요|을|를|에|로|은|는|좀|요)$/u;
const privateRequest = /비밀번호|인증번호|주민등록번호|계좌|아이디|이메일|결제|승인|서명|대신[\p{White_Space}\u001c-\u001f]*(?:신청|제출)|제출해|접수해/u;
const readOnly = new Set(["OPEN_SITE", "GOAL", "POLICY_QUESTION", "READ_MAIN", "LIST_LINKS", "DESCRIBE_SCREEN", "ABOUT_SITE", "UNKNOWN", "SEARCH_WEB", "PREPARE_APPLY"]);

export function wordSuggestions(text: string): Suggestions {
  const words = [...text.matchAll(/[가-힣0-9]+/gu)];
  const best = new Map<string, Suggestion>();
  let bestLength = 0, corroborated = false;
  for (const [index, first] of words.entries()) {
    for (const last of words.slice(index, index + 3)) {
      const span = text.slice(first.index, last.index + last[0].length);
      const bare = span.replace(ending, "");
      const word = bare.replaceAll(" ", "");
      const length = Array.from(word).length;
      if (length < 3 || length < bestLength || VOCAB.has(word)) continue;
      if ([...VOCAB.keys()].some(term => term.length >= length - 1 && word.includes(term))) continue;
      for (const [term, site] of VOCAB) {
        if (term.length < 3 || term[0] !== word[0] || !oneEditApart(word, term)) continue;
        if (length > bestLength) {
          best.clear();
          bestLength = length;
          corroborated = false;
        }
        const before = text.slice(0, first.index), after = text.slice(first.index + bare.length);
        best.set(term, { text: before + term + after, label: term });
        if (site.names.includes(term) && publicServiceSite(before + " " + after) === site) corroborated = true;
      }
    }
  }
  return [[...best.values()].slice(0, 2), corroborated && best.size === 1];
}

interface SpeechContext {
  language: string;
  agency: string;
  service: string;
  region?: string;
  recentTurns: readonly { agency: string | null; request: string; reply: string }[];
}

const system = "음성으로 정부 서비스를 사용하는 사람의 받아쓰기 오류를 살펴본다. 발음과 현재 대화 양쪽에 근거가 있을 때만 "
  + "원래 원했을 법한 읽기·찾기 요청 하나를 쉬운 한국어로 복원한다. 직전 답은 참고만 한다. "
  + "그대로 이해되는 일반 대화, 근거 없는 추측, 숫자·개인정보·로그인·승인·입력·제출 관련 요청은 null로 둔다.";

export async function interpretSpeech(text: string, intent: string, context: SpeechContext, llm: StructuredLlm | undefined,
  signal: AbortSignal, parse: (text: string) => string): Promise<Suggestions> {
  const length = Array.from(text).length;
  if ((!readOnly.has(intent) && intent !== "READ_FIELD" && intent !== "PRECHECK") || length > 160
      || text.includes(REDACTED) || privateRequest.test(text)) return [[], false];
  const matches = wordSuggestions(text);
  if (matches[0].length > 0) return matches;
  if (intent !== "UNKNOWN" || llm === undefined || length < 3) return [[], false];

  const result = await llm.generate({
    system, signal, schemaName: "speech_repair",
    user: redactedJson({ heard: redactText(text), context: {
      language: redactText(context.language), agency: redactText(context.agency), service: redactText(context.service),
      recentTurns: context.recentTurns.map(turn => ({
        agency: turn.agency === null ? null : redactText(turn.agency), request: redactText(turn.request), reply: redactText(turn.reply),
      })), ...(context.region === undefined ? {} : { region: redactText(context.region) }),
    } }),
    schema: { type: "object", additionalProperties: false, required: ["suggestion"], properties: { suggestion: { type: ["string", "null"] } } },
  });
  if (typeof result !== "object" || result === null || !("suggestion" in result) || typeof result.suggestion !== "string") return [[], false];
  const candidate = strip(result.suggestion);
  const candidateLength = Array.from(candidate).length;
  if (candidateLength < 2 || candidateLength > 120 || candidate === text || privateRequest.test(candidate)
      || detectSensitive(candidate).hasSecretValue || redactText(candidate) !== candidate) return [[], false];
  const action = parse(candidate);
  if (!readOnly.has(action) || action === "UNKNOWN" || action === "PREPARE_APPLY") return [[], false];
  return [[{ text: candidate, label: candidate }], false];
}
