/** 한 요청을 이해하는 데만 쓰는 지난 대화. 현재 지시나 승인과 따로 보낸다. */
export interface DialogueExchange {
  readonly user: string;
  readonly assistant: string;
  readonly incomplete?: true;
  /** Local app turn identity, omitted from model requests. */
  readonly turnId?: string;
}

export const PLANNER_EXCHANGES = 4;
const TEXT_BYTES = 6400;

export function utf8Prefix(text: string, bytes: number): string {
  const encoded = Buffer.from(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.toString("utf8", 0, end);
}

export function boundedDialogue(exchanges: readonly DialogueExchange[], clean: (text: string, role: "user" | "assistant") => string): DialogueExchange[] {
  const result: DialogueExchange[] = [];
  let remaining = TEXT_BYTES;
  for (const entry of exchanges.slice(-PLANNER_EXCHANGES).reverse()) {
    const user = clean(entry.user, "user");
    const assistant = clean(entry.assistant, "assistant");
    if (user.length === 0 || assistant.length === 0) break;
    const userBytes = Buffer.byteLength(user), assistantBytes = Buffer.byteLength(assistant);
    if (userBytes + assistantBytes > remaining) {
      // 앞선 턴은 통째로 넣는다. 최신 턴 하나만으로 한도를 넘으면 양쪽에 자리를 남긴다.
      if (result.length === 0) {
        const forUser = Math.max(Math.floor(remaining / 2), remaining - assistantBytes);
        const first = utf8Prefix(user, forUser);
        result.push({ ...entry, user: first, assistant: utf8Prefix(assistant, remaining - Buffer.byteLength(first)), incomplete: true });
      }
      break;
    }
    result.push({ ...entry, user, assistant });
    remaining -= userBytes + assistantBytes;
  }
  return result.reverse();
}
