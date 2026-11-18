import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { start } from "./conversation.ts";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("화면을 표시할 위치가 없습니다.");
createRoot(root).render(<App/>);
void start();
