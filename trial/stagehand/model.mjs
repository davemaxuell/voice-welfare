import assert from "node:assert/strict";
import { createStructuredLlm } from "../../src/core/llm.ts";
import { redactPictureText, REDACTED } from "../../src/safety/privacy.ts";

export const modelDescription = "모델이 임의로 붙인 이름";
export const phone = "010-5555-0123";

export function modelAt(baseUrl) {
  const llm = createStructuredLlm({ provider: "openai-compatible", model: "fixture", baseUrl });
  assert(llm);
  let calls = 0;
  return { get calls() { return calls; }, model: { async generate(input) {
    const format = input.responseFormat;
    assert.equal(format?.type, "json_schema");
    const parts = input.messages.flatMap(message => [message.content].flat());
    assert(parts.every(part => part.type === "text"));
    const user = redactPictureText(parts.map(part => part.text).join("\n"));
    const system = redactPictureText(input.systemPrompt ?? "");
    const result = await llm.generate({ system, user, schema: format.schema, schemaName: format.name });
    assert(result);
    calls++;
    return { role: "assistant", content: [], outputFormat: "json_schema", structuredContent: result };
  }}};
}

export async function fixtureAnswer(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks));
  assert(!JSON.stringify(request).includes(phone));
  const user = request.messages.find(message => message.role === "user").content;
  assert(user.includes(REDACTED), "모델에 보내기 전에 시험 전화번호가 가려져야 함");
  const elements = [];
  for (const label of ["바깥 안내", "안쪽 안내"]) {
    const line = user.split("\n").find(s => s.includes(label) && /\[\d+-\d+\]/.test(s));
    const id = line?.match(/\[(\d+-\d+)\]/)?.[1];
    assert(id, "접근성 트리에 있어야 하는 단추 " + label);
    elements.push({ elementId: id, description: modelDescription, method: "click", arguments: [] });
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ elements }) } }] }));
}
