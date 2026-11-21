/**
 * 서비스 비교 채점 화면(eval/benchmark/score.html)을 과제 데이터(eval/benchmark/tasks.json)로 만든다.
 * 과제를 고친 뒤 실행: npm run eval:benchmark
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBenchmarkHtml, type BenchTask } from './lib/benchmark-html';

const root = fileURLToPath(new URL('..', import.meta.url));
const { tasks, version } = JSON.parse(readFileSync(`${root}eval/benchmark/tasks.json`, 'utf8')) as { tasks: BenchTask[]; version: string };
writeFileSync(`${root}eval/benchmark/score.html`, buildBenchmarkHtml(tasks, version));
console.log(`서비스 비교 채점 화면: eval/benchmark/score.html (과제 ${tasks.length}개)`);
