/**
 * 음성 테스트 체크리스트 화면(eval/voice-test.html)을 과제 목록(datasets/voice-test-tasks.json)으로 만든다.
 * 과제를 고친 뒤 실행: npm run eval:voice-test
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildVoiceTestHtml, type VoiceTask } from './lib/voice-test-html';

const root = fileURLToPath(new URL('..', import.meta.url));
const { tasks } = JSON.parse(readFileSync(`${root}eval/datasets/voice-test-tasks.json`, 'utf8')) as { tasks: VoiceTask[] };
writeFileSync(`${root}eval/voice-test.html`, buildVoiceTestHtml(tasks));
console.log(`음성 테스트 화면: eval/voice-test.html (과제 ${tasks.length}개)`);
