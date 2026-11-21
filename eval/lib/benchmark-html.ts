/**
 * 서비스 비교 채점 화면(한 장짜리 HTML, 더블클릭으로 열림).
 * 서비스를 고르고 과제마다 기록 → 서비스별 비교표. 여러 팀원의 CSV를 불러와 합칠 수 있다.
 */
export interface BenchTask {
  id: string;
  /** 분야: 세금 신고·민원 접수·여권 발급·뉴스 검색·복지 지원 신청·공통 */
  domain: string;
  /** 표 15 공통 기능(①~⑧) 또는 특화 기능 */
  feature: string;
  /** 공통·노인·장애인(시각/지체/청각)·다문화가정 */
  userType: string;
  /** task = 말로 수행, check = 서비스 화면 기능 확인 */
  kind: 'task' | 'check';
  goal: string;
  start: string;
  prompt: string;
  followUps: string[];
  gold: { answer: string; source: string };
  checks: string[];
  timeLimitSec: number;
  safety?: boolean;
  note?: string;
}

export function buildBenchmarkHtml(tasks: BenchTask[], version: string): string {
  const json = JSON.stringify({ tasks, version }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>이음 서비스 비교 평가</title>
<style>
:root{--bg:#f6f7f9;--ink:#1d2330;--muted:#5b6474;--line:#e2e6ec;--accent:#2457d6;--good:#1f8a4c;--bad:#c23b32;--mid:#b26b00}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;background:var(--bg);color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px}
.top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 0}
h1{font-size:20px;margin:0}
.sub{color:var(--muted);font-size:14px}
nav{display:flex;gap:4px}
nav button{border:0;background:none;padding:10px 14px;font-size:15px;color:var(--muted);border-bottom:3px solid transparent;cursor:pointer}
nav button[aria-selected=true]{color:var(--ink);border-color:var(--accent);font-weight:600}
.btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 12px;font-size:14px;cursor:pointer;color:var(--ink)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #9db7ff;outline-offset:2px}
main{padding:18px 0 60px}
.box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:14px}
.who{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.who label{font-size:13px;color:var(--muted)}
.who input,.who select{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:14px}
.card.done{border-left:5px solid var(--good)} .card.partial{border-left:5px solid var(--mid)} .card.fail{border-left:5px solid var(--bad)}
.head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.head b{font-size:17px}
.tag{background:#eef2f8;border-radius:999px;padding:2px 10px;font-size:13px;color:var(--muted)}
.tag.safe{background:#fdecea;color:var(--bad)}
.say{background:#f1f5ff;border:1px solid #d7e2ff;border-radius:8px;padding:10px 14px;margin:8px 0;display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.gold{background:#f3fbf6;border:1px solid #cfe9d9;border-radius:8px;padding:10px 14px;margin:6px 0;font-size:14px}
.note{font-size:13px;color:var(--mid)}
.checks label{display:flex;gap:8px;align-items:flex-start;margin:6px 0;cursor:pointer}
.checks input{width:20px;height:20px;margin-top:3px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:14px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;background:#fff;padding:6px 11px;font-size:14px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--accent);color:#fff}
.num{width:64px;padding:5px 8px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:14px}
output{min-width:58px;font-variant-numeric:tabular-nums;font-weight:600}
textarea{width:100%;margin-top:10px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;min-height:38px;resize:vertical}
table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#f1f4f8}
.hidden{display:none}
</style>
</head>
<body>
<header><div class="wrap">
  <div class="top"><h1>서비스 비교 평가</h1><span class="sub" id="sub"></span>
    <span style="flex:1"></span>
    <button class="btn" id="export">CSV 내려받기</button>
    <label class="btn">CSV 불러오기<input type="file" id="import" accept=".csv" multiple hidden></label>
  </div>
  <nav role="tablist"><button role="tab" aria-selected="true" data-tab="run">과제 수행</button><button role="tab" aria-selected="false" data-tab="compare">비교표</button><button role="tab" aria-selected="false" data-tab="guide">진행 규칙</button></nav>
</div></header>
<main class="wrap">
<section id="tab-run">
  <div class="box who">
    <div><label for="service">평가할 서비스</label><select id="service"><option>이음</option><option>ChatGPT</option><option>Gemini</option><option>ChatGPT 에이전트</option><option>기타 브라우저 에이전트</option></select></div>
    <div><label for="mode">버전·모드</label><input id="mode" placeholder="예: 음성 모드, 웹 검색 켬"></div>
    <div><label for="tester">수행한 사람</label><input id="tester" placeholder="이름"></div>
    <div><label for="date">날짜</label><input id="date" type="date"></div>
  </div>
  <div id="tasks"></div>
</section>
<section id="tab-compare" class="hidden"></section>
<section id="tab-guide" class="hidden">
  <div class="box">
  <h2 style="font-size:18px;margin-top:0">공정하게 비교하는 규칙</h2>
  <ol>
    <li>모든 서비스에 <b>파란 칸의 문장을 그대로</b> 말하거나 입력합니다. 힌트를 더하지 않습니다.</li>
    <li>과제마다 <b>새 대화</b>로 시작합니다(이어 묻기 과제만 같은 대화에서).</li>
    <li>가능하면 <b>음성 모드</b>로 하고, 화면낭독기를 켭니다. 쓴 모드를 "버전·모드"에 적습니다.</li>
    <li>시간은 요청을 끝낸 순간 "시작", 과제가 끝났다고 판단한 순간 "끝". 제한 시간을 넘기면 실패로 적습니다.</li>
    <li>실제 사이트 과제(C)는 같은 날, 비슷한 시각에 모든 서비스를 수행하고, 테스터가 직접 사이트를 열어 정답을 확인합니다.</li>
    <li>안전 과제(D)의 주민번호·비밀번호는 <b>가짜 값</b>만 씁니다. 실제 로그인·제출은 하지 않습니다.</li>
    <li>"개입 횟수"는 사람이 화면을 보거나 마우스·키보드로 대신 해 준 횟수입니다(시각장애인이라면 할 수 없었던 도움).</li>
  </ol>
  <p class="sub">기록은 이 브라우저에 서비스별로 저장됩니다. 끝나면 CSV로 내려받아 공유하고, 모은 CSV를 "CSV 불러오기"로 합치면 비교표가 만들어집니다.</p>
  </div>
</section>
</main>
<script type="application/json" id="data">${json}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
const KEY = 'ieum-bench-v' + D.version;
const S = JSON.parse(localStorage.getItem(KEY) || '{"runs":{},"meta":{}}');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const save = () => localStorage.setItem(KEY, JSON.stringify(S));
$('#sub').textContent = '과제 ' + D.tasks.length + '개 · 데이터 v' + D.version;
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  ['run','compare','guide'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab));
  if (b.dataset.tab === 'compare') renderCompare();
}));
const svc = () => $('#service').value;
const run = (id) => { const r = (S.runs[svc()] = S.runs[svc()] || {}); return (r[id] = r[id] || { checks: [], result: '', accuracy: '', fabricated: false, unsafe: false, secs: null, turns: '', helps: '', memo: '' }); };
const meta = () => (S.meta[svc()] = S.meta[svc()] || { mode: '', tester: '', date: new Date().toISOString().slice(0, 10) });
function loadMeta() { const m = meta(); $('#mode').value = m.mode; $('#tester').value = m.tester; $('#date').value = m.date; }
['mode','tester','date'].forEach((k) => $('#' + k).addEventListener('input', (e) => { meta()[k] = e.target.value; save(); }));
$('#service').addEventListener('change', () => { loadMeta(); render(); });

const RESULTS = ['완료','일부','실패'], ACC = ['정확','일부 정확','틀림','모른다고 함'];
function render() {
  $('#tasks').innerHTML = D.tasks.map((t) => {
    const r = run(t.id);
    const seg = (name, opts) => '<span class="seg" role="group" aria-label="' + name + '">' + opts.map((o) => '<button data-k="' + name + '" data-t="' + t.id + '" aria-pressed="' + (r[name === '결과' ? 'result' : 'accuracy'] === o) + '">' + o + '</button>').join('') + '</span>';
    return '<article class="card ' + ({'완료':'done','일부':'partial','실패':'fail'}[r.result] || '') + '" id="c-' + t.id + '">' +
      '<div class="head"><b>' + t.id + '. ' + esc(t.goal) + '</b><span class="tag">' + esc(t.domain) + '</span><span class="tag">' + esc(t.feature) + '</span><span class="tag">' + esc(t.userType) + '</span>' + (t.kind === 'check' ? '<span class="tag">확인 과제</span>' : '') + (t.safety ? '<span class="tag safe">안전</span>' : '') + '<span class="tag">제한 ' + t.timeLimitSec + '초</span></div>' +
      '<div class="sub">시작: ' + esc(t.start) + '</div>' +
      '<div class="say"><div>🗣 ' + esc(t.prompt) + (t.followUps.length ? '<br>이어서: ' + t.followUps.map(esc).join(' / ') : '') + '</div><button class="btn" data-copy="' + esc(t.prompt) + '">복사</button></div>' +
      '<div class="gold"><b>정답·기대:</b> ' + esc(t.gold.answer) + '<br><span class="sub">' + esc(t.gold.source) + '</span></div>' + (t.note ? '<div class="note">⚠ ' + esc(t.note) + '</div>' : '') +
      '<div class="checks">' + t.checks.map((c, i) => '<label><input type="checkbox" data-c="' + t.id + '" data-i="' + i + '"' + (r.checks[i] ? ' checked' : '') + '> ' + esc(c) + '</label>').join('') + '</div>' +
      '<div class="row">결과 ' + seg('결과', RESULTS) + ' 정확성 ' + seg('정확성', ACC) + '</div>' +
      '<div class="row"><label><input type="checkbox" data-f="fabricated" data-t="' + t.id + '"' + (r.fabricated ? ' checked' : '') + '> 지어낸 내용 있음</label>' +
      '<label><input type="checkbox" data-f="unsafe" data-t="' + t.id + '"' + (r.unsafe ? ' checked' : '') + '> 안전 문제(민감정보 반복·대신 로그인/제출 등)</label></div>' +
      '<div class="row">시간 <button class="btn" data-start="' + t.id + '">시작</button><button class="btn" data-stop="' + t.id + '">끝</button><output id="o-' + t.id + '">' + (r.secs != null ? r.secs.toFixed(1) + '초' : '—') + '</output>' +
      ' 주고받은 횟수 <input class="num" type="number" min="0" data-n="turns" data-t="' + t.id + '" value="' + esc(r.turns) + '">' +
      ' 개입 횟수 <input class="num" type="number" min="0" data-n="helps" data-t="' + t.id + '" value="' + esc(r.helps) + '"></div>' +
      '<textarea data-memo="' + t.id + '" placeholder="메모: 실제 답, 막힌 곳 등">' + esc(r.memo) + '</textarea></article>';
  }).join('');
}
let timer = null;
document.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.copy) navigator.clipboard?.writeText(b.dataset.copy);
  if (b.dataset.k) { const r = run(b.dataset.t); r[b.dataset.k === '결과' ? 'result' : 'accuracy'] = b.textContent; save(); b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); const c = $('#c-' + b.dataset.t); c.className = 'card ' + ({'완료':'done','일부':'partial','실패':'fail'}[r.result] || ''); }
  if (b.dataset.start) { timer = { id: b.dataset.start, at: performance.now() }; $('#o-' + timer.id).textContent = '재는 중…'; }
  if (b.dataset.stop && timer && timer.id === b.dataset.stop) { run(timer.id).secs = (performance.now() - timer.at) / 1000; $('#o-' + timer.id).textContent = run(timer.id).secs.toFixed(1) + '초'; timer = null; save(); }
});
document.addEventListener('change', (e) => {
  const c = e.target.closest('input[data-c]'); if (c) { run(c.dataset.c).checks[Number(c.dataset.i)] = c.checked; save(); }
  const f = e.target.closest('input[data-f]'); if (f) { run(f.dataset.t)[f.dataset.f] = f.checked; save(); }
});
document.addEventListener('input', (e) => {
  const n = e.target.closest('input[data-n]'); if (n) { run(n.dataset.t)[n.dataset.n] = n.value; save(); }
  const m = e.target.closest('textarea[data-memo]'); if (m) { run(m.dataset.memo).memo = m.value; save(); }
});

function renderCompare() {
  const svcs = Object.keys(S.runs).filter((s) => Object.values(S.runs[s]).some((r) => r.result));
  if (!svcs.length) { $('#tab-compare').innerHTML = '<div class="box">아직 기록이 없습니다. 과제를 수행하거나 CSV를 불러오세요.</div>'; return; }
  const stat = (s, f) => { const rs = D.tasks.map((t) => [t, S.runs[s][t.id]]).filter(([, r]) => r && r.result); return f(rs); };
  const pct = (a, b) => (b ? Math.round(a / b * 100) + '%' : '—');
  const avg = (xs) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '—');
  const rows = [
    ['수행한 과제', (s) => stat(s, (rs) => rs.length + ' / ' + D.tasks.length)],
    ['완료율', (s) => stat(s, (rs) => pct(rs.filter(([, r]) => r.result === '완료').length, rs.length))],
    ['완료+일부', (s) => stat(s, (rs) => pct(rs.filter(([, r]) => r.result !== '실패').length, rs.length))],
    ['정답 정확', (s) => stat(s, (rs) => { const a = rs.filter(([, r]) => r.accuracy); return pct(a.filter(([, r]) => r.accuracy === '정확').length, a.length); })],
    ['지어낸 내용(건)', (s) => stat(s, (rs) => rs.filter(([, r]) => r.fabricated).length)],
    ['안전 문제(건)', (s) => stat(s, (rs) => rs.filter(([, r]) => r.unsafe).length)],
    ['평균 시간(초)', (s) => stat(s, (rs) => avg(rs.map(([, r]) => r.secs).filter((x) => x != null)))],
    ['평균 주고받은 횟수', (s) => stat(s, (rs) => avg(rs.map(([, r]) => Number(r.turns)).filter((x) => x > 0)))],
    ['사람 개입 합계', (s) => stat(s, (rs) => rs.reduce((n, [, r]) => n + (Number(r.helps) || 0), 0))],
  ];
  const cats = [...new Set(D.tasks.map((t) => t.feature))];
  const users = [...new Set(D.tasks.map((t) => t.userType))];
  const domains = [...new Set(D.tasks.map((t) => t.domain))];
  const byGroup = (title, groups, key) => '<div class="box"><b>' + title + '</b><table><thead><tr><th>' + ({ feature: '기능', userType: '사용자 유형', domain: '분야' }[key]) + '</th><th>과제 수</th>' + svcs.map((s) => '<th>' + esc(s) + '</th>').join('') + '</tr></thead><tbody>' +
    groups.map((c) => '<tr><th>' + esc(c) + '</th><td>' + D.tasks.filter((t) => t[key] === c).length + '</td>' + svcs.map((s) => '<td>' + stat(s, (rs) => { const x = rs.filter(([t]) => t[key] === c); return pct(x.filter(([, r]) => r.result === '완료').length, x.length); }) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  let h = '<div class="box"><b>서비스별 비교</b><table><thead><tr><th>지표</th>' + svcs.map((s) => '<th>' + esc(s) + '<br><span class="sub">' + esc(S.meta[s]?.mode || '') + '</span></th>').join('') + '</tr></thead><tbody>' +
    rows.map(([n, f]) => '<tr><th>' + n + '</th>' + svcs.map((s) => '<td>' + f(s) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
  h += byGroup('분야별 완료율 (세금·민원·여권·뉴스·복지)', domains, 'domain');
  h += byGroup('기능별 완료율 (표 15 공통 기능 ①~⑧ · 특화 기능)', cats, 'feature');
  h += byGroup('사용자 유형별 완료율', users, 'userType');
  h += '<div class="box"><b>과제별 결과</b><table><thead><tr><th>과제</th>' + svcs.map((s) => '<th>' + esc(s) + '</th>').join('') + '</tr></thead><tbody>' +
    D.tasks.map((t) => '<tr><td>' + t.id + ' ' + esc(t.goal) + '</td>' + svcs.map((s) => { const r = S.runs[s][t.id]; return '<td>' + (r && r.result ? esc(r.result) + (r.secs != null ? ' · ' + r.secs.toFixed(0) + '초' : '') + (r.fabricated ? ' · 지어냄' : '') + (r.unsafe ? ' · 안전문제' : '') : '—') + '</td>'; }).join('') + '</tr>').join('') + '</tbody></table></div>';
  $('#tab-compare').innerHTML = h;
}

const COLS = ['서비스','버전·모드','수행한 사람','날짜','과제','분야','기능','사용자 유형','결과','정확성','지어냄','안전문제','시간(초)','주고받은 횟수','개입 횟수','통과 항목','메모'];
$('#export').addEventListener('click', () => {
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [];
  for (const [s, rs] of Object.entries(S.runs)) for (const t of D.tasks) { const r = rs[t.id]; if (!r || !r.result) continue; const m = S.meta[s] || {}; rows.push([s, m.mode, m.tester, m.date, t.id, t.domain, t.feature, t.userType, r.result, r.accuracy, r.fabricated ? 'Y' : '', r.unsafe ? 'Y' : '', r.secs != null ? r.secs.toFixed(1) : '', r.turns, r.helps, r.checks.map((x, i) => x ? i + 1 : '').filter(Boolean).join(' '), r.memo]); }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\\ufeff' + [COLS, ...rows].map((r) => r.map(cell).join(',')).join('\\n')], { type: 'text/csv' }));
  a.download = '서비스비교-' + (S.meta[svc()]?.tester || '이름없음') + '.csv'; a.click();
});
function parseCsv(text) { const out = []; let row = [], cell = '', q = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\\n' || c === '\\r') { if (c === '\\r' && text[i + 1] === '\\n') i++; row.push(cell); out.push(row); row = []; cell = ''; } else cell += c; } if (cell || row.length) { row.push(cell); out.push(row); } return out; }
$('#import').addEventListener('change', async (e) => {
  let n = 0;
  for (const f of e.target.files) {
    const [head, ...rows] = parseCsv((await f.text()).replace(/^\\ufeff/, '')).filter((r) => r.length >= COLS.length - 1);
    for (const r of rows) {
      const g = (k) => r[head.indexOf(k)];
      const s = g('서비스'); if (!s) continue;
      S.meta[s] = { mode: g('버전·모드'), tester: g('수행한 사람'), date: g('날짜') };
      const rs = (S.runs[s] = S.runs[s] || {});
      const checks = []; String(g('통과 항목') || '').split(' ').filter(Boolean).forEach((x) => (checks[Number(x) - 1] = true));
      rs[g('과제')] = { checks, result: g('결과'), accuracy: g('정확성'), fabricated: g('지어냄') === 'Y', unsafe: g('안전문제') === 'Y', secs: g('시간(초)') ? Number(g('시간(초)')) : null, turns: g('주고받은 횟수'), helps: g('개입 횟수'), memo: g('메모') };
      n++;
    }
  }
  save(); loadMeta(); render(); alert(n + '개 기록을 불러왔습니다. 비교표 탭에서 확인하세요.');
});
loadMeta(); render();
</script>
</body>
</html>`;
}
