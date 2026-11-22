import { workspaceText } from "./workspace-language.ts";
import { getSpeechLang } from "./audio.ts";
import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { start, startConversation, suspendConversation } from "./conversation.ts";
import { timing } from "./perf.ts";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error(workspaceText("화면을 표시할 위치가 없습니다.", getSpeechLang()));
const renderer = createRoot(root);
const data = timing?.data;
function open() {
  renderer.render(data === undefined ? <App/> :
    <Profiler id="app" onRender={() => { data.commits++; }}><App/></Profiler>);
  void start();
}

function connect() {
  const url = new URL("/api/presentation", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  let leaving = false;
  let active = false;
  let resumeVoice = false;
  let socket: WebSocket;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 250;
  const t = (key: string) => workspaceText(key, getSpeechLang());
  const focus = () => {
    if (window.cheongeumDesktop?.showSetup !== undefined) window.cheongeumDesktop.showSetup();
    else if (window.cheongeumFocusWindow !== undefined) void window.cheongeumFocusWindow();
    else window.focus();
  };
  function attach() {
    clearTimeout(retry);
    if (leaving || (socket !== undefined && socket.readyState !== WebSocket.CLOSED)) return;
    socket = new WebSocket(url);
    socket.onmessage = event => {
      backoff = 250;
      if (event.data === "primary") {
        active = true;
        open();
        if (resumeVoice) { resumeVoice = false; void startConversation(); }
      }
      if (event.data === "focus") focus();
      if (event.data === "waiting") {
        // 연결이 끊긴 동안 다른 창이 대화를 맡았다. 이전 세션의 단축키와 마이크를 정리한다.
        if (active) { location.reload(); return; }
        renderer.render(<main>
          <h1>{t("청음 대화가 다른 창에 열려 있어요.")}</h1>
          <button onClick={() => { if (socket.readyState === WebSocket.OPEN) socket.send("focus"); }}>{t("대화 창으로 이동")}</button>
          <p>{t("브라우저가 창 전환을 막으면 탭 목록에서 먼저 연 청음 대화를 선택하세요.")}</p>
        </main>);
      }
    };
    socket.onclose = () => {
      if (leaving) return;
      if (active) resumeVoice = suspendConversation() || resumeVoice;
      renderer.render(<main><h1>{t("연결이 끊겼어요")}</h1>
        <button onClick={attach}>{t("다시 연결")}</button></main>);
      retry = setTimeout(attach, backoff);
      backoff = Math.min(backoff * 2, 4000);
    };
  }
  window.addEventListener("online", attach);
  window.addEventListener("pagehide", () => { leaving = true; clearTimeout(retry); socket.close(); }, { once: true });
  attach();
}
connect();
