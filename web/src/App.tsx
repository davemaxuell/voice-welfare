import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type FormEvent } from "react";
import { LangSchema } from "../../src/core/turn.ts";
import {
  answerConsent, answerRecovery, authChoice, checkMic, chooseSession, choose, commandInput, endConversation, endSession, firstRun,
  focusCommand, hearConsent, openSettings, selectLanguage, selectMic, send, setConversationMode, skipIntro, snapshot, soundCheck, speakConsent,
  stageStarter, startConversation, stopAll, stopSpeaking, submitCommand, subscribe, talkNow, toggleContrast, toggleMic, toggleTts,
  type Snapshot,
} from "./conversation.ts";
import { FirstRunDialog } from "./FirstRun.tsx";
import { onboardingText } from "./onboarding.ts";
import { RecordingReview } from "./recording-review.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { EXAMPLES, UNSUPPORTED, viewOf, type Env, type LogEntry, type WorkspaceView } from "./view.ts";
import { WorkflowPanel } from "./workflows.tsx";
import { workspaceText } from "./workspace-language.ts";

const env: Env = { background: new URLSearchParams(location.search).get("background") === "1", mac: /Mac/.test(navigator.platform) };
// 정지 그림이 따로 없는 동작은 가까운 그림으로
const INTRO_STILL: Readonly<Partial<Record<string, string>>> = { welcome: "ready" };
const LANG_OPTIONS = [["ko", "한국어"], ["en", "English"], ["zh", "中文"], ["ja", "日本語"]] as const;

function isDisabled(el: Element) {
  return (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && el.disabled;
}

/** 배치가 바뀐 요소를 바뀌기 전 자리(from: 화면 위쪽 좌표)에서 새 자리로 미끄러지게 한다. */
let springTiming: { duration: number; easing: string } | null | undefined;
function glide(el: HTMLElement, from: number | undefined) {
  if (from === undefined || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const dy = from - el.getBoundingClientRect().top;
  if (Math.abs(dy) < 2) return;
  springTiming ??= (() => {
    const match = /^([\d.]+)ms\s+(.+)$/s.exec(getComputedStyle(document.documentElement).getPropertyValue("--spring").trim());
    return match?.[1] !== undefined && match[2] !== undefined ? { duration: Number(match[1]), easing: match[2] } : null;
  })();
  if (springTiming === null) return;
  el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], springTiming);
}

function Kbd({ label }: { label: string }) {
  const [text, shortcut] = label.split(/([（(](?:Enter|Esc)[）)])/u);
  return <>{text}<kbd>{shortcut}</kbd></>;
}

function Header({ view, t }: { view: WorkspaceView; t: (s: string) => string }) {
  return <header className="app-header">
    <div className="header-inner">
      <h1 className="brand"><span className="brand-mark" aria-hidden="true"><span className="brand-eq"><i></i><i></i><i></i></span></span>{t("청음")}<span className="brand-description">{t("공공서비스 음성 도우미")}</span></h1>
      <div className="mode-note" id="practice-banner" role="note" hidden={!view.practiceBanner}>
        <strong><span className="mode-dot" aria-hidden="true"></span>{t("연습 모드")}</strong>
        <span className="mode-detail">{t("모의 신청에는 예시 정보만 사용해 주세요. 실제 접수는 이루어지지 않아요.")}</span>
      </div>
      <div className="toolbar" role="group" aria-label={t("도구")}>
        <button type="button" className="header-button" id="open-settings" hidden={!view.openSettings} onClick={() => void openSettings()}>{t("이용 설정")}</button>
        <button type="button" className="header-button contrast-button" id="contrast-toggle" title={t("고대비 전환")} aria-pressed={view.contrast.pressed} onClick={toggleContrast}>{view.contrast.label}</button>
        <button type="button" className="header-button stop" id="stop-all" onClick={() => void stopAll()}>{t("멈춰")}<span className="sr-only"> {t("(모든 동작 중단)")}</span></button>
        <button type="button" className="header-button end" id="session-end" aria-label={t("이용 종료")} title={t("이용 종료")} disabled={view.sessionEndDisabled} onClick={() => void endSession()}>{t("이용 종료")}</button>
      </div>
    </div>
  </header>;
}

function ConsentPanel({ view, detailsOpen }: { view: WorkspaceView; detailsOpen: number }) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (detailsOpen > 0 && details.current !== null) details.current.open = true; }, [detailsOpen]);
  const consent = view.consent;
  const o = (key: string, original: string) => onboardingText(view.lang, key, original);
  return <section className="hero" id="consent-panel" aria-labelledby="consent-title" hidden={consent === undefined} lang={consent === undefined ? undefined : view.lang}>
    <div className="hero-content">
      <h2 id="consent-title" data-onboarding="welcome">{o("welcome", "반가워요, 청음이에요.")}</h2>
      <p className="hero-lead" data-onboarding="lead">{o("lead", "민원, 장학금, 복지 정보를 찾아보고 신청 화면을 함께 읽어드려요.")}</p>
      <div className="row hero-buttons">
        <button type="button" className="primary" id="consent-hear" data-onboarding="hear" aria-label={`${o("hear", "안내 듣고 시작하기")} (Enter)`} hidden={consent?.hear !== true} disabled={consent?.hearDisabled !== false} onClick={() => void hearConsent()}><Kbd label={`${o("hear", "안내 듣고 시작하기")} (Enter)`}/></button>
        <button type="button" className="primary" id="consent-yes" data-onboarding="yes" aria-label={`${o("yes", "동의하고 시작")} (Enter)`} hidden={consent?.ask !== true} onClick={() => void answerConsent(true)}><Kbd label={`${o("yes", "동의하고 시작")} (Enter)`}/></button>
        <button type="button" id="consent-no" data-onboarding="no" aria-label={`${o("no", "동의하지 않음")} (Esc)`} hidden={consent?.ask !== true} onClick={() => void answerConsent(false)}><Kbd label={`${o("no", "동의하지 않음")} (Esc)`}/></button>
      </div>
      <details className="consent-details" ref={details}>
        <summary data-onboarding="details">{o("details", "음성 이용 및 개인정보 안내 전문")}</summary>
        <p id="consent-text">{consent?.text}</p>
        <button type="button" id="consent-full" data-onboarding="replay" disabled={view.consentFullDisabled} onClick={speakConsent}>{o("replay", "안내 전문 듣기")}</button>
      </details>
    </div>
    <div className="hero-art" aria-hidden="true"><div className="ripples"><i></i><i></i><i></i></div><img src="/avatar/still.png" alt="" width={240} height={240}/></div>
  </section>;
}

function WelcomePanel({ view, t, onStarter }: { view: WorkspaceView; t: (s: string) => string; onStarter: (request: string) => void }) {
  return <section className="hero" id="welcome-panel" aria-labelledby="welcome-title" hidden={view.stage !== "ready"}>
    <div className="hero-content">
      <h2 id="welcome-title">{t("무엇을 도와드릴까요?")}</h2>
      <p className="hero-lead">{t("필요한 공공서비스나 읽고 싶은 화면을 알려주세요.")}</p>
      <div id="starter-actions" className="starter-actions" role="group" aria-label={t("요청 예시 선택")}>
        {view.starters.map(s => <button type="button" key={s.request} data-request={t(s.request)} data-consent={s.consent} hidden={s.hidden} disabled={s.disabled} onClick={() => onStarter(t(s.request))}>
          <span className={`choice-art ${s.art}`} aria-hidden="true"></span>{t(s.label)}
        </button>)}
      </div>
    </div>
    <div className="hero-art" aria-hidden="true"><div className="ripples"><i></i><i></i><i></i></div><img src="/avatar/still.png" alt="" width={240} height={240}/></div>
  </section>;
}

function Message({ m }: { m: LogEntry }) {
  const who = <span className="who">{m.who}</span>;
  return <li className={`msg ${m.role}`} data-id={m.id}>
    {m.summary !== undefined ? <details id={m.consentRecord !== undefined ? "consent-record" : undefined}>
      <summary>{who}{m.summary}</summary>
      <p>{m.text}</p>
      {m.consentRecord?.replay !== undefined && <button type="button" onClick={speakConsent}>{m.consentRecord.replay}</button>}
      {m.consentRecord?.outcomes.map((outcome, i) => <p key={i}>{outcome}</p>)}
    </details> : <>{who}{m.text}</>}
  </li>;
}

function Log({ messages, t }: { messages: LogEntry[]; t: (s: string) => string }) {
  const log = useRef<HTMLOListElement>(null);
  const count = useRef(0);
  const follow = useRef(true);
  // 새 메시지를 붙이기 전에 맨 아래를 보고 있었는지 잰다(그랬으면 붙인 뒤에도 맨 아래를 보인다).
  if (messages.length !== count.current && log.current !== null) {
    const el = log.current;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 40;
  }
  useLayoutEffect(() => {
    if (messages.length > count.current && follow.current && log.current !== null) log.current.scrollTop = log.current.scrollHeight;
    count.current = messages.length;
  }, [messages.length]);
  return <div role="log" aria-live="polite" aria-relevant="additions" aria-label={t("대화 기록")}>
    <ol className="log" id="log" tabIndex={0} aria-label={t("대화 메시지")} ref={log}>{messages.map(m => <Message key={m.id} m={m}/>)}</ol>
  </div>;
}

function Decisions({ view, ui }: { view: WorkspaceView; ui: Snapshot }) {
  const { confirm, auth } = view;
  return <>
    <div className="decision confirm" id="confirm-panel" role="region" aria-labelledby="confirm-title" hidden={confirm === undefined} data-card={view.confirmCard}>
      <h3 id="confirm-title" tabIndex={-1}>실행하기 전에 확인해 주세요</h3>
      <dl className="status"><dt>목적</dt><dd id="confirm-purpose">{confirm?.purpose}</dd><dt>대상</dt><dd id="confirm-site">{confirm?.site}</dd></dl>
      <dl className="status" id="confirm-values">{confirm?.values.map((v, i) => <div key={`${v.label}-${i}`}><dt>{v.label}</dt><dd>{v.value}</dd></div>)}</dl>
      <p className="hint" id="confirm-hint" hidden={confirm?.hint === undefined}>{confirm?.hint}</p>
      <div className="row">
        {/* 새 카드면 단추를 새로 만든다: 이전 카드에서 누르고 있던 손가락·키가 새 승인을 누르지 않게 */}
        <button type="button" className="primary" id="confirm-yes" key={`yes-${view.confirmCard}`} disabled={view.decisionDisabled} onClick={() => void choose(view.confirmCard, "approve")}>{confirm?.approveLabel ?? "이 동작 승인"}</button>
        <button type="button" id="confirm-edit" hidden={confirm?.edit !== true} onClick={focusCommand}>수정하기</button>
        <button type="button" id="confirm-no" key={`no-${view.confirmCard}`} disabled={view.decisionDisabled} onClick={() => void choose(view.confirmCard, "reject")}>거절</button>
      </div>
    </div>
    <div className="decision auth" id="auth-panel" role="region" aria-labelledby="auth-title" hidden={auth === undefined} data-card={auth?.cardId ?? ""}>
      <h3 id="auth-title">직접 인증이 필요해요</h3>
      <p>브라우저 창에서 직접 확인을 완료해 주세요. 마이크는 꺼져 있어요.</p>
      <div className="row">
        <button type="button" className="primary" id="auth-done" key={`done-${auth?.cardId ?? ""}`} disabled={view.decisionDisabled} onClick={() => { if (auth !== undefined) void authChoice(auth.cardId, "auth-done", auth.viaCard); }}>{auth?.doneLabel ?? "직접 확인을 마쳤어요"}</button>
        <button type="button" id="auth-cancel" key={`cancel-${auth?.cardId ?? ""}`} disabled={view.decisionDisabled} onClick={() => { if (auth !== undefined) void authChoice(auth.cardId, "auth-cancel", auth.viaCard); }}>인증 취소</button>
      </div>
    </div>
    <div className="decision result" id="result-panel" role="region" aria-labelledby="result-title" hidden={view.receipt === undefined}>
      <h3 id="result-title">모의접수 결과</h3>
      <p>모의 접수번호 <strong id="receipt">{view.receipt}</strong></p>
      <p>실제 접수가 아니며 어떤 기관에도 전송되지 않았어요.</p>
    </div>
    <p className="error" role="alert" id="error" hidden={view.error === undefined}><span key={ui.errorSeq}>{view.error}</span></p>
    <div className="typing" id="typing" aria-hidden="true" hidden={!view.command.typing}><span className="typing-avatar"></span><span className="typing-dots"><i></i><i></i><i></i></span></div>
  </>;
}

function AnswerPanel({ view }: { view: WorkspaceView }) {
  const a = view.answer;
  return <section aria-labelledby="answer-title" className="answer" id="answer-panel" hidden={a === undefined}>
    <h3 id="answer-title">복지 제도 답변</h3>
    <dl className="status">
      <dt>출처</dt><dd><a id="answer-source" target="_blank" rel="noreferrer" href={a?.source.url}>{a?.source.title}</a></dd>
      <dt>다음 행동</dt><dd id="answer-next" lang={a?.lang}>{a?.next}</dd>
    </dl>
    <details className="answer-details"><summary>답변과 자료 기준 보기</summary>
      <p id="answer-text" lang={a?.lang}>{a?.text}</p>
      <dl className="status">
        <dt>자료 구분</dt><dd id="answer-origin">{a?.origin}</dd>
        <dt>자료 기준</dt><dd id="answer-date">{a?.date}</dd>
        <dt>확인일</dt><dd id="answer-checked">{a?.checked}</dd>
      </dl>
    </details>
  </section>;
}

function CommandForm({ view, ui, t }: { view: WorkspaceView; ui: Snapshot; t: (s: string) => string }) {
  const input = useRef<HTMLInputElement>(null);
  const { command: c, conversation: conv } = view;
  useEffect(() => { if (ui.commandReset > 0 && input.current !== null) input.current.value = ""; }, [ui.commandReset]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const el = input.current;
    if (el !== null && submitCommand(el.value)) el.value = "";
  };
  return <form className="command-form" id="command-form" onSubmit={submit}>
    <label className="sr-only" htmlFor="command">{t("명령 입력 (말하듯이 입력하세요)")}</label>
    <div className="composer">
      <input id="command" ref={input} placeholder={t("청음에게 물어보세요")} autoComplete="off" aria-describedby="command-help" disabled={c.disabled} onInput={e => commandInput(e.currentTarget.value)}/>
      <button type="submit" className="primary send" id="send" title={t("보내기")} disabled={c.sendDisabled} aria-busy={c.busy}>{c.sendLabel}</button>
    </div>
    <div className="voice-actions">
      <button type="button" className="voice-start" id="conv-start" aria-label={t("대화 시작 (Enter)")} hidden={!conv.startShown} disabled={conv.startDisabled} onClick={() => void startConversation()}><Kbd label={t("대화 시작 (Enter)")}/></button>
      <button type="button" id="conv-end" hidden={!conv.endShown} onClick={() => endConversation()}>{t("대화 끝내기")}</button>
      <button type="button" id="mic-btn" aria-pressed={c.micPressed} aria-describedby="command-help" hidden={!c.micShown} disabled={c.micDisabled} onClick={() => void toggleMic()}>{c.micLabel}</button>
      <button type="button" id="talk-btn" hidden={!c.talkShown} disabled={c.talkDisabled} onClick={talkNow}>{c.talkLabel}</button>
    </div>
    <p className="hint" id="dictation-hint" hidden={c.dictation === undefined}>{c.dictation}</p>
    <p className="hint" id="conv-hint" hidden={conv.hint === undefined}>{conv.hint}</p>
    <p id="command-help" className="hint">{c.help}</p>
  </form>;
}

export function StatusPanel({ view, t }: { view: WorkspaceView; t: (s: string) => string }) {
  const s = view.status;
  const progress = useRef<HTMLProgressElement>(null);
  useEffect(() => { if (s.progress !== undefined) progress.current?.style.setProperty("--p", String(s.progress.ratio)); }, [s.progress?.ratio]);
  return <section aria-labelledby="status-title" className="panel">
    <h2 id="status-title"><span className="panel-icon status-icon" aria-hidden="true"></span>{t("현재 작업")}</h2>
    <progress id="step-progress" aria-label="신청 진행률" hidden={s.progress === undefined} max={s.progress?.max} value={s.progress?.value} ref={progress}></progress>
    <dl className="status work-status">
      <div className="st-activity-row" hidden={s.activity == null || s.activity.length === 0}><dt>{t("지금")}</dt><dd id="st-activity" aria-live="polite">{s.activity}</dd></div>
      <div className="st-state-row"><dt>{t("진행 상태")}</dt><dd><span id="st-state" data-state={s.state}>{s.stateLabel}</span></dd></div>
      <div className="st-step-row" hidden={s.step === undefined}><dt>{t("신청 단계")}</dt><dd id="st-step">{s.step ?? "없음"}</dd></div>
      <div className="st-title-row" hidden={s.title === undefined}><dt>{t("현재 화면")}</dt><dd id="st-title">{s.title ?? "아직 열지 않음"}</dd></div>
      <div className="st-access-row" hidden={s.access === undefined}><dt>{t("접근 권한")}</dt><dd id="st-access" data-mode={s.accessMode}>{s.access ?? "없음"}</dd></div>
    </dl>
    <div id="fields-wrap" hidden={s.fields.length === 0}><h3>현재 화면 입력 항목</h3><ul className="fields" id="fields">
      {s.fields.map(f => <li key={f.key} data-state={f.state}>
        <span className="field-name">{f.name}</span><span className="words">{f.between}</span><span className="field-value">{f.value}</span><span className="words">{f.after}</span>
      </li>)}
    </ul></div>
  </section>;
}

function SoundPanel({ view, ui, t }: { view: WorkspaceView; ui: Snapshot; t: (s: string) => string }) {
  const mode = view.modeChoice;
  return <section className="panel settings" aria-labelledby="sound-title">
    <h2 id="sound-title"><span className="panel-icon audio-icon" aria-hidden="true"></span>{t("음성 설정")}</h2>
    <div className="setting-row">
      <label htmlFor="lang-select">{t("대화 언어")}</label>
      <select id="lang-select" value={ui.requestedLanguage ?? view.lang} onChange={e => {
        const lang = LangSchema.safeParse(e.currentTarget.value);
        if (lang.success) void selectLanguage(lang.data);
      }}>{LANG_OPTIONS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
    </div>
    <label className="setting-row" id="mic-wrap" hidden={view.mics === undefined}>{t("마이크 선택")}<select id="mic-select" value={view.micId} onChange={e => selectMic(e.currentTarget.value)}>
      {(view.mics ?? ui.mics).map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
    </select></label>
    <label className="setting-row" id="conversation-mode-wrap" hidden={mode === undefined}><span id="conversation-mode-label">{mode?.label ?? t("대화 방식")}</span>
      <select id="conversation-mode" value={ui.conversationMode} onChange={e => setConversationMode(e.currentTarget.value === "dictate" ? "dictate" : "native")}>
        <option value="native">{mode?.native ?? t("실시간 음성 대화")}</option><option value="dictate">{mode?.dictate ?? t("받아쓰기 후 답변")}</option>
      </select>
    </label>
    <button type="button" className="voice-switch" id="tts-toggle" aria-pressed={view.tts.pressed} disabled={view.tts.disabled} onClick={toggleTts}>{view.tts.label}</button>
    <div className="audio-tools">
      <button type="button" id="mic-check" disabled={view.micCheckDisabled} onClick={() => void checkMic()}>{t("마이크 확인")}</button>
      <button type="button" id="sound-check" disabled={view.soundCheckDisabled} onClick={soundCheck}>{t("소리 확인")}</button>
      <button type="button" id="stop-speaking" onClick={stopSpeaking}>{t("말하기 중지")}</button>
    </div>
    <p id="mic-check-result" className="hint" role="status">{view.micCheckResult}</p>
    <details className="secondary-details"><summary>{t("음성 처리 방식")}</summary><p id="voice-details">{view.voiceDetails}</p></details>
  </section>;
}

/** 대화 영역을 맨 아래에서 보고 있으면 새 메시지·카드가 붙어도 계속 맨 아래를 보여 준다. */
function useFollowThread() {
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = thread.current;
    if (el === null) return;
    let pinned = true;
    const onScroll = () => { pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= 48; };
    el.addEventListener("scroll", onScroll, { passive: true });
    const keep = new ResizeObserver(() => { if (pinned) el.scrollTop = el.scrollHeight; });
    for (const child of el.children) keep.observe(child);
    return () => { el.removeEventListener("scroll", onScroll); keep.disconnect(); };
  }, []);
  return thread;
}

export function App() {
  const ui = useSyncExternalStore(subscribe, snapshot);
  const view = viewOf(ui, env);
  const lang = view.lang;
  const t = (s: string) => workspaceText(s, lang);
  const thread = useFollowThread();
  const layout = useRef<HTMLDivElement>(null);
  const layoutTop = useRef<number | undefined>(undefined);
  const stage = useRef<string | undefined>(undefined);

  useLayoutEffect(() => {
    if (ui.focus === undefined) return;
    const { id, fallback, scroll } = ui.focus;
    const el = document.getElementById(id);
    const usable = el instanceof HTMLElement && el.hidden === false && !isDisabled(el);
    if (fallback !== undefined && !usable) document.getElementById(fallback)?.focus();
    else el?.focus();
    if (scroll !== undefined) document.getElementById(scroll)?.scrollIntoView({ block: "end" });
  }, [ui.focus]);

  useLayoutEffect(() => {
    const el = layout.current;
    if (el === null) return;
    if (stage.current !== view.stage) {
      if (stage.current !== undefined) glide(el, layoutTop.current);
      stage.current = view.stage;
    }
    layoutTop.current = el.getBoundingClientRect().top;
  });

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = workspaceText("청음 — 공공서비스 음성 도우미", lang);
  }, [lang]);

  const onStarter = (request: string) => {
    const command = document.getElementById("command");
    if (!(command instanceof HTMLInputElement)) return;
    command.value = request;
    stageStarter();
    command.focus();
    command.setSelectionRange(command.value.length, command.value.length);
  };

  return <div id="app" className={view.appClass} data-stage={view.stage}>
    <a className="skip-link" href="#command">{t("명령 입력으로 바로가기")}</a>
    <Header view={view} t={t}/>
    <div className="sr-only" aria-live="assertive" id="announce"><span key={ui.announcement.seq}>{ui.announcement.text}</span></div>
    <SettingsDialog dialog={ui.settings} continuing={ui.sessionId !== undefined}/>
    <FirstRunDialog machine={firstRun}/>
    <section id="intro-card" className="intro-card" aria-label="청음 소개" hidden={view.intro === undefined}>
      <img id="intro-pose" alt="" width={120} height={133} src={view.intro === undefined ? undefined : `/avatar/poses/${INTRO_STILL[view.intro.pose] ?? view.intro.pose}.webp`}/>
      <p id="intro-text" aria-live="polite">{view.intro?.text}</p>
      <button type="button" id="intro-skip" onClick={() => skipIntro()}>건너뛰기 <kbd>Esc</kbd></button>
    </section>
    <main id="main" className="workspace">
      <ConsentPanel view={view} detailsOpen={ui.consentDetailsOpen}/>
      <WelcomePanel view={view} t={t} onStarter={onStarter}/>
      <section className="panel recovery" id="recovery-panel" aria-labelledby="recovery-title" hidden={view.recovery === undefined}>
        <h2 id="recovery-title" tabIndex={-1}>{view.recovery?.title}</h2>
        <p id="recovery-message">{view.recovery?.message}</p>
        <div className="row">
          <button type="button" className="primary" id="recovery-yes" aria-describedby="recovery-message" disabled={view.recovery?.busy === true} onClick={() => void answerRecovery(true)}>{view.recovery?.yes}</button>
          <button type="button" id="recovery-no" onClick={() => void answerRecovery(false)}>{view.recovery?.no}</button>
        </div>
      </section>
      <button type="button" className="primary" id="session-new" hidden={!view.sessionNew} onClick={() => void chooseSession()}>{t("새 작업 시작")}</button>

      <div className="layout" ref={layout}>
        <div className="primary-column">
          <section aria-labelledby="conv-title" className="panel conversation">
            <div className="conversation-header">
              <h2 id="conv-title"><span className="portrait" aria-hidden="true"></span>{t("청음과의 대화")}</h2>
              <p className={`phase phase-${view.conversation.phase}`} aria-live="polite" id="phase"><span className="phase-eq" aria-hidden="true"><i></i><i></i><i></i></span><span id="phase-label">{view.conversation.phaseLabel}</span></p>
              <p id="live-caption" hidden={view.conversation.caption.length === 0}>{view.conversation.caption}</p>
            </div>
            <div className="thread" id="thread" ref={thread}>
              <Log messages={ui.messages} t={t}/>
              <AnswerPanel view={view}/>
              <Decisions view={view} ui={ui}/>
            </div>
            <CommandForm view={view} ui={ui} t={t}/>
            <details className="examples-disclosure"><summary>{t("예시 명령 보기")}</summary><ul className="examples" id="examples">
              {EXAMPLES.map(ex => <li key={ex}><button type="button" disabled={view.command.examplesDisabled} onClick={() => void send(t(ex))}>{t(ex)}</button></li>)}
            </ul></details>
            <RecordingReview owner={view.recordingOwner} lang={lang}/>
          </section>
        </div>

        <aside className="side" aria-label="작업 정보와 설정">
          <StatusPanel view={view} t={t}/>
          <section aria-labelledby="src-title" className="panel" id="sources-panel" hidden={view.sources.length === 0}>
            <h2 id="src-title">근거 자료</h2><ul id="sources">{view.sources.map((s, i) => <li key={`${s.url}-${i}`}>
              <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>{` (확인일 ${s.lastCheckedAt}${s.note !== undefined && s.note.length > 0 ? `, ${s.note}` : ""})`}
            </li>)}</ul>
          </section>
          <section aria-labelledby="act-title" className="panel" id="actions-panel" hidden={view.actions.length === 0}>
            <h2 id="act-title">실행 내역</h2><ol className="actions" id="actions">{view.actions.map(a => <li key={a.key} data-result={a.state}>
              <span className="action-reason">{a.reason}</span><span className="words"> — </span><span className={a.resultIsWords ? "words" : "action-result"}>{a.result}</span>
            </li>)}</ol>
          </section>
          <SoundPanel view={view} ui={ui} t={t}/>
          <WorkflowPanel sessionId={view.workspaceOwner} lang={lang}/>
          <details className="support-details">
            <summary id="unsupported-title">지원하지 않는 기능</summary><ul id="unsupported">{UNSUPPORTED.map(u => <li key={u}>{u}</li>)}</ul>
          </details>
        </aside>
      </div>
    </main>
  </div>;
}
