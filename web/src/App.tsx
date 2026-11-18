import { Fragment, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { LANGS, LangSchema, STATE_LABELS_KO } from "../../src/core/turn.ts";
import { browserStt } from "./mic.ts";
import { browserTts } from "./speaker.ts";
import {
  answerConsent, confirm, consentText, endConversation, EXAMPLES, hearConsent, PHASE_LABELS,
  selectLanguage, selectMic, send, snapshot, soundCheck, startConversation, stopAll, stopSpeaking,
  subscribe, talkNow, toggleContrast, toggleMic, toggleTts, UNSUPPORTED, voiceHelp, type UiState,
} from "./conversation.ts";

const LANG_NAMES = { ko: "한국어", en: "English", zh: "中文", ja: "日本語" };

function Toolbar({ui}: {ui: UiState}) {
  return <header className="app-header">
    <h1>청음 — 음성 복지 신청 도우미 (데모)</h1>
    <div className="toolbar" role="group" aria-label="도구">
      <button type="button" className="stop" id="stop-all" onClick={() => void stopAll()}>멈춰 (모든 동작 중단)</button>
      <button type="button" id="tts-toggle" aria-pressed={ui.tts} disabled={!browserTts.supported && !ui.voiceMode.tts} onClick={toggleTts}>음성 안내 {ui.tts ? "켜짐" : "꺼짐"}</button>
      <button type="button" id="sound-check" onClick={soundCheck}>소리 확인</button>
      <button type="button" id="stop-speaking" onClick={stopSpeaking}>말하기 중지</button>
      <button type="button" id="contrast-toggle" aria-pressed={ui.contrast} onClick={toggleContrast}>고대비 {ui.contrast ? "켜짐" : "꺼짐"}</button>
    </div>
  </header>;
}
function ConsentPanel({ui}: {ui: UiState}) {
  return <section className="panel consent" id="consent-panel" aria-labelledby="consent-title" aria-describedby="consent-text" hidden={ui.consent !== "intro" && ui.consent !== "ask"}>
    <h2 id="consent-title">시작 전 안내와 동의</h2><p id="consent-text">{consentText()}</p>
    <div className="row">
      <button type="button" className="primary big" id="consent-hear" hidden={ui.consent !== "intro"} disabled={ui.sessionId === undefined} onClick={() => void hearConsent()}>안내 듣고 시작하기 (Enter)</button>
      <button type="button" className="primary big" id="consent-yes" hidden={ui.consent !== "ask"} onClick={() => void answerConsent(true)}>동의하고 시작 (Enter)</button>
      <button type="button" className="big" id="consent-no" hidden={ui.consent !== "ask"} onClick={() => void answerConsent(false)}>동의하지 않음 (Esc)</button>
    </div>
  </section>;
}
function ConversationPanel({ui}: {ui: UiState}) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (input.current !== null) input.current.value = ""; }, [ui.clearInput]);
  const off = ui.phase === "off";
  const waits = ui.sessionId === undefined || ui.busy;
  const help = ui.voiceMode.stt ? " 음성 입력 버튼을 누르고 말한 뒤 다시 누르세요." :
    !browserStt.supported ? " 이 브라우저는 음성 인식을 지원하지 않아 텍스트 입력만 사용할 수 있습니다." : "";
  return <section aria-labelledby="conv-title" className="panel conversation">
    <h2 id="conv-title">대화</h2>
    <div className="conversation-control">
      <button type="button" className="primary big" id="conv-start" hidden={!off} disabled={ui.sessionId === undefined || ui.consent !== "granted"} onClick={() => void startConversation()}>대화 시작 (Enter)</button>
      <button type="button" className="big" id="conv-end" hidden={off} onClick={() => endConversation()}>대화 끝내기</button>
      <p className={`phase phase-${ui.phase}`} aria-live="polite" id="phase">음성 대화: {PHASE_LABELS[ui.phase]}</p>
      <label className="mic-select" id="mic-wrap" hidden={ui.mics.length <= 1}>마이크 선택
        <select id="mic-select" value={ui.micId ?? ""} onChange={e => selectMic(e.currentTarget.value)}>
          {ui.mics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </label>
      <label className="mic-select">대화 언어 Language
        <select id="lang-select" value={ui.lang} onChange={e => void selectLanguage(LangSchema.parse(e.currentTarget.value))}>
          {LANGS.map(lang => <option key={lang} value={lang}>{LANG_NAMES[lang]}</option>)}
        </select>
      </label>
      <p className="hint" id="conv-hint" hidden={off}>띵 소리 뒤에 말씀하세요. 스페이스 키나 박수 두 번: 안내 중이면 끊고 바로 말하기, 말하는 중이면 바로 보내기.</p>
    </div>
    <div role="log" aria-live="polite" aria-relevant="additions" aria-label="대화 기록">
      <ol className="log" id="log">{ui.messages.map(m => <li key={m.id} data-id={m.id} className={`msg ${m.role}`}><span className="who">{m.role === "user" ? "나" : m.role === "assistant" ? "청음" : "안내"}: </span>{m.text}</li>)}</ol>
    </div>
    <p className="error" role="alert" id="error" hidden={(ui.error?.length ?? 0) === 0}>{ui.error}</p>
    <form className="command-form" id="command-form" onSubmit={e => { e.preventDefault(); if (input.current !== null) void send(input.current.value); }}>
      <label htmlFor="command">명령 입력 (말하듯이 입력하세요)</label>
      <div className="row">
        <input ref={input} id="command" autoComplete="off" aria-describedby="command-help" disabled={ui.sessionId === undefined}/>
        <button type="submit" id="send" disabled={waits}>{ui.busy ? "처리 중…" : "보내기"}</button>
        <button type="button" id="mic-btn" aria-pressed={ui.listening} hidden={!off} disabled={ui.sessionId === undefined || (ui.busy && !ui.listening) || (!ui.voiceMode.stt && !browserStt.supported)} onClick={() => void toggleMic()}>{ui.listening ? "말하기 끝 (보내기)" : "음성 입력"}</button>
        <button type="button" id="talk-btn" hidden={off} disabled={ui.phase === "starting" || ui.phase === "thinking"} onClick={talkNow}>{ui.phase === "speaking" ? "지금 말하기 (안내 끊기)" : ui.phase === "hearing" ? "말 끝 (바로 보내기)" : "듣는 중 — 말씀하세요"}</button>
      </div>
      <p id="command-help" className="hint">비밀번호·주민등록번호·계좌번호는 말하거나 입력하지 마세요. {voiceHelp(ui.voiceMode)}({ui.voiceMode.label}).{help}</p>
    </form>
    <details><summary>예시 명령</summary><ul className="examples" id="examples">{EXAMPLES.map(ex => <li key={ex}><button type="button" disabled={waits} onClick={() => void send(ex)}>{ex}</button></li>)}</ul></details>
  </section>;
}

function StatusPanels({ui}: {ui: UiState}) {
  const {last, state} = ui;
  const obs = last?.observation;
  const fields = obs?.fields.filter(f => f.visible && f.type !== "checkbox") ?? [];
  const approval = state === "WAITING_FOR_USER_CONFIRMATION" ? last?.pendingConfirmation : undefined;
  const receipt = state === "MOCK_SUBMITTED" ? last?.verification?.receipt : undefined;
  return <aside className="side">
    <section className="panel" aria-labelledby="status-title">
      <h2 id="status-title">현재 상태</h2>
      <dl className="status">
        <dt>상태</dt><dd id="st-state">{STATE_LABELS_KO[state]}</dd>
        <dt>단계</dt><dd id="st-step">{obs?.step === undefined ? "없음" : `${obs.step.index}/${obs.step.total} — ${obs.step.name}`}</dd>
        <dt>화면</dt><dd id="st-title">{obs?.title ?? "아직 열지 않음"}</dd>
        <dt>접근</dt><dd id="st-access">{last?.accessMode === "full" ? "지원 사이트(연습 신청 가능)" : last?.accessMode === "read-only" ? "읽기 전용(읽기·이동·검색만)" : "없음"}</dd>
      </dl>
      <div id="fields-wrap" hidden={fields.length === 0}><h3>현재 화면 입력 항목</h3>
        <ul className="fields" id="fields">{fields.map(f => <li key={f.fieldId}>{f.label} {f.required ? "(필수)" : ""} — {f.sensitive ? "직접 입력 항목" : f.filled ? `입력됨: ${f.value ?? ""}` : "비어 있음"}{f.invalid ? " · 오류" : ""}</li>)}</ul>
      </div>
    </section>
    <section aria-labelledby="confirm-title" className="panel confirm" id="confirm-panel" hidden={approval === undefined}>
      <h2 id="confirm-title" tabIndex={-1}>안전 확인: 실행 전에 승인이 필요합니다</h2>
      <p>목적: <span id="confirm-purpose">{approval?.purpose}</span><br/>대상 사이트: <span id="confirm-site">{approval?.site}</span></p>
      <dl className="status" id="confirm-values">{approval?.values.map((v,i) => <Fragment key={v.label + i}><dt>{v.label}</dt><dd>{v.value}</dd></Fragment>)}</dl>
      <p className="hint">실제 제출 아님. 승인하면 모의 접수번호만 만들어집니다.</p>
      <div className="row">
        <button type="button" className="primary" id="confirm-yes" disabled={ui.busy} onClick={() => void confirm(true)}>모의접수 승인</button>
        <button type="button" id="confirm-edit" onClick={() => document.getElementById("command")?.focus()}>수정하기</button>
        <button type="button" id="confirm-no" disabled={ui.busy} onClick={() => void confirm(false)}>거절</button>
      </div>
    </section>
    <section aria-labelledby="auth-title" className="panel auth" id="auth-panel" hidden={state !== "AUTH_HANDOFF"}>
      <h2 id="auth-title">직접 인증 필요</h2><p>브라우저 창의 가상 인증 화면에 키보드로 직접 입력하세요. 청음은 비밀번호를 듣거나 입력하지 않습니다.</p>
    </section>
    <section aria-labelledby="result-title" className="panel result" id="result-panel" hidden={(receipt?.length ?? 0) === 0}>
      <h2 id="result-title">모의접수 결과</h2><p>모의 접수번호: <strong id="receipt">{receipt}</strong></p>
      <p>실제 복지로 접수가 아니며 어떤 기관에도 전송되지 않았습니다.</p>
    </section>
    <section aria-labelledby="src-title" className="panel" id="sources-panel" hidden={(last?.sources.length ?? 0) === 0}>
      <h2 id="src-title">근거 자료</h2><ul id="sources">{last?.sources.map((s,i) => <li key={s.url+i}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> (확인일 {s.lastCheckedAt}{(s.note?.length ?? 0) > 0 ? ", "+s.note : ""})</li>)}</ul>
    </section>
    <section aria-labelledby="act-title" className="panel" id="actions-panel" hidden={(last?.actions.length ?? 0) === 0}>
      <h2 id="act-title">실행 내역</h2><ol className="actions" id="actions">{last?.actions.map(a => <li key={a.action.id}>{a.action.reason} — {a.policy.allowed ? (a.result?.ok === true ? "성공" : `실패(${a.result?.errorCode ?? "미실행"})`) : `차단: ${a.policy.reason}`}</li>)}</ol>
    </section>
    <section aria-labelledby="unsupported-title" className="panel muted"><h2 id="unsupported-title">데모/미지원</h2>
      <ul id="unsupported">{UNSUPPORTED.map(x => <li key={x}>{x}</li>)}</ul>
    </section>
  </aside>;
}
export function App() {
  const ui = useSyncExternalStore(subscribe, snapshot);
  useLayoutEffect(() => {
    if (ui.focus !== undefined) document.getElementById(ui.focus.id)?.focus();
  }, [ui.focus]);
  return <div id="app" className={ui.contrast ? "app high-contrast" : "app"}>
    <a className="skip-link" href="#command">명령 입력으로 바로가기</a>
    <div className="mock-banner" role="note">데모 · 모의 신청 전용 — 실제 복지로 접수가 아닙니다. 합성 데이터만 사용하세요.</div>
    <Toolbar ui={ui}/><div className="sr-only" aria-live="assertive" id="announce">{ui.announcement}</div>
    <ConsentPanel ui={ui}/><main id="main" className="layout"><ConversationPanel ui={ui}/><StatusPanels ui={ui}/></main>
  </div>;
}
