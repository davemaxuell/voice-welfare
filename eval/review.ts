/**
 * 평가 결과 폴더의 results.json으로 사람이 보는 화면(review.html)을 만든다.
 * 사용: npm run eval:review                       # 가장 최근 결과
 *       npm run eval:review -- eval/results/<폴더>  # 특정 결과
 * 만든 review.html은 더블클릭으로 브라우저에서 열린다(서버 불필요).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildReviewHtml, reviewDataFromResults } from './lib/review-html';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = process.argv[2];
const dir = (arg ? (arg.startsWith('/') ? arg : `${root}${arg}`) : `${root}eval/results/${readdirSync(`${root}eval/results`).filter((d) => /^\d{8}-\d{4}$/.test(d)).sort().pop()}`).replace(/\/$/, '');
const results = JSON.parse(readFileSync(`${dir}/results.json`, 'utf8'));
writeFileSync(`${dir}/review.html`, buildReviewHtml(reviewDataFromResults(results)));
console.log(`평가 화면: ${dir}/review.html`);
