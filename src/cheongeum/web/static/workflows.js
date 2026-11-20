import { api } from './api.js';

const copy = {
  ko: ['자료 조사와 저장한 메모', '공개 자료에서 확인할 질문', '이 질문과 결과를 저장하고 앱을 다시 열어도 조사를 이어가는 데 동의해요.', '조사 맡기기', '기억할 선호 사항이나 찾을 내용', '이 메모를 저장하고 관련 질문과 함께 OpenAI에서 검색해 대화에 활용하는 데 동의해요.', '메모 저장', '메모 찾기', '전체 보기', '중단', '삭제', '질문 수정', '저장하거나 검색할 내용을 확인해 주세요. 개인 연락처나 인증 정보는 빼 주세요.', '관련 메모가 없어요.', '처리하지 못했어요. 잠시 후 다시 시도해 주세요.', '완료한 조사나 메모를 삭제하고 다시 시도해 주세요.', '변경 사항을 저장했어요.'],
  en: ['Research and saved notes', 'Question for public sources', 'Save this question and its results, and continue the research when I reopen the app.', 'Start research', 'Preference to remember or terms to find', 'Save this note and use OpenAI to match it with relevant questions during conversations.', 'Save note', 'Find notes', 'Show all', 'Cancel', 'Delete', 'Revise question', 'Check the text and remove personal contact details or credentials.', 'No matching notes.', 'The request failed. Please try again.', 'Delete a finished lookup or note and try again.', 'Changes saved.'],
  zh: ['资料调查和已存笔记', '要查阅公开资料的问题', '同意保存问题和结果，重新打开应用时继续调查。', '开始调查', '要记住的偏好或要搜索的词', '同意保存此笔记，并在对话中通过 OpenAI 与相关问题进行匹配。', '保存笔记', '查找笔记', '显示全部', '取消', '删除', '修改问题', '请检查输入，删除个人联系方式或认证信息。', '没有匹配的笔记。', '请求失败，请稍后再试。', '请删除已结束的调查或笔记后再试。', '更改已保存。'],
  ja: ['資料調査と保存したメモ', '公開資料で調べる質問', '質問と結果を保存し、アプリを再度開いたときも調査を続けることに同意します。', '調査を依頼', '覚えておく希望や検索語', 'このメモの保存と、会話中に OpenAI で関連する質問と照合することに同意します。', 'メモを保存', 'メモを検索', 'すべて表示', '中止', '削除', '質問を修正', '入力を確認し、個人の連絡先や認証情報を削除してください。', '該当するメモはありません。', '処理できませんでした。もう一度お試しください。', '終了した調査やメモを削除してからお試しください。', '変更を保存しました。'],
};
const states = {
  queued: ['접수됨', 'Queued', '排队中', '受付済み'], running: ['조사 중', 'Researching', '调查中', '調査中'],
  completed: ['조사 완료', 'Completed', '已完成', '調査完了'], partial: ['일부 확인', 'Partially verified', '部分已确认', '一部確認'],
  incomplete: ['확인하지 못함', 'Unverified', '未能确认', '未確認'], failed: ['실패', 'Failed', '失败', '失敗'],
  needs_input: ['질문 보완 필요', 'Clarification needed', '需要补充说明', '質問の補足が必要'], cancelled: ['중단됨', 'Cancelled', '已取消', '中止済み'],
};
const $ = id => document.getElementById(id);
const labels = ['workflow-title', 'research-label', 'research-permission', 'research-add', 'note-label',
  'note-permission', 'note-add', 'note-search', 'note-all'];
let current, lang = 'ko', timer, snapshot, filter, initialized = false, mutation = false, readVersion = 0;
const t = index => (copy[lang] || copy.ko)[index];

function button(label, action) {
  const el = document.createElement('button');
  el.type = 'button'; el.textContent = label;
  el.addEventListener('click', action);
  return el;
}

function renderLists() {
  if (!snapshot) return;
  const language = Math.max(0, ['ko', 'en', 'zh', 'ja'].indexOf(lang));
  $('research-list').replaceChildren(...snapshot.jobs.map(job => {
    const li = document.createElement('li'), text = document.createElement('p');
    text.textContent = job.prompt + ' · ' + (states[job.state]?.[language] || job.state);
    li.append(text);
    if (job.result?.text) {
      const summary = document.createElement('p'); summary.textContent = job.result.text; li.append(summary);
    }
    for (const source of job.result?.sources || []) {
      if (!/^https:\/\//i.test(source.url)) continue;
      const link = document.createElement('a'); link.href = source.url; link.textContent = source.title;
      link.target = '_blank'; link.rel = 'noreferrer'; li.append(link, document.createTextNode(' '));
    }
    const inProgress = ['queued','running'].includes(job.state);
    li.append(button(t(inProgress ? 9 : 10), () => change('/research/' + job.id + (inProgress ? '/claim' : ''), 'DELETE')));
    if (['needs_input','incomplete','failed','partial'].includes(job.state)) {
      li.append(button(t(11), () => { $('research-input').value = job.prompt; $('research-input').focus(); }));
    }
    return li;
  }));
  const matches = filter || snapshot.notes;
  $('note-list').replaceChildren(...matches.map(note => {
    const li = document.createElement('li'); li.append(document.createTextNode(note.body + ' '),
      button(t(10), () => change('/notes/' + note.id, 'DELETE')));
    return li;
  }));
  if (filter && !matches.length) $('workflow-feedback').textContent = t(13);
}

async function refresh() {
  clearTimeout(timer);
  if (!current || !$('workflow-panel').open) return;
  const id = current, version = ++readVersion;
  try {
    const data = await api.workspace(id);
    if (current !== id || version !== readVersion) return;
    if (JSON.stringify(snapshot) !== JSON.stringify(data)) {
      snapshot = data;
      renderLists();
    }
  } catch {
    if (current === id && version === readVersion) $('workflow-feedback').textContent = t(14);
  }
  if (current === id && version === readVersion && $('workflow-panel').open) timer = setTimeout(refresh, 3500);
}

async function change(path, method, data, onDone) {
  if (!current || mutation) return;
  const id = current;
  mutation = true;
  try {
    const result = await api.workspace(id, path, method, data);
    if (current !== id) return;
    filter = undefined;
    $('workflow-feedback').textContent = t(16);
    onDone?.(result);
    renderLists();
    await refresh();
  } catch (error) {
    if (current === id) $('workflow-feedback').textContent = t(error.code === 'PUBLIC_TEXT_REQUIRED' ? 12 : error.code === 'WORKSPACE_LIMIT' ? 15 : 14);
  } finally { mutation = false; }
}

function init() {
  $('workflow-panel').addEventListener('toggle', refresh);
  $('research-form').addEventListener('submit', e => {
    e.preventDefault();
    change('/research', 'POST', { text: $('research-input').value, consent: $('research-consent').checked,
      requestId: crypto.randomUUID() }, () => $('research-form').reset());
  });
  $('note-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!$('note-consent').checked) { $('note-consent').focus(); $('workflow-feedback').textContent = t(5); return; }
    change('/notes', 'POST', { text: $('note-input').value, consent: true }, () => $('note-form').reset());
  });
  $('note-search').addEventListener('click', () => {
    if ($('note-input').reportValidity()) change('/notes/search', 'POST', { text: $('note-input').value },
      result => { filter = result.notes; $('workflow-feedback').textContent = ''; });
  });
  $('note-all').addEventListener('click', () => { filter = undefined; $('workflow-feedback').textContent = ''; renderLists(); });
}

export function syncWorkspace(sid, enabled, language) {
  const panel = $('workflow-panel');
  if (!panel) return;
  if (!initialized) { init(); initialized = true; }
  const next = enabled ? sid : undefined;
  if (current !== next) {
    clearTimeout(timer); readVersion++;
    snapshot = filter = undefined;
    panel.open = false;
    $('research-form').reset(); $('note-form').reset();
    for (const id of ['research-list', 'note-list', 'workflow-feedback']) $(id).replaceChildren();
    current = next;
  }
  panel.hidden = !current;
  if (language !== lang || !$(labels[1]).textContent) {
    lang = copy[language] ? language : 'ko';
    labels.forEach((id, i) => { $(id).textContent = t(i); });
    renderLists();
  }
}
