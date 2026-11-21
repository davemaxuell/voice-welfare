import type { Lang } from "../../src/core/turn.ts";
// 자료 조사와 저장한 메모(개인 PC). 패널을 연 동안만 3.5초마다 다시 읽는다.
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { api, errorCode, WorkspaceSchema, type Note, type Workspace } from "./api.ts";
import { copy, resultCopy, states } from "./workflows-text.ts";

const LANG_ORDER = ["ko", "en", "zh", "ja"];
const SearchSchema = z.object({ notes: z.array(z.object({ id: z.string(), body: z.string() })) });

export function WorkflowPanel({ sessionId, lang, onRead }: { sessionId: string | undefined; lang: Lang; onRead: (text: string) => void }) {
  const t = (index: number) => copy[lang][index] ?? "";
  const [snapshot, setSnapshot] = useState<Workspace | undefined>(undefined);
  const [filter, setFilter] = useState<Note[] | undefined>(undefined);
  const [feedback, setFeedback] = useState("");
  const panel = useRef<HTMLDetailsElement>(null);
  const researchForm = useRef<HTMLFormElement>(null);
  const researchInput = useRef<HTMLTextAreaElement>(null);
  const researchConsent = useRef<HTMLInputElement>(null);
  const noteForm = useRef<HTMLFormElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const noteConsent = useRef<HTMLInputElement>(null);
  const live = useRef({ current: undefined as string | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined, readVersion: 0, mutation: false, shown: "" });

  useEffect(() => {
    const s = live.current;
    if (s.current === sessionId) return;
    clearTimeout(s.timer);
    s.readVersion++;
    s.shown = "";
    setSnapshot(undefined);
    setFilter(undefined);
    setFeedback("");
    if (panel.current !== null) panel.current.open = false;
    researchForm.current?.reset();
    noteForm.current?.reset();
    s.current = sessionId;
  }, [sessionId]);
  useEffect(() => () => clearTimeout(live.current.timer), []);

  async function refresh() {
    const s = live.current;
    clearTimeout(s.timer);
    if (s.current === undefined || panel.current?.open !== true) return;
    const id = s.current, version = ++s.readVersion;
    try {
      const data = WorkspaceSchema.parse(await api.workspace(id));
      if (s.current !== id || version !== s.readVersion) return;
      const text = JSON.stringify(data);
      if (s.shown !== text) {
        s.shown = text;
        setSnapshot(data);
      }
    } catch {
      if (s.current === id && version === s.readVersion) setFeedback(t(14));
    }
    if (s.current === id && version === s.readVersion && panel.current?.open === true) s.timer = setTimeout(() => void refresh(), 3500);
  }

  async function change(path: string, method: string, data?: unknown, onDone?: (result: unknown) => void) {
    const s = live.current;
    if (s.current === undefined || s.mutation) return;
    const id = s.current;
    s.mutation = true;
    try {
      const result = await api.workspace(id, path, method, data);
      if (s.current !== id) return;
      setFilter(undefined);
      setFeedback(t(16));
      onDone?.(result);
      await refresh();
    } catch (error) {
      const code = errorCode(error);
      if (s.current === id) setFeedback(t(code === "PUBLIC_TEXT_REQUIRED" ? 12 : code === "WORKSPACE_LIMIT" ? 15 : 14));
    } finally { s.mutation = false; }
  }

  const research = (e: FormEvent) => {
    e.preventDefault();
    void change("/research", "POST", { text: researchInput.current?.value ?? "", consent: researchConsent.current?.checked === true,
      requestId: crypto.randomUUID() }, () => researchForm.current?.reset());
  };
  const saveNote = (e: FormEvent) => {
    e.preventDefault();
    if (noteConsent.current?.checked !== true) { noteConsent.current?.focus(); setFeedback(t(5)); return; }
    void change("/notes", "POST", { text: noteInput.current?.value ?? "", consent: true }, () => noteForm.current?.reset());
  };
  const searchNotes = () => {
    if (noteInput.current?.reportValidity() !== true) return;
    void change("/notes/search", "POST", { text: noteInput.current.value }, (result) => {
      const notes = SearchSchema.parse(result).notes;
      setFilter(notes);
      // 맞는 메모가 없으면 그렇다고 알린다(목록을 그린 뒤에도 남게)
      setFeedback(notes.length === 0 && snapshot !== undefined ? t(13) : "");
    });
  };
  const stateColumn = Math.max(0, LANG_ORDER.indexOf(lang));
  const label = (key: keyof typeof resultCopy) => resultCopy[key][stateColumn] ?? resultCopy[key][0];
  const matches = filter ?? snapshot?.notes ?? [];

  return <details id="workflow-panel" className="panel settings" hidden={sessionId === undefined} ref={panel} onToggle={() => void refresh()}>
    <summary id="workflow-title">{t(0)}</summary>
    <form id="research-form" ref={researchForm} onSubmit={research}>
      <label id="research-label" htmlFor="research-input">{t(1)}</label>
      <textarea id="research-input" rows={2} maxLength={600} required ref={researchInput}></textarea>
      <label><input id="research-consent" type="checkbox" required ref={researchConsent}/> <span id="research-permission">{t(2)}</span></label>
      <button id="research-add" type="submit">{t(3)}</button>
    </form>
    <ul id="research-list">{snapshot?.jobs.map(job => {
      const inProgress = job.state === "queued" || job.state === "running";
      const found = job.result?.text ?? "";
      const missing = job.result?.missing ?? [];
      const sources = (job.result?.sources ?? []).filter(source => /^https:\/\//i.test(source.url));
      const data = job.result?.data;
      return <li key={job.id}>
        <p>{job.prompt + " · " + (states[job.state]?.[stateColumn] ?? job.state)}</p>
        {found.length > 0 && <p>{found}</p>}
        {missing.length > 0 && <><p>{label("missing")}</p><ul>{missing.map((part, i) => <li key={i}>{part}</li>)}</ul></>}
        {data !== undefined && <p>{label(data.kind)} · {label("dataDate")} {data.date ?? label("unknownDate")}</p>}
        {sources.map((source, i) => <Fragment key={`${source.url}-${i}`}>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{" · "}{label("checked")} {source.lastCheckedAt ?? label("unknownDate")}{" "}
        </Fragment>)}
        {(found.length > 0 || missing.length > 0) && <button type="button" onClick={() => onRead([
          job.prompt, found, ...sources.map(source => `${source.title}. ${label("checked")} ${source.lastCheckedAt ?? label("unknownDate")}`),
          ...(missing.length > 0 ? [label("missing"), ...missing] : []),
        ].filter(Boolean).join(". "))}>{label("read")}</button>}
        {job.questionRevision !== undefined && <form key={job.questionRevision} onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const text = new FormData(form).get("text");
          void change("/research/" + job.id + "/answer", "POST", { text, consent: true, questionRevision: job.questionRevision }, () => form.reset());
        }}><label>{label("answer")} <input name="text" maxLength={600} required/></label>
          <button type="submit">{label("resume")}</button></form>}
        <button type="button" onClick={() => void change("/research/" + job.id + (inProgress ? "/claim" : ""), "DELETE")}>{t(inProgress ? 9 : 10)}</button>
        {["needs_input", "incomplete", "failed", "partial"].includes(job.state) &&
          <button type="button" onClick={() => { if (researchInput.current !== null) { researchInput.current.value = job.prompt; researchInput.current.focus(); } }}>{t(11)}</button>}
      </li>;
    })}</ul>
    <form id="note-form" ref={noteForm} onSubmit={saveNote}>
      <label id="note-label" htmlFor="note-input">{t(4)}</label>
      <textarea id="note-input" rows={2} maxLength={300} required ref={noteInput}></textarea>
      <label><input id="note-consent" type="checkbox" ref={noteConsent}/> <span id="note-permission">{t(5)}</span></label>
      <button id="note-add" type="submit">{t(6)}</button>
      <button id="note-search" type="button" onClick={searchNotes}>{t(7)}</button>
      <button id="note-all" type="button" onClick={() => { setFilter(undefined); setFeedback(""); }}>{t(8)}</button>
    </form>
    <ul id="note-list">{snapshot !== undefined && matches.map(note => <li key={note.id}>{note.body + " "}<button type="button" onClick={() => void change("/notes/" + note.id, "DELETE")}>{t(10)}</button></li>)}</ul>
    <p id="workflow-feedback" role="status">{feedback}</p>
  </details>;
}
