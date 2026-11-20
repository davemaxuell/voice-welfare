// 녹음 파일 받아쓰기: 파일을 음성 API에 보내 받아쓴 글만 보여 준다(대화로 보내지 않는다).
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { copy } from "./recording-review-text.ts";

const formats: Readonly<Partial<Record<string, string>>> = {
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4",
  ogg: "audio/ogg", webm: "audio/webm", flac: "audio/flac",
};

export function RecordingReview({ owner, lang }: { owner: string | undefined; lang: string }) {
  const words = copy[lang] ?? copy.ko ?? [];
  const file = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  const [status, setStatus] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<string | undefined>(undefined);
  const [hasFile, setHasFile] = useState(false);
  const [sending, setSending] = useState(false);

  const clear = () => {
    controller.current?.abort();
    controller.current = undefined;
    setSending(false);
    setStatus(undefined);
    setResult(undefined);
  };
  useEffect(() => {
    clear();
    if (file.current !== null) file.current.value = "";
    setHasFile(false);
  }, [owner]);

  async function transcribe() {
    const chosen = file.current?.files?.[0];
    if (owner === undefined || chosen === undefined || controller.current !== undefined) return;
    const type = formats[chosen.name.split(".").pop()?.toLowerCase() ?? ""];
    if (type === undefined || chosen.size < 200 || chosen.size > 10 * 1024 * 1024) {
      setStatus(5);
      return;
    }
    const active = controller.current = new AbortController();
    setSending(true);
    setStatus(4);
    try {
      const reply = await api.recording(owner, chosen, type, active.signal);
      if (controller.current !== active) return;
      setResult(reply.text);
      setStatus(6);
    } catch {
      if (controller.current === active) setStatus(7);
    } finally {
      if (controller.current === active) {
        controller.current = undefined;
        setSending(false);
      }
    }
  }

  return <details id="recording-review" className="examples-disclosure" hidden={owner === undefined}>
    <summary id="recording-title">{words[0]}</summary>
    <label htmlFor="recording-file" id="recording-label">{words[1]}</label>
    <input type="file" id="recording-file" accept=".wav,.mp3,.m4a,.mp4,.ogg,.webm,.flac" ref={file}
      onChange={e => { clear(); setHasFile((e.currentTarget.files?.length ?? 0) > 0); }}/>
    <button id="recording-send" type="button" disabled={owner === undefined || !hasFile || sending} onClick={() => void transcribe()}>{words[2]}</button>
    <p id="recording-status" role="status">{status === undefined ? "" : words[status] ?? ""}</p>
    <label id="recording-result-label" htmlFor="recording-result" hidden={result === undefined}>{words[3]}</label>
    <textarea id="recording-result" rows={4} readOnly hidden={result === undefined} value={result ?? ""}></textarea>
  </details>;
}
