// 첫 실행 설정의 키 확인: 모델 목록을 한 번 불러 키가 쓸 수 있는지 본다.
import { rstripChars } from "../core/text.ts";

export type KeyCheck = "ok" | "invalid" | "quota" | "network";

/** ok = 쓸 수 있음, invalid = 키가 틀림, quota = 사용 한도 초과, network = 연결·서버 문제. */
export async function checkOpenaiKey(key: string, baseUrl: string, { timeoutMs = 8000, fetch: fetcher = fetch }: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<KeyCheck> {
  let response: Response;
  try {
    response = await fetcher(rstripChars(baseUrl, "/") + "/models", {
      headers: { Authorization: "Bearer " + key }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    await response.arrayBuffer();
  } catch {
    return "network";
  }
  if (response.status >= 200 && response.status < 300) return "ok";
  if (response.status === 401 || response.status === 403) return "invalid";
  if (response.status === 429) return "quota";
  return "network";
}
