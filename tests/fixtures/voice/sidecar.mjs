import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// 합성 오디오로 프로토콜, 임시 파일의 권한과 정리 시점을 확인한다.
const [journal, answer, pause] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let reply = { ok: true };
  if (request.op === "transcribe") {
    const mode = statSync(request.audioPath).mode & 0o777;
    const bytes = [...readFileSync(request.audioPath)];
    appendFileSync(journal, JSON.stringify({ ...request, bytes, mode }) + "\n");
    if (pause !== undefined) await delay(Number(pause));
    reply = existsSync(request.audioPath) ? { text: answer } : { error: "early cleanup" };
  }
  process.stdout.write(JSON.stringify({ id: request.id, ...reply }) + "\n");
}
