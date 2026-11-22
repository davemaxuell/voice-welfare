// 아바타 창 전용. 대화 창의 표시 상태를 받고, 정해진 동작 이름만 메인 프로세스로 보낸다.
import { contextBridge, ipcRenderer } from "electron";

const act = (action: Record<string, unknown>) => ipcRenderer.send("overlay:action", action);

interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

// macOS forwards mouse moves even while clicks pass through the transparent window.
// Windows and Linux apply their input regions directly in the main process.
let regions: unknown[] = [];
let lastInteractive: boolean | undefined;
if (process.platform === "darwin") {
  window.addEventListener(
    "mousemove",
    ({ clientX, clientY }) => {
      const interactive =
        regions.length === 0 ||
        regions.some((r) => isRegion(r) && clientX >= r.x && clientX < r.x + r.width && clientY >= r.y && clientY < r.y + r.height);
      if (interactive === lastInteractive) return;
      lastInteractive = interactive;
      ipcRenderer.send("overlay:interactive", interactive);
    },
    { passive: true },
  );
}

contextBridge.exposeInMainWorld("cheongeumOverlay", {
  ready: () => ipcRenderer.send("overlay:ready"),
  onSnapshot: (cb: (snapshot: unknown) => void) => ipcRenderer.on("cheongeum:snapshot", (_e, snapshot: unknown) => cb(snapshot)),
  onPrefs: (cb: (prefs: unknown) => void) => ipcRenderer.on("overlay:prefs", (_e, prefs: unknown) => cb(prefs)),
  onVisibility: (cb: (state: unknown) => void) => ipcRenderer.on("overlay:visibility", (_e, state: unknown) => cb(state)),
  visibilityDone: (id: unknown) => ipcRenderer.send("overlay:visibility-done", id),
  onFocus: (cb: () => void) => ipcRenderer.on("overlay:focus", () => cb()),
  resize: (width: unknown, height: unknown, hitRegions: unknown, anchor: unknown) => {
    const list: unknown[] = Array.isArray(hitRegions) ? hitRegions : [];
    regions = list;
    lastInteractive = undefined;
    ipcRenderer.send("overlay:resize", { width, height, regions: list, anchor });
  },
  move: (phase: unknown, x: unknown, y: unknown) => ipcRenderer.send("overlay:move", phase, { x, y }),
  talk: () => act({ type: "talk" }),
  stop: () => act({ type: "stop" }),
  open: (focus: unknown) => act({ type: "open", focus }),
  hide: () => act({ type: "hide" }),
  release: () => act({ type: "release" }),
  choose: (choiceSetId: unknown, key: unknown) => act({ type: "choose", choiceSetId, key }),
});

function isRegion(value: unknown): value is Region {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    typeof value.x === "number" &&
    "y" in value &&
    typeof value.y === "number" &&
    "width" in value &&
    typeof value.width === "number" &&
    "height" in value &&
    typeof value.height === "number"
  );
}
