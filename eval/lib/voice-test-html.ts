/**
 * 팀원용 음성 테스트 체크리스트 화면(한 장짜리 HTML, 더블클릭으로 열림).
 * 데스크톱 앱에 실제로 말해 보고 과제마다: 확인 항목 체크, 받아쓰기 정확, 기다린 시간(스톱워치), 메모 → 자동 저장, 요약, CSV.
 */

export interface VoiceTask {
  id: string;
  feature: string;
  prepare: string;
  say: string[];
  checks: string[];
  tip?: string;
}

export function buildVoiceTestHtml(tasks: VoiceTask[]): string {
  const json = JSON.stringify(tasks).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>이음 음성 테스트 체크리스트</title>
<style>
:root{--bg:#f6f7f9;--ink:#1d2330;--muted:#5b6474;--line:#e2e6ec;--accent:#2457d6;--good:#1f8a4c;--bad:#c23b32;--mid:#b26b00}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;background:var(--bg);color:var(--ink)}
header{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
.top{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:14px 0}
h1{font-size:20px;margin:0}
.sub{color:var(--muted);font-size:14px}
.progress{flex:1;min-width:180px;height:10px;background:var(--line);border-radius:6px;overflow:hidden}
.progress>div{height:100%;background:var(--accent);width:0}
.btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer;color:var(--ink)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #9db7ff;outline-offset:2px}
main{padding:20px 0 60px}
.box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:14px}
.who{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.who label{font-size:13px;color:var(--muted)}
.who input,.who select{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:14px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 20px;margin-bottom:14px}
.card.pass{border-left:5px solid var(--good)} .card.partial{border-left:5px solid var(--mid)} .card.fail{border-left:5px solid var(--bad)}
.head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.head b{font-size:17px}
.tag{background:#eef2f8;border-radius:999px;padding:2px 10px;font-size:13px;color:var(--muted)}
.prep{color:var(--muted);font-size:14px;margin:4px 0 8px}
.say{background:#f1f5ff;border:1px solid #d7e2ff;border-radius:8px;padding:10px 14px;margin:6px 0}
.say div::before{content:"🗣 ";}
.tip{font-size:13px;color:var(--mid);margin:4px 0 8px}
.checks label{display:flex;gap:8px;align-items:flex-start;margin:6px 0;cursor:pointer}
.checks input{width:20px;height:20px;margin-top:3px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:14px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;background:#fff;padding:6px 12px;font-size:14px;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed=true]{background:var(--accent);color:#fff}
.timer{display:inline-flex;gap:6px;align-items:center}
.timer output{min-width:62px;font-variant-numeric:tabular-nums;font-weight:600}
textarea{width:100%;margin-top:10px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;min-height:38px;resize:vertical}
.result{font-weight:600;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
th{background:#f1f4f8}
.hidden{display:none}
</style>
</head>
<body>
<header><div class="wrap"><div class="top">
  <h1>이음 음성 테스트</h1>
  <div class="progress" role="progressbar" aria-label="진행률" aria-valuemin="0" aria-valuemax="100"><div id="pbar"></div></div>
  <span class="sub" id="ptext"></span>
  <button class="btn" id="summaryBtn">요약 보기</button>
  <button class="btn primary" id="csv">CSV 내려받기</button>
</div></div></header>
<main class="wrap">
  <div class="box">
    <b>하는 법</b>
    <ol class="sub" style="margin:6px 0 0;padding-left:20px">
      <li>데스크톱 앱을 켭니다(<code>npm run desktop</code>). 과제를 위에서부터 차례로, 띵 소리가 난 뒤 <b>파란 칸의 말을 그대로</b> 말하세요.</li>
      <li>이음의 반응을 듣고 맞는 항목에 체크하세요. 받아쓰기가 맞았는지도 표시합니다(메뉴 막대 <b>이음 → 창 보기</b>를 열어 두면 대화 기록에서 받아쓴 글을 볼 수 있습니다).</li>
      <li>기다린 시간은 <b>말을 끝내는 순간 "시작"</b>, <b>이음이 말하기 시작하면 "멈춤"</b>을 누르세요(대략이면 충분).</li>
      <li>이상한 점은 메모에. 끝나면 <b>CSV 내려받기</b>로 받아 팀에 공유하세요. 기록은 이 브라우저에 자동 저장됩니다.</li>
    </ol>
  </div>
  <div class="box who">
    <div><label for="tester">테스트한 사람</label><input id="tester" placeholder="이름"></div>
    <div><label for="device">컴퓨터</label><input id="device" placeholder="예: 맥북 에어 M2"></div>
    <div><label for="mic">마이크</label><select id="mic"><option>내장 마이크</option><option>이어폰 마이크</option><option>외장 마이크</option></select></div>
    <div><label for="env">주변 소음</label><select id="env"><option>조용함</option><option>보통</option><option>시끄러움</option></select></div>
  </div>
  <div id="summary" class="box hidden"></div>
  <div id="tasks"></div>
</main>
<script type="application/json" id="data">${json}</script>
<script>
const TASKS = JSON.parse(document.getElementById('data').textContent);
const KEY = 'ieum-voice-test';
const S = JSON.parse(localStorage.getItem(KEY) || '{"tasks":{},"who":{}}');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const save = () => { localStorage.setItem(KEY, JSON.stringify(S)); progress(); };
const st = (id) => (S.tasks[id] = S.tasks[id] || { checks: [], stt: '', secs: null, memo: '' });
['tester','device','mic','env'].forEach((k) => { const el = $('#' + k); if (S.who[k]) el.value = S.who[k]; el.addEventListener('input', () => { S.who[k] = el.value; save(); }); });

function verdict(t) {
  const s = S.tasks[t.id]; if (!s || (!s.checks.length && !s.stt && s.secs == null)) return '';
  const n = s.checks.filter(Boolean).length;
  return n === t.checks.length ? 'pass' : n === 0 ? 'fail' : 'partial';
}
const LABEL = { pass: '통과', partial: '일부', fail: '실패', '': '아직' };
function progress() {
  const done = TASKS.filter((t) => verdict(t)).length;
  const p = Math.round(done / TASKS.length * 100);
  $('#pbar').style.width = p + '%';
  $('#ptext').textContent = done + ' / ' + TASKS.length + ' 과제';
  document.querySelector('[role=progressbar]').setAttribute('aria-valuenow', p);
  TASKS.forEach((t) => { const c = document.getElementById('t-' + t.id); if (!c) return; c.className = 'card ' + verdict(t); c.querySelector('.result').textContent = '결과: ' + LABEL[verdict(t)]; });
}

$('#tasks').innerHTML = TASKS.map((t) => {
  const s = st(t.id);
  return '<article class="card" id="t-' + t.id + '"><div class="head"><b>' + t.id + '. ' + esc(t.feature) + '</b><span class="tag">' + esc(t.prepare) + '</span></div>' +
    '<div class="say">' + t.say.map((x) => '<div>' + esc(x) + '</div>').join('') + '</div>' + (t.tip ? '<div class="tip">💡 ' + esc(t.tip) + '</div>' : '') +
    '<div class="checks">' + t.checks.map((c, i) => '<label><input type="checkbox" data-t="' + t.id + '" data-i="' + i + '"' + (s.checks[i] ? ' checked' : '') + '> ' + esc(c) + '</label>').join('') + '</div>' +
    '<div class="row"><span>받아쓰기</span><span class="seg" role="group" aria-label="받아쓰기 정확">' + ['맞음','조금 틀림','많이 틀림'].map((v) => '<button data-stt="' + t.id + '" aria-pressed="' + (s.stt === v) + '">' + v + '</button>').join('') + '</span>' +
    '<span class="timer"><span>기다린 시간</span><button class="btn" data-start="' + t.id + '">시작</button><button class="btn" data-stop="' + t.id + '">멈춤</button><output id="o-' + t.id + '">' + (s.secs != null ? s.secs.toFixed(1) + '초' : '—') + '</output></span>' +
    '<span class="result"></span></div>' +
    '<textarea data-memo="' + t.id + '" placeholder="메모: 이상한 점, 실제로 들은 답 등">' + esc(s.memo) + '</textarea></article>';
}).join('');

let running = null;
document.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.stt) { const s = st(b.dataset.stt); s.stt = b.textContent; b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); save(); }
  if (b.dataset.start) { running = { id: b.dataset.start, at: performance.now() }; $('#o-' + running.id).textContent = '재는 중…'; }
  if (b.dataset.stop && running && running.id === b.dataset.stop) { const secs = (performance.now() - running.at) / 1000; st(running.id).secs = secs; $('#o-' + running.id).textContent = secs.toFixed(1) + '초'; running = null; save(); }
});
document.addEventListener('change', (e) => {
  const c = e.target.closest('input[type=checkbox][data-t]'); if (!c) return;
  st(c.dataset.t).checks[Number(c.dataset.i)] = c.checked; save();
});
document.addEventListener('input', (e) => { const m = e.target.closest('textarea[data-memo]'); if (m) { st(m.dataset.memo).memo = m.value; save(); } });

$('#summaryBtn').addEventListener('click', () => {
  const vs = TASKS.map(verdict);
  const n = (v) => vs.filter((x) => x === v).length;
  const secs = TASKS.map((t) => S.tasks[t.id]?.secs).filter((x) => x != null);
  const stt = TASKS.map((t) => S.tasks[t.id]?.stt).filter(Boolean);
  const avg = secs.length ? (secs.reduce((a, b) => a + b, 0) / secs.length).toFixed(1) + '초' : '—';
  $('#summary').innerHTML = '<b>요약</b><table><tbody>' +
    '<tr><th>통과 / 일부 / 실패</th><td>' + n('pass') + ' / ' + n('partial') + ' / ' + n('fail') + ' (' + vs.filter(Boolean).length + '개 중)</td></tr>' +
    '<tr><th>받아쓰기 맞음</th><td>' + stt.filter((x) => x === '맞음').length + ' / ' + stt.length + '</td></tr>' +
    '<tr><th>기다린 시간 평균</th><td>' + avg + (secs.length ? ' (가장 길었던 ' + Math.max(...secs).toFixed(1) + '초)' : '') + '</td></tr>' +
    '<tr><th>실패·일부</th><td>' + (TASKS.filter((t) => ['fail','partial'].includes(verdict(t))).map((t) => t.id + ' ' + esc(t.feature)).join(', ') || '없음') + '</td></tr></tbody></table>';
  $('#summary').classList.remove('hidden');
  $('#summary').scrollIntoView({ behavior: 'smooth' });
});

$('#csv').addEventListener('click', () => {
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const head = ['테스트한 사람','컴퓨터','마이크','주변 소음','과제','기능','말한 것','결과','통과 항목 수','전체 항목 수','받아쓰기','기다린 시간(초)','메모'];
  const rows = TASKS.map((t) => { const s = S.tasks[t.id] || { checks: [] }; return [S.who.tester, S.who.device, S.who.mic, S.who.env, t.id, t.feature, t.say.join(' / '), LABEL[verdict(t)], s.checks.filter(Boolean).length, t.checks.length, s.stt, s.secs != null ? s.secs.toFixed(1) : '', s.memo]; });
  const csv = '\\ufeff' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = '음성테스트-' + (S.who.tester || '이름없음') + '.csv'; a.click();
});
progress();
</script>
</body>
</html>`;
}
