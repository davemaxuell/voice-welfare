import { redactedJson, type StructuredLlm, type Redacted } from "../core/llm.ts";
import { strip } from "../core/text.ts";

export const filtersPatterns = {
  questionLike: /\?(?=\n?$)|(뭐야|뭔가요|무엇|어떻게|왜|언제|얼마|며칠|몇|되나요|돼\?|되나|가능|해야\p{White_Space}*(돼|하나|해)|맞아|알려\p{White_Space}*줘|어때)/u,
  replyEnd: /[.!~?,\p{White_Space}]+(?=\n?$)/gu,
  acknowledgement: /^(응\p{White_Space}*)?(알았어|알았어요|알겠어|알겠어요|알겠습니다|알았습니다|알았고|오케이|오키|그래|그래요|그렇구나|그렇군요|고마워|고마워요|감사합니다|네\p{White_Space}*알겠어요|응\p{White_Space}*그래)(?=\n?$)/u,
  negative: /^(아니|아니야|아니요|아뇨|아니에요|아냐|됐어|괜찮아|괜찮아요|아니\p{White_Space}*괜찮아)(?=\n?$)/u,
  address: /^(청음(아|이야)|청음이?(?=\p{White_Space}*[,!.~?]))[\p{White_Space},!.~?]*/u,
  filler: /^((알았어|알았고|알겠어|알겠고|그래|그래서|좋아|오케이|음+|어+|아니\p{White_Space}*근데|아니|근데)[요,.\p{White_Space}]+)+/u,
  sentenceEnd: /[.!?。~]+(?=\n?$)/u,
  spaces: /\p{White_Space}+/gu,
  vagueAction: /^(?:그거|이거|저거|그것|이것|저것|거기|여기)?\p{White_Space}*(?:좀\p{White_Space}*)?(?:해|해\p{White_Space}*줘|해\p{White_Space}*봐|부탁해|처리해\p{White_Space}*줘|진행해\p{White_Space}*줘)(?=\n?$)/u,
  vagueClick: /^(?:그거|이거|저거|그것|이것|저것|거기|여기)?\p{White_Space}*(?:좀\p{White_Space}*)?(?:눌러|클릭해)\p{White_Space}*(?:줘|주세요)?(?=\n?$)/u,
  vagueOpen: /^(?:그거|이거|저거|그것|이것|저것|거기|여기)?\p{White_Space}*(?:좀\p{White_Space}*)?(?:사이트\p{White_Space}*)?(?:열어|켜|띄워|들어가)\p{White_Space}*(?:줘|줄래|봐|주세요)?(?=\n?$)/u,
  vagueSearch: /^(?:그거|이거|저거|그것|이것|저것|거기|여기)?\p{White_Space}*(?:좀\p{White_Space}*)?(?:검색|찾아)\p{White_Space}*(?:해\p{White_Space}*)?(?:줘|봐|줄래|주세요)?(?=\n?$)/u,
  vagueTell: /^(?:그거|이거|저거|그것|이것|저것|거기|여기)?\p{White_Space}*(?:좀\p{White_Space}*)?(?:알려|가르쳐)\p{White_Space}*(?:줘|줄래|주세요)?(?=\n?$)/u,
  questionWords: /(뭐|무엇|무슨|어떻게|언제|얼마|며칠|몇|어느|어디|왜|누가|어때|있어|있나|되나|돼\?|인가|일까|알려)/gu,
};

export function isQuestionLike(text: string): boolean {
  return filtersPatterns.questionLike.test(text);
}

export function shortReplyKind(text: string): "ack" | "no" | undefined {
  const value = strip(text.replace(filtersPatterns.replyEnd, ""));
  if (filtersPatterns.negative.test(value)) return "no";
  if (filtersPatterns.acknowledgement.test(value)) return "ack";
  return undefined;
}

export function stripAddress(text: string): string {
  return strip(text.replace(filtersPatterns.address, ""));
}

export function stripFiller(text: string): string {
  const rest = strip(text.replace(filtersPatterns.filler, ""));
  return Array.from(rest).length >= 2 ? rest : text;
}

export function vagueQuestion(text: string): string | undefined {
  const normalized = strip(text.replace(filtersPatterns.sentenceEnd, "").replace(filtersPatterns.spaces, " "));
  if (filtersPatterns.vagueOpen.test(normalized)) return "어느 사이트를 열까요? '네이버', '정부24'처럼 이름이나 주소를 말씀해 주세요.";
  if (filtersPatterns.vagueSearch.test(normalized)) return "무엇을 검색할까요? 찾을 내용을 말씀해 주세요.";
  if (filtersPatterns.vagueTell.test(normalized)) return "무엇을 알려드릴까요? 궁금한 것을 말씀해 주세요.";
  if (filtersPatterns.vagueAction.test(normalized)) return "무엇을 할까요? 예를 들어 '화면 설명해줘', '네이버 열어줘'처럼 말씀해 주세요.";
  if (filtersPatterns.vagueClick.test(normalized)) return "어떤 걸 누를까요? '링크 목록 알려줘'라고 하시면 누를 수 있는 것을 읽어 드려요.";
  return undefined;
}

export async function splitQuestions(
  llm: StructuredLlm | undefined, text: Redacted, recent: readonly Redacted[], signal?: AbortSignal,
): Promise<string[]> {
  if (llm === undefined || Array.from(text).length < 12) return [];
  if (Array.from(text.matchAll(filtersPatterns.questionWords)).length < 2 && !/\?[\s\S]*\?/u.test(text)) return [];
  const result: unknown = await llm.generate({
    system: "사용자 말에 서로 다른 질문이 몇 개 있는지 보고, 각 질문을 혼자 읽어도 뜻이 통하는 한국어 질문으로 나눈다(앞 질문의 제도·사이트 이름을 뒤 질문에도 채워 넣는다). 질문이 하나뿐이거나 명령(열기·입력·누르기)이 섞였으면 questions를 빈 배열로. 최대 4개.",
    user: redactedJson({ utterance: text, recent }),
    schemaName: "split_questions",
    schema: {
      type: "object", additionalProperties: false, required: ["questions"],
      properties: { questions: { type: "array", items: { type: "string" } } },
    },
    signal,
  });
  if (result === null || typeof result !== "object" || !("questions" in result)) return [];
  // 한국어 질문 문자열을 골라 공백을 지우고 네 개까지 읽는다.
  const questions: unknown = result.questions;
  const items: unknown[] = Array.isArray(questions) ? questions : typeof questions === "string" ? Array.from(questions) : [];
  return items.filter((q): q is string => typeof q === "string").map(strip).filter(q => q.length > 0).slice(0, 4);
}
