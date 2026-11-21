import { Profiler } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { start } from "./conversation.ts";
import { timing } from "./perf.ts";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("화면을 표시할 위치가 없습니다.");
const data = timing?.data;
createRoot(root).render(data === undefined ? <App/> :
  <Profiler id="app" onRender={() => { data.commits++; }}><App/></Profiler>);
void start();
