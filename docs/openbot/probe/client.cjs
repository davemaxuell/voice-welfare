const assert = require('node:assert/strict');
const { HttpAgent } = require('@ag-ui/client');
const fixture = require('../../../src/cheongeum/agents/welfare/data/fixtures/welfare_services.json');

async function main(url) {
  const agent = new HttpAgent({ url, threadId: 'research-thread' });
  agent.addMessage({ id: 'question', role: 'user', content: '장애인연금 신청 방법이 뭐예요?' });
  const events = [];
  const result = await agent.runAgent(
    {
      runId: 'research-run',
      tools: [{ name: 'sample_tool', description: 'Unused research fixture', parameters: { type: 'object', properties: {} } }],
    },
    { onEvent({ event }) { events.push(event.type); } },
  );
  assert.deepEqual(events, [
    'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END', 'STATE_SNAPSHOT', 'RUN_FINISHED',
  ]);
  assert.equal(result.newMessages.length, 1);
  assert.equal(result.newMessages[0].role, 'assistant');
  const program = fixture.services.find((item) => item.servNm === '장애인연금');
  assert.ok(result.newMessages[0].content.includes(program.applyMethod));
  assert.deepEqual(Object.keys(agent.state), ['source']);
  const source = agent.state.source;
  assert.deepEqual(Object.keys(source).sort(), ['dataOrigin', 'lastCheckedAt', 'title', 'url', 'version']);
  assert.equal(source.dataOrigin, 'fixture');
  assert.equal(source.version, '저장된 자료 기준');
  assert.equal(source.title, program.source.title);
  assert.equal(source.url, program.source.url);
  assert.equal(source.lastCheckedAt, program.source.lastCheckedAt);

  const other = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: 'other-thread', runId: 'other-run',
      messages: [{ id: 'other', role: 'user', content: '연습 신청서를 열어줘' }],
    }),
  });
  assert.equal(other.status, 422);
  console.log(JSON.stringify({ events, messages: result.newMessages.length, source, outOfScopeStatus: other.status }));
}

main(process.argv[2]).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
