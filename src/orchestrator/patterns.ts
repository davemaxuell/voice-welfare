// 세션이 쓰는 정규식. Python regex 모듈 기준이라 \s는 White_Space, \d는 십진 숫자다.
// 식만 따로 두어, 세션 전체를 불러오지 않고도 Python 일치 구간과 대조할 수 있다(tests/unit/session-regex.test.ts).

export const sessionPatterns = {
  spaces: /\p{White_Space}+/gu, phraseEnd: /[.!?。~]+(?=\n?$)/u, digit: /\p{Nd}/u,
  profileCommand: /(줘|주세요|알려|열어|도움|뭐야|어떻게|멈춰|그만)/u,
  applyMatch: /(신청|도와|하고\p{White_Space}*싶)/u,
  sentences: /(?<=[.!?。]|요\.|다\.)\p{White_Space}+/u,
  sentenceGap: /(?<=[.。])\p{White_Space}*/u,
  hangul: /[가-힣]/u,
  answerTail: /[.!~\p{White_Space}]+(?=\n?$)/u,
  numberedChoice: /(?:제)?([12])\p{White_Space}*번(?:이요|요)?|(?:첫|두)\p{White_Space}*번째(?:요)?/u,
  politeEnding: /(?:이요|요|입니다)(?=\n?$)/u,
  declineSending: /(아니|아니요|아뇨|거절|취소|보내지\p{White_Space}*마)[.!。]*/u,
  goThere: /(열어|접속|들어가|이동해|가\p{White_Space}*줘|켜\p{White_Space}*줘|띄워)/u,
};

export const replyPatterns = {
  phone: /^\p{Nd}/u,
  moreServices: /^(더|다른\p{White_Space}*(거|것|제도)|다음\p{White_Space}*(거|것))\p{White_Space}*(알려|말해|있어|보여)?/u,
  thisField: /(이거|이\p{White_Space}*항목|여기|이\p{White_Space}*칸)/u,
  slowly: /천천히|느리게/u,
  sentenceGap: /(?<=[.!?。])\p{White_Space}+/u,
  phoneAsked: /전화/u,
};

export const applicationPatterns = {
  practice: /(연습|모의)/u,
  pension: /장애인\p{White_Space}*연금/u,
  spaces: /\p{White_Space}+/gu,
};

export const publicPatterns = {
  spaces: /\p{White_Space}+/gu,
  nearby: /지역|우리\p{White_Space}*동네|근처|가까운|거주지|내\p{White_Space}*주변/u,
  followup: /^(?:(?:그럼|그러면|여기서|여기|그건|그|이|필요한|제출할))*(?:신청|발급|제출서류|필요|준비|자격|대상|서류|마감|기한|언제|어떻게|어디서|수수료|비용|기간|온라인)/u,
  otherTask: /연금|급여|수당|바우처|지원금|장려금|눌러|클릭|열어|대신신청|제출해|접수해|신청해줘/u,
};

/** Python의 fullmatch: 글 전체가 식에 맞을 때의 일치 */
export function fullMatch(pattern: RegExp, text: string): RegExpExecArray | null {
  return new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace("g", "")).exec(text);
}
