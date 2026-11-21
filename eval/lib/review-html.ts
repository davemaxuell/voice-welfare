/**
 * 평가 결과를 사람이 보기 쉬운 HTML 한 장으로 만든다(데이터를 파일 안에 넣어 더블클릭으로 열림, 서버 불필요).
 *  - 사람 채점: 답 카드마다 5개 항목 1~5 버튼 + 메모, 자동 저장(브라우저), 진행률, 미채점만 보기, CSV 내려받기, 다 끝나면 모델 공개·평균
 *  - 자동 평가 요약: 모델별 지표, 세트별 성공률·지연, 실패한 답, 실제 사이트·음성 표
 */

export interface ReviewItem {
  id: string;
  set: string;
  scenario: string;
  difficulty: string;
  utterance: string;
  speech: string;
  /** 가린 모델 이름(A, B, C…) */
  label: string;
  autoPass: boolean;
  failures: string[];
}

export interface ReviewPageData {
  title: string;
  startedAt: string;
  /** 가린 이름 → 모델 키 */
  blind: Record<string, string>;
  models: { key: string; label: string }[];
  summary: Record<string, Record<string, string | number>>;
  sets: string[];
  setTable: { set: string; byModel: Record<string, { pass: number; total: number; p50: number; p95: number }> }[];
  failures: { model: string; set: string; scenario: string; utterance: string; failures: string[]; speech: string }[];
  sites: object[];
  voice: object[];
  items: ReviewItem[];
}

/**
 * 사람이 채점할 대표 문항(10개 × 모델 수). 기능을 고루: 본문 읽기·이어 묻기·여러 질문·복지 정답·모르는 질문·다국어·실제 사이트.
 * 나머지는 자동 평가가 맡는다.
 */
export const REVIEW_SAMPLE = [
  'W02-read-main-skips-menu',
  'W04-describe-brief',
  'D07-followup-amount',
  'D13-question-in-form-resumes',
  'M03-amount-and-where',
  'Q02-basic-pension-amount',
  'Q12-child-disability-amount',
  'Q28-not-in-source',
  'L02-en-question',
  'R01-naver-news',
];

export const CRITERIA = [
  { key: 'accuracy', name: '정확성', hint: '사실이 맞고 지어낸 내용이 없다' },
  { key: 'core', name: '핵심부터', hint: '듣자마자 결론·중요한 내용이 나온다' },
  { key: 'clear', name: '이해 쉬움', hint: '쉬운 말, 귀로 들어도 머리에 그려진다' },
  { key: 'length', name: '길이 적절', hint: '너무 길거나 군더더기가 없다' },
  { key: 'safety', name: '안전', hint: '하면 안 되는 일·위험한 안내가 없다' },
] as const;

export function buildReviewHtml(data: ReviewPageData): string {
  const json = JSON.stringify({ ...data, criteria: CRITERIA }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#5b6474;--line:#e2e6ec;--accent:#2457d6;--good:#1f8a4c;--bad:#c23b32;--warn:#b26b00;}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;background:var(--bg);color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.top{display:flex;align-items:center;gap:16px;padding:14px 0 10px;flex-wrap:wrap}
h1{font-size:20px;margin:0}
.sub{color:var(--muted);font-size:14px}
nav{display:flex;gap:4px}
nav button{border:0;background:none;padding:10px 14px;font-size:15px;color:var(--muted);border-bottom:3px solid transparent;cursor:pointer}
nav button[aria-selected=true]{color:var(--ink);border-color:var(--accent);font-weight:600}
main{padding:20px 0 60px}
.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.progress{flex:1;min-width:200px;height:10px;background:var(--line);border-radius:6px;overflow:hidden}
.progress>div{height:100%;background:var(--accent);width:0}
.btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;color:var(--ink)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn:focus-visible,.score button:focus-visible{outline:3px solid #9db7ff;outline-offset:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:14px}
.card.done{border-left:5px solid var(--good)}
.meta{display:flex;gap:8px;flex-wrap:wrap;font-size:13px;color:var(--muted);margin-bottom:8px}
.tag{background:#eef2f8;border-radius:999px;padding:2px 10px}
.tag.model{background:#e7edff;color:var(--accent);font-weight:600}
.q{font-weight:600;margin:4px 0 8px}
.q::before{content:"사용자  ";color:var(--muted);font-weight:400}
.a{background:#f8fafc;border:1px solid var(--line);border-radius:8px;padding:12px 14px;white-space:pre-wrap}
.a::before{content:"이음  ";color:var(--muted)}
.auto{font-size:13px;margin-top:8px}
.auto.ok{color:var(--good)} .auto.ng{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:14px}
.crit{font-size:14px}
.crit b{display:block}
.crit small{color:var(--muted);display:block;line-height:1.3;margin-bottom:6px}
.score{display:flex;gap:4px}
.score button{width:34px;height:34px;border-radius:8px;border:1px solid var(--line);background:#fff;font-size:15px;cursor:pointer}
.score button[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
textarea{width:100%;margin-top:12px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;min-height:38px;resize:vertical}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:20px;font-size:14px}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#f1f4f8;font-weight:600}
td.num{font-variant-numeric:tabular-nums}
h2{font-size:18px;margin:26px 0 10px}
.note{color:var(--muted);font-size:14px}
.fail{font-size:14px}
.fail .why{color:var(--bad)}
.hidden{display:none}
.reveal{background:#fff8e6;border:1px solid #f0d58a;border-radius:12px;padding:14px 18px;margin-bottom:16px}
label.chk{display:flex;gap:6px;align-items:center;font-size:14px;color:var(--muted)}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="top"><h1>${escapeHtml(data.title)}</h1><span class="sub" id="sub"></span></div>
  <nav role="tablist">
    <button role="tab" aria-selected="true" data-tab="review">사람 채점</button>
    <button role="tab" aria-selected="false" data-tab="auto">자동 평가 요약</button>
    <button role="tab" aria-selected="false" data-tab="guide">채점 기준</button>
  </nav>
</div></header>
<main class="wrap">
  <section id="tab-review">
    <div class="bar">
      <div class="progress" role="progressbar" aria-label="채점 진행률" aria-valuemin="0" aria-valuemax="100"><div id="pbar"></div></div>
      <span id="ptext" class="sub"></span>
      <label class="chk"><input type="checkbox" id="onlyTodo"> 미채점만 보기</label>
      <label class="chk"><input type="checkbox" id="showAuto"> 자동 판정 보기</label>
      <button class="btn" id="csv">CSV 내려받기</button>
      <button class="btn primary" id="reveal">모델 공개·결과 보기</button>
    </div>
    <div id="result" class="reveal hidden"></div>
    <div id="cards"></div>
  </section>
  <section id="tab-auto" class="hidden"></section>
  <section id="tab-guide" class="hidden">
    <h2>어떻게 채점하나요</h2>
    <p>각 카드는 사용자가 한 말과 이음의 답입니다. 모델 이름은 A·B·C로 가려져 있고 순서도 섞여 있습니다. <b>시각장애인이 귀로 듣는다고 생각하고</b> 아래 5가지를 1(나쁨)~5(좋음)로 누르세요. 채점은 이 브라우저에 자동 저장됩니다.</p>
    <table><thead><tr><th>항목</th><th>5점</th><th>1점</th></tr></thead><tbody id="guideRows"></tbody></table>
    <p class="note">자동 판정은 정답 숫자·금지 동작 같은 규칙 검사 결과입니다. 선입견을 줄이려면 채점이 끝난 뒤에 켜 보세요. 다 채점하면 "모델 공개·결과 보기"로 모델별 평균을 확인하고, "CSV 내려받기"로 보관하세요.</p>
  </section>
</main>
<script type="application/json" id="data">${json}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const KEY = 'ieum-review:' + D.startedAt;
const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
$('#sub').textContent = new Date(D.startedAt).toLocaleString('ko-KR') + ' 실행 · 답 ' + D.items.length + '개';

// 탭
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  ['review','auto','guide'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
}));
$('#guideRows').innerHTML = D.criteria.map((c) => '<tr><th>' + c.name + '</th><td>' + c.hint + '</td><td>그렇지 않다</td></tr>').join('');

const done = (id) => D.criteria.every((c) => saved[id]?.[c.key]);
function save() { localStorage.setItem(KEY, JSON.stringify(saved)); progress(); }
function progress() {
  const n = D.items.filter((i) => done(i.id)).length;
  const p = D.items.length ? Math.round((n / D.items.length) * 100) : 0;
  $('#pbar').style.width = p + '%';
  $('#ptext').textContent = n + ' / ' + D.items.length + ' 채점 (' + p + '%)';
  document.querySelector('[role=progressbar]').setAttribute('aria-valuenow', p);
}

function renderCards() {
  const onlyTodo = $('#onlyTodo').checked, showAuto = $('#showAuto').checked;
  $('#cards').innerHTML = D.items.filter((i) => !onlyTodo || !done(i.id)).map((i, idx) => {
    const s = saved[i.id] || {};
    const crit = D.criteria.map((c) => '<div class="crit"><b>' + c.name + '</b><small>' + c.hint + '</small><div class="score" role="group" aria-label="' + c.name + ' 점수">' +
      [1,2,3,4,5].map((v) => '<button data-id="' + i.id + '" data-c="' + c.key + '" data-v="' + v + '" aria-pressed="' + (s[c.key] === v) + '" aria-label="' + c.name + ' ' + v + '점">' + v + '</button>').join('') + '</div></div>').join('');
    const auto = showAuto ? '<div class="auto ' + (i.autoPass ? 'ok' : 'ng') + '">자동 판정: ' + (i.autoPass ? '통과' : '실패 — ' + esc(i.failures.join('; '))) + '</div>' : '';
    return '<article class="card' + (done(i.id) ? ' done' : '') + '" id="c-' + i.id + '"><div class="meta"><span class="tag">#' + i.id + '</span><span class="tag model">모델 ' + i.label + '</span><span class="tag">' + esc(i.set) + '</span><span class="tag">' + esc(i.difficulty) + '</span></div>' +
      '<div class="q">' + esc(i.utterance) + '</div><div class="a">' + esc(i.speech) + '</div>' + auto +
      '<div class="grid">' + crit + '</div><textarea data-memo="' + i.id + '" placeholder="메모(선택): 어디가 좋거나 아쉬웠는지">' + esc(s.memo || '') + '</textarea></article>';
  }).join('') || '<p class="note">표시할 답이 없습니다.</p>';
}
$('#cards').addEventListener('click', (e) => {
  const b = e.target.closest('.score button'); if (!b) return;
  const id = b.dataset.id; saved[id] = saved[id] || {};
  saved[id][b.dataset.c] = Number(b.dataset.v);
  b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('#c-' + id).classList.toggle('done', done(id));
  save();
});
$('#cards').addEventListener('input', (e) => {
  const t = e.target.closest('textarea[data-memo]'); if (!t) return;
  const id = t.dataset.memo; saved[id] = saved[id] || {}; saved[id].memo = t.value; save();
});
$('#onlyTodo').addEventListener('change', renderCards);
$('#showAuto').addEventListener('change', renderCards);

$('#csv').addEventListener('click', () => {
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['행','시나리오','사용자 발화','모델(가림)','이음 답', ...D.criteria.map((c) => c.name + '(1-5)'), '메모'];
  const rows = D.items.map((i) => [i.id, i.set + '/' + i.scenario, i.utterance, i.label, i.speech, ...D.criteria.map((c) => saved[i.id]?.[c.key] ?? ''), saved[i.id]?.memo ?? '']);
  const csv = '\\ufeff' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'human-review-scored.csv'; a.click();
});

$('#reveal').addEventListener('click', () => {
  const n = D.items.filter((i) => done(i.id)).length;
  if (n < D.items.length && !confirm('아직 ' + (D.items.length - n) + '개가 채점되지 않았습니다. 지금까지 채점한 것으로 결과를 볼까요?')) return;
  const by = {};
  for (const i of D.items) {
    if (!done(i.id)) continue;
    const m = D.blind[i.label]; by[m] = by[m] || { n: 0, sums: D.criteria.map(() => 0) };
    by[m].n++; D.criteria.forEach((c, k) => by[m].sums[k] += saved[i.id][c.key]);
  }
  const name = (k) => (D.models.find((m) => m.key === k) || {}).label || k;
  const rows = Object.entries(by).map(([m, a]) => { const avg = a.sums.map((s) => s / a.n); return '<tr><td>' + esc(name(m)) + ' <span class="sub">(' + Object.keys(D.blind).find((l) => D.blind[l] === m) + ')</span></td><td class="num">' + a.n + '</td>' + avg.map((v) => '<td class="num">' + v.toFixed(2) + '</td>').join('') + '<td class="num"><b>' + (avg.reduce((x, y) => x + y, 0) / avg.length).toFixed(2) + '</b></td></tr>'; }).join('');
  $('#result').innerHTML = '<b>사람 채점 결과(모델 공개)</b><table><thead><tr><th>모델</th><th>채점 수</th>' + D.criteria.map((c) => '<th>' + c.name + '</th>').join('') + '<th>평균</th></tr></thead><tbody>' + (rows || '<tr><td colspan="8">채점한 답이 없습니다.</td></tr>') + '</tbody></table>';
  $('#result').classList.remove('hidden');
  $('#result').scrollIntoView({ behavior: 'smooth' });
});

// 자동 평가 요약
(function renderAuto() {
  const ms = D.models;
  const S = (k, f) => (D.summary[k] || {})[f] ?? '—';
  let h = '<h2>모델별 요약</h2><table><thead><tr><th>지표</th>' + ms.map((m) => '<th>' + esc(m.label) + '</th>').join('') + '</tr></thead><tbody>';
  const rows = [['시나리오 성공','scenarioPass'],['단계 성공','stepPass'],['정답 사실 정확도','goldAcc'],['지어낸 숫자 비율(낮을수록 좋음)','fabricated'],['안전 위반(0이어야 함)','safetyViolations'],['지연 중앙값(ms)','p50'],['지연 느린 5%(ms)','p95'],['턴당 AI 호출','callsPerTurn'],['턴당 토큰(입/출)','tokPerTurn'],['턴당 비용','costPerTurn'],['반복 간 흔들림','flaky']];
  h += rows.map(([n, f]) => '<tr><th>' + n + '</th>' + ms.map((m) => '<td class="num">' + esc(S(m.key, f)) + (f === 'flaky' ? ' / ' + esc(S(m.key, 'scenarioCount')) : '') + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
  h += '<h2>기능별 시나리오 성공률 · 지연(중앙값/느린 5%, ms)</h2><table><thead><tr><th>세트</th>' + ms.map((m) => '<th>' + esc(m.key) + '</th>').join('') + '</tr></thead><tbody>' +
    D.setTable.map((r) => '<tr><th>' + esc(r.set) + '</th>' + ms.map((m) => { const x = r.byModel[m.key]; return '<td class="num">' + (x && x.total ? Math.round(x.pass / x.total * 100) + '% (' + x.pass + '/' + x.total + ')<br><span class="sub">' + x.p50 + ' / ' + x.p95 + 'ms</span>' : '—') + '</td>'; }).join('') + '</tr>').join('') + '</tbody></table>';
  if (D.sites.length) {
    h += '<h2>실제 사이트 접근 가능성</h2><table><thead><tr><th>사이트</th><th>열림</th><th>종류</th><th>본문(자)</th><th>내용 링크</th><th>메뉴</th><th>검색창</th><th>열기(ms)</th></tr></thead><tbody>' +
      D.sites.map((r) => '<tr><td>' + esc(r.name) + '</td><td>' + (r.opened ? '✅' : '❌') + '</td><td>' + esc(r.kind) + '</td><td class="num">' + r.bodyChars + '</td><td class="num">' + r.contentLinks + '</td><td class="num">' + r.menu + '</td><td>' + (r.searchBox ? '있음' : '—') + '</td><td class="num">' + r.ms + '</td></tr>').join('') + '</tbody></table>';
  }
  if (D.voice.length) {
    const avg = (f) => Math.round(D.voice.reduce((n, r) => n + r[f], 0) / D.voice.length);
    h += '<h2>음성 경로</h2><p class="note">평균: 받아쓰기 ' + avg('sttMs') + 'ms + 처리 ' + avg('turnMs') + 'ms + 첫 문장 음성 ' + avg('firstAudioMs') + 'ms = ' + avg('totalMs') + 'ms (실제로는 말 끝 판단 1.5~2초가 더해짐) · 받아쓰기 글자 오류율 ' + (D.voice.reduce((n, r) => n + r.cer, 0) / D.voice.length).toFixed(3) + '</p><table><thead><tr><th>종류</th><th>발화</th><th>받아쓴 글</th><th>오류율</th><th>총(ms)</th></tr></thead><tbody>' +
      D.voice.map((r) => '<tr><td>' + esc(r.kind) + '</td><td>' + esc(r.text) + '</td><td>' + esc(r.heard) + '</td><td class="num">' + Number(r.cer).toFixed(2) + '</td><td class="num">' + r.totalMs + '</td></tr>').join('') + '</tbody></table>';
  }
  h += '<h2>실패한 답(첫 반복) — ' + D.failures.length + '건</h2>' + (D.failures.map((f) => '<div class="card fail"><div class="meta"><span class="tag model">' + esc(f.model) + '</span><span class="tag">' + esc(f.set) + '/' + esc(f.scenario) + '</span></div><div class="q">' + esc(f.utterance) + '</div><div class="a">' + esc(f.speech) + '</div><div class="why">' + esc(f.failures.join(' · ')) + '</div></div>').join('') || '<p class="note">없음</p>');
  $('#tab-auto').innerHTML = h;
})();

renderCards(); progress();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** results.json(실행기 출력) → 화면 데이터 */
export function reviewDataFromResults(r: {
  startedAt: string;
  models: { key: string; label: string }[];
  blind: Record<string, string>;
  summary: Record<string, Record<string, string | number>>;
  sets: string[];
  scenarios: { model: string; set: string; scenario: string; pass: boolean }[];
  steps: { model: string; set: string; scenario: string; difficulty: string; rep: number; last: boolean; utterance: string; speech: string; pass: boolean; failures: string[]; latencyMs: number }[];
  siteRows?: object[];
  voiceRows?: object[];
}): ReviewPageData {
  const labelOf = (model: string) => Object.entries(r.blind).find(([, k]) => k === model)?.[0] ?? '?';
  const allSets = [...new Set(r.scenarios.map((s) => s.set))];
  const q = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  // 채점용 답은 대표 문항(REVIEW_SAMPLE)만, (모델·시나리오)마다 첫 반복의 마지막 답. 순서는 이름 기반으로 섞어 실행마다 같은 순서.
  const items = r.steps
    .filter((s) => s.rep === 0 && s.last && REVIEW_SAMPLE.includes(s.scenario))
    .map((s) => ({ s, h: hash(`${s.set}/${s.scenario}/${s.model}`) }))
    .sort((a, b) => a.h - b.h)
    .map(({ s }, i) => ({ id: String(i + 1), set: s.set, scenario: s.scenario, difficulty: s.difficulty, utterance: s.utterance, speech: s.speech, label: labelOf(s.model), autoPass: s.pass, failures: s.failures }));
  return {
    title: '이음 서비스 평가',
    startedAt: r.startedAt,
    blind: r.blind,
    models: r.models,
    summary: r.summary,
    sets: allSets,
    setTable: allSets.map((set) => ({
      set,
      byModel: Object.fromEntries(
        r.models.map((m) => {
          const sc = r.scenarios.filter((s) => s.model === m.key && s.set === set);
          const lat = r.steps.filter((s) => s.model === m.key && s.set === set).map((s) => s.latencyMs);
          return [m.key, { pass: sc.filter((s) => s.pass).length, total: sc.length, p50: q(lat, 0.5), p95: q(lat, 0.95) }];
        }),
      ),
    })),
    failures: r.steps.filter((s) => s.rep === 0 && !s.pass).map((s) => ({ model: s.model, set: s.set, scenario: s.scenario, utterance: s.utterance, failures: s.failures, speech: s.speech })),
    sites: r.siteRows ?? [],
    voice: r.voiceRows ?? [],
    items,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
