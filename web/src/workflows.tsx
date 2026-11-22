import type { Lang } from "../../src/core/turn.ts";
// 자료 조사와 저장한 메모(개인 PC). 패널이 열려 있으면 3.5초, 닫혀 있어도 진행 중인 조사가 있을 때만 10초마다 읽는다.
import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { api, errorCode, WorkspaceSchema, type Note, type Workspace } from "./api.ts";
import { workflowErrorText, workflowResultText, workflowStateNote, workflowStateText, workflowText } from "./workflows-text.ts";

const SearchSchema = z.object({ notes: z.array(z.object({ id: z.string(), body: z.string() })) });
const CancelSchema = z.object({ cancelled: z.boolean() });
const DeleteSchema = z.object({ deleted: z.boolean() });
const ACTIVE_STATES = new Set(["queued", "running"]);
const DONE_STATES = new Set(["completed", "partial"]);
const UNFINISHED_STATES = new Set(["failed", "incomplete"]);
const ATTENTION_STATES = new Set(["completed", "partial", "incomplete", "failed", "needs_input"]);
const OPEN_POLL_MS = 3500;
const COLLAPSED_POLL_MS = 10_000;
const LOCALE: Readonly<Record<Lang, string>> = { ko: "ko-KR", en: "en-US", zh: "zh-CN", ja: "ja-JP" };

interface UnreadSummary {
  done: number;
  needsInput: number;
  unfinished: number;
}
const EMPTY_UNREAD: UnreadSummary = { done: 0, needsInput: 0, unfinished: 0 };

function summarizeUnread(statesMap: ReadonlyMap<string, string>): UnreadSummary {
  let done = 0, needsInput = 0, unfinished = 0;
  for (const state of statesMap.values()) {
    if (DONE_STATES.has(state)) done++;
    else if (state === "needs_input") needsInput++;
    else if (UNFINISHED_STATES.has(state)) unfinished++;
  }
  return { done, needsInput, unfinished };
}

function formatTime(at: number, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(at));
}

function summarizeTitle(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/gu, " ");
  return clean.length > 40 ? clean.slice(0, 39) + "…" : clean;
}

export function WorkflowPanel({
  sessionId, lang, directActions = false, onRead, onStatus,
}: {
  sessionId: string | undefined;
  lang: Lang;
  directActions?: boolean;
  onRead: (text: string) => void;
  onStatus?: (line: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<Workspace | undefined>(undefined);
  const [timestamps, setTimestamps] = useState<Readonly<Record<string, number>>>({});
  const [filter, setFilter] = useState<Note[] | undefined>(undefined);
  const [feedback, setFeedback] = useState("");
  const [unread, setUnread] = useState<UnreadSummary>(EMPTY_UNREAD);
  const panel = useRef<HTMLDetailsElement>(null);
  const researchForm = useRef<HTMLFormElement>(null);
  const researchInput = useRef<HTMLTextAreaElement>(null);
  const researchConsent = useRef<HTMLInputElement>(null);
  const noteForm = useRef<HTMLFormElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const noteConsent = useRef<HTMLInputElement>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const live = useRef({
    current: undefined as string | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    readVersion: 0,
    mutation: false,
    shown: "",
    hasActive: false,
    refreshErrored: false,
    prevStates: new Map<string, string>(),
    updatedAt: new Map<string, { sig: string; at: number }>(),
    unreadIds: new Map<string, string>(),
  });

  useEffect(() => {
    const s = live.current;
    if (s.current === sessionId) return;
    clearTimeout(s.timer);
    s.timer = undefined;
    s.readVersion++;
    s.shown = "";
    s.hasActive = false;
    s.refreshErrored = false;
    s.prevStates.clear();
    s.updatedAt.clear();
    s.unreadIds.clear();
    setSnapshot(undefined);
    setTimestamps({});
    setFilter(undefined);
    setFeedback("");
    setUnread(EMPTY_UNREAD);
    onStatusRef.current?.("");
    if (panel.current !== null) panel.current.open = false;
    researchForm.current?.reset();
    noteForm.current?.reset();
    s.current = sessionId;
  }, [sessionId]);

  useEffect(() => () => clearTimeout(live.current.timer), []);

  useEffect(() => {
    const parts: string[] = [];
    if (unread.done > 0) parts.push(workflowText("collapsedDone", lang, { count: unread.done }));
    if (unread.needsInput > 0) parts.push(workflowText("collapsedNeedsInput", lang, { count: unread.needsInput }));
    if (unread.unfinished > 0) parts.push(workflowText("collapsedUnfinished", lang, { count: unread.unfinished }));
    onStatusRef.current?.(parts.join(" "));
  }, [unread, lang]);

  function scheduleNext(id: string, version: number) {
    const s = live.current;
    if (s.current !== id || version !== s.readVersion) return;
    clearTimeout(s.timer);
    s.timer = undefined;
    const isOpen = panel.current?.open === true;
    if (!isOpen && !s.hasActive) return;
    s.timer = setTimeout(() => void refresh(), isOpen ? OPEN_POLL_MS : COLLAPSED_POLL_MS);
  }

  async function refresh() {
    const s = live.current;
    clearTimeout(s.timer);
    s.timer = undefined;
    const isOpen = panel.current?.open === true;
    if (s.current === undefined || (!isOpen && !s.hasActive)) return;
    const id = s.current, version = ++s.readVersion;
    try {
      const data = WorkspaceSchema.parse(await api.workspace(id));
      if (s.current !== id || version !== s.readVersion) return;
      const now = Date.now();
      const currentOpen = panel.current?.open === true;
      const nextIds = new Set<string>();
      for (const job of data.jobs) {
        nextIds.add(job.id);
        const sig = JSON.stringify([job.state, job.questionRevision ?? null, job.result ?? null]);
        if (s.updatedAt.get(job.id)?.sig !== sig) s.updatedAt.set(job.id, { sig, at: now });
        const prev = s.prevStates.get(job.id);
        if (!currentOpen && ATTENTION_STATES.has(job.state) && (prev === undefined || ACTIVE_STATES.has(prev))) {
          s.unreadIds.set(job.id, job.state);
        } else if (!ATTENTION_STATES.has(job.state)) {
          s.unreadIds.delete(job.id);
        }
        s.prevStates.set(job.id, job.state);
      }
      for (const known of [...s.prevStates.keys()]) {
        if (!nextIds.has(known)) {
          s.prevStates.delete(known);
          s.updatedAt.delete(known);
          s.unreadIds.delete(known);
        }
      }
      s.hasActive = data.jobs.some(job => ACTIVE_STATES.has(job.state));
      if (currentOpen && s.unreadIds.size > 0) s.unreadIds.clear();
      const nextUnread = summarizeUnread(s.unreadIds);
      setUnread(prev =>
        prev.done === nextUnread.done && prev.needsInput === nextUnread.needsInput && prev.unfinished === nextUnread.unfinished
          ? prev
          : nextUnread,
      );
      if (s.refreshErrored) {
        s.refreshErrored = false;
        setFeedback("");
      }
      const text = JSON.stringify(data);
      if (s.shown !== text) {
        s.shown = text;
        setSnapshot(data);
        setTimestamps(Object.fromEntries([...s.updatedAt].map(([jobId, entry]) => [jobId, entry.at])));
      }
    } catch (error) {
      if (s.current === id && version === s.readVersion) {
        s.refreshErrored = true;
        setFeedback(workflowErrorText(errorCode(error), langRef.current));
      }
    }
    scheduleNext(id, version);
  }

  function handleToggle() {
    const s = live.current;
    const isOpen = panel.current?.open === true;
    if (isOpen) {
      if (s.unreadIds.size > 0) {
        s.unreadIds.clear();
        setUnread(EMPTY_UNREAD);
      }
      void refresh();
    } else if (s.current !== undefined) {
      scheduleNext(s.current, s.readVersion);
    }
  }

  async function change(
    path: string,
    method: string,
    data?: unknown,
    options?: { feedback?: string | ((result: unknown) => string); markActive?: boolean; onDone?: (result: unknown) => void },
  ) {
    const s = live.current;
    if (s.current === undefined || s.mutation) return;
    const id = s.current;
    s.mutation = true;
    try {
      const result = await api.workspace(id, path, method, data);
      if (s.current !== id) return;
      s.refreshErrored = false;
      if (options?.markActive === true) s.hasActive = true;
      setFilter(undefined);
      if (options?.feedback !== undefined) {
        setFeedback(typeof options.feedback === "function" ? options.feedback(result) : options.feedback);
      }
      options?.onDone?.(result);
      await refresh();
    } catch (error) {
      const code = errorCode(error);
      if (s.current === id) {
        s.refreshErrored = true;
        setFeedback(workflowErrorText(code, langRef.current));
      }
    } finally { s.mutation = false; }
  }

  const research = (e: FormEvent) => {
    e.preventDefault();
    const prompt = researchInput.current?.value ?? "";
    void change("/research", "POST", {
      text: prompt, consent: directActions || researchConsent.current?.checked === true, requestId: crypto.randomUUID(),
    }, {
      feedback: workflowText("submittedJob", lang, { title: summarizeTitle(prompt) }),
      markActive: true,
      onDone: () => researchForm.current?.reset(),
    });
  };
  const saveNote = (e: FormEvent) => {
    e.preventDefault();
    if (!directActions && noteConsent.current?.checked !== true) {
      noteConsent.current?.focus();
      setFeedback(workflowText("noteConsent", lang));
      return;
    }
    void change("/notes", "POST", { text: noteInput.current?.value ?? "", consent: true }, {
      feedback: workflowText("noteSaved", lang),
      onDone: () => noteForm.current?.reset(),
    });
  };
  const searchNotes = () => {
    if (noteInput.current?.reportValidity() !== true) return;
    void change("/notes/search", "POST", { text: noteInput.current.value }, {
      onDone: (result) => {
        const notes = SearchSchema.parse(result).notes;
        setFilter(notes);
        // 맞는 메모가 없으면 그렇다고 알린다(목록을 그린 뒤에도 남게)
        setFeedback(notes.length === 0 && snapshot !== undefined ? workflowText("noMatchingNotes", lang) : "");
      },
    });
  };

  const label = (key: Parameters<typeof workflowResultText>[0]) => workflowResultText(key, lang);
  const actionAria = (action: string, title: string) => workflowText("actionForItem", lang, { action, title: summarizeTitle(title) });
  const matches = filter ?? snapshot?.notes ?? [];

  const unreadTotal = unread.done + unread.needsInput + unread.unfinished;

  return <details id="workflow-panel" className="panel settings" hidden={sessionId === undefined} ref={panel} onToggle={handleToggle}>
    <summary id="workflow-title">
      {workflowText("title", lang)}
      {unreadTotal > 0 && <span id="workflow-badge" className="workflow-badge" aria-label={workflowText("unreadBadgeLabel", lang, { count: unreadTotal })}>{unreadTotal}</span>}
    </summary>
    <form id="research-form" ref={researchForm} onSubmit={research}>
      <label id="research-label" htmlFor="research-input">{workflowText("researchLabel", lang)}</label>
      <textarea id="research-input" rows={2} maxLength={600} required ref={researchInput}></textarea>
      {directActions ? <p id="research-permission">{workflowText("researchStorage", lang)}</p> :
        <label><input id="research-consent" type="checkbox" required ref={researchConsent}/> <span id="research-permission">{workflowText("researchConsent", lang)}</span></label>}
      <button id="research-add" type="submit">{workflowText("researchAdd", lang)}</button>
    </form>
    <ul id="research-list" className="research-list">{snapshot?.jobs.map(job => {
      const inProgress = ACTIVE_STATES.has(job.state);
      const found = job.result?.text ?? "";
      const missing = job.result?.missing ?? [];
      const sources = (job.result?.sources ?? []).filter(source => /^https:\/\//i.test(source.url));
      const data = job.result?.data;
      const stateText = workflowStateText(job.state, lang);
      const note = workflowStateNote(job.state, lang);
      const updated = timestamps[job.id];
      const cancelOrDelete = workflowText(inProgress ? "cancel" : "delete", lang);
      const readLabel = label("read");
      const reviseLabel = workflowText("revise", lang);
      const retryLabel = workflowText("retry", lang);
      const resumeLabel = label("resume");
      return <li key={job.id} className="research-item" data-state={job.state}>
        <div className="research-head">
          <span className="research-state">{stateText}</span>
          {updated !== undefined && <time className="research-updated" dateTime={new Date(updated).toISOString()}>
            {workflowText("updatedAt", lang, { time: formatTime(updated, lang) })}
          </time>}
        </div>
        <p className="research-prompt">{job.prompt}</p>
        {note.length > 0 && <p className="research-note">{note}</p>}
        {found.length > 0 && <p className="research-result">{found}</p>}
        {missing.length > 0 && <><p className="research-missing-title">{label("missing")}</p><ul className="research-missing">{missing.map((part, i) => <li key={i}>{part}</li>)}</ul></>}
        {data !== undefined && <p className="research-meta">{label(data.kind)} · {label("dataDate")} {data.date ?? label("unknownDate")}</p>}
        {sources.length > 0 && <p className="research-sources">{sources.map((source, i) => <Fragment key={`${source.url}-${i}`}>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>{" · "}{label("checked")} {source.lastCheckedAt ?? label("unknownDate")}{" "}
        </Fragment>)}</p>}
        {job.questionRevision !== undefined && <form key={job.questionRevision} className="research-answer-form" onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const text = new FormData(form).get("text");
          void change("/research/" + job.id + "/answer", "POST", { text, consent: true, questionRevision: job.questionRevision }, {
            feedback: workflowText("answeredJob", lang, { title: summarizeTitle(job.prompt) }),
            markActive: true,
            onDone: () => form.reset(),
          });
        }}><label>{label("answer")} <input name="text" maxLength={600} required/></label>
          <button type="submit" aria-label={actionAria(resumeLabel, job.prompt)}>{resumeLabel}</button></form>}
        <div className="row research-actions">
          {(found.length > 0 || missing.length > 0) && <button type="button" aria-label={actionAria(readLabel, job.prompt)} onClick={() => onRead([
            job.prompt, found, ...sources.map(source => `${source.title}. ${label("checked")} ${source.lastCheckedAt ?? label("unknownDate")}`),
            ...(missing.length > 0 ? [label("missing"), ...missing] : []),
          ].filter(Boolean).join(". "))}>{readLabel}</button>}
          {job.state === "failed" && <button type="button" aria-label={actionAria(retryLabel, job.prompt)} onClick={() => void change("/research", "POST", {
            text: job.prompt, consent: true, requestId: crypto.randomUUID(),
          }, { feedback: workflowText("retriedJob", lang, { title: summarizeTitle(job.prompt) }), markActive: true })}>{retryLabel}</button>}
          {["needs_input", "incomplete", "failed", "partial"].includes(job.state) &&
            <button type="button" aria-label={actionAria(reviseLabel, job.prompt)} onClick={() => {
              if (researchInput.current !== null) { researchInput.current.value = job.prompt; researchInput.current.focus(); }
            }}>{reviseLabel}</button>}
          <button type="button" aria-label={actionAria(cancelOrDelete, job.prompt)} onClick={() => void change(
            "/research/" + job.id + (inProgress ? "/claim" : ""),
            "DELETE",
            undefined,
            {
              feedback: (result) => {
                if (inProgress) {
                  const parsed = CancelSchema.safeParse(result);
                  return workflowText(parsed.success && !parsed.data.cancelled ? "cancelAlreadyFinished" : "cancelledJob", langRef.current, { title: summarizeTitle(job.prompt) });
                }
                const parsed = DeleteSchema.safeParse(result);
                return workflowText(parsed.success && !parsed.data.deleted ? "deleteAlreadyRemoved" : "deletedJob", langRef.current, { title: summarizeTitle(job.prompt) });
              },
            },
          )}>{cancelOrDelete}</button>
        </div>
      </li>;
    })}</ul>
    <form id="note-form" ref={noteForm} onSubmit={saveNote}>
      <label id="note-label" htmlFor="note-input">{workflowText("noteLabel", lang)}</label>
      <textarea id="note-input" rows={2} maxLength={300} required ref={noteInput}></textarea>
      {directActions ? <p id="note-permission">{workflowText("noteStorage", lang)}</p> :
        <label><input id="note-consent" type="checkbox" ref={noteConsent}/> <span id="note-permission">{workflowText("noteConsent", lang)}</span></label>}
      <div className="row">
        <button id="note-add" type="submit">{workflowText("noteAdd", lang)}</button>
        <button id="note-search" type="button" onClick={searchNotes}>{workflowText("noteSearch", lang)}</button>
        <button id="note-all" type="button" onClick={() => { setFilter(undefined); setFeedback(""); }}>{workflowText("noteAll", lang)}</button>
      </div>
    </form>
    <ul id="note-list">{snapshot !== undefined && matches.map(note => <li key={note.id}>
      {note.body + " "}
      <button type="button" aria-label={actionAria(workflowText("delete", lang), note.body)} onClick={() => void change("/notes/" + note.id, "DELETE", undefined, { feedback: workflowText("noteDeleted", lang) })}>
        {workflowText("delete", lang)}
      </button>
    </li>)}</ul>
    <p id="workflow-feedback" role="status">{feedback}</p>
  </details>;
}
