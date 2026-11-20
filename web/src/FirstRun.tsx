import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { FirstRun, FirstRunChoice } from "./first-run.ts";

function ChoiceButton({ choice }: { choice: FirstRunChoice }) {
  return <button type="button" className="first-run-choice" onClick={choice.act}><kbd>{choice.kbd}</kbd> {choice.label}</button>;
}

/** 첫 실행 설정 대화 상자. 단계와 키는 first-run.ts가 정하고 여기서는 그리기만 한다. */
export function FirstRunDialog({ machine }: { machine: FirstRun }) {
  const view = useSyncExternalStore(machine.subscribe, machine.snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const section = useRef<HTMLElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const guardianName = useRef<HTMLInputElement>(null);
  const guardianPhone = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (el === null) return;
    if (view.open && !el.open) el.showModal();
    else if (!view.open && el.open) el.close();
  }, [view.open]);

  useEffect(() => {
    // 초점이 대화 상자 밖(body)에 있어도 키를 받는다(창을 다시 누르거나 그림을 다시 그리면 초점이 빠질 수 있다)
    const onKey = (e: KeyboardEvent) => {
      if (dialog.current?.open !== true) return;
      if (machine.key(e.key, e.target instanceof HTMLInputElement)) e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [machine]);

  useLayoutEffect(() => {
    if (view.step === null) return;
    const target = view.focus.target === "key" ? keyInput.current
      : view.focus.target === "guardian-name" ? guardianName.current
      : section.current?.querySelector("h2");
    target?.focus();
  }, [view.focus, view.step]);

  return <dialog id="first-run" aria-labelledby="first-run-title" ref={dialog} lang={view.dialogLang} onCancel={e => e.preventDefault()}>
    <p className="first-run-brand" id="first-run-title">청음 처음 설정</p>
    <div id="first-run-steps">
      {view.step !== null && <section className="first-run-step" data-step={view.step} key={view.shown} ref={section}>
        <h2 tabIndex={-1}>{view.title}</h2>
        <p className="first-run-text">{view.text}</p>
        {view.keyForm !== undefined && <>
          <form className="first-run-form" onSubmit={e => { e.preventDefault(); void machine.submitKey(keyInput.current?.value ?? ""); }}>
            <input id="first-run-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} aria-label={view.keyForm.label} ref={keyInput}/>
            <button type="submit" className="primary">{view.keyForm.next}</button>
          </form>
          {view.keyForm.help !== undefined && <p className="hint">
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">{view.keyForm.help.link}</a> · {view.keyForm.help.limit}
          </p>}
        </>}
        {view.choices.length > 0 && <div className="first-run-choices">{view.choices.map(c => <ChoiceButton key={c.kbd} choice={c}/>)}</div>}
        {view.ready !== undefined && <div className="first-run-choices"><ChoiceButton choice={view.ready}/></div>}
        {view.guardian !== undefined && <div className="first-run-choices">
          <form className="first-run-form first-run-guardian" onSubmit={e => {
            e.preventDefault();
            void machine.submitGuardian(guardianName.current?.value ?? "", guardianPhone.current?.value ?? "");
          }}>
            <label>{view.guardian.name}<input id="first-run-guardian-name" autoComplete="off" maxLength={20} aria-label={view.guardian.name} ref={guardianName}/></label>
            <label>{view.guardian.phone}<input id="first-run-guardian-phone" type="tel" autoComplete="off" maxLength={16} aria-label={view.guardian.phone} ref={guardianPhone}/></label>
            <button type="submit" className="primary">{view.guardian.save}</button>
          </form>
          <button type="button" onClick={machine.skipGuardian}>{view.guardian.skip}</button>
        </div>}
        {view.speed !== undefined && <p className="first-run-speed">{view.speed}</p>}
        {view.back !== undefined && <button type="button" className="first-run-back" onClick={machine.back}>{view.back}</button>}
        {view.soundHelp !== undefined && <p className="hint first-run-sound-help">{view.soundHelp}</p>}
      </section>}
    </div>
    <p className="sr-only" id="first-run-live" aria-live="polite"><span key={view.live.seq}>{view.live.text}</span></p>
  </dialog>;
}
