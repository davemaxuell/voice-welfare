// 웹 UI에 데스크톱 기능만 최소로 노출한다(Node API는 노출하지 않음).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cheongeumDesktop", {
  isDesktop: true,
  showSetup: () => ipcRenderer.send("cheongeum:show-setup"),
  /** 컴퓨터를 켤 때 청음도 켤지(Windows 시작 프로그램) */
  setAutoStart: (on: unknown) => ipcRenderer.send("cheongeum:set-auto-start", on === true),
  getAutoStart: (): Promise<unknown> => ipcRenderer.invoke("cheongeum:get-auto-start"),
  /** 전역 단축키(다른 창을 보고 있어도)로 '지금 말하기' */
  onTalk: (cb: () => void) => ipcRenderer.on("cheongeum:talk", () => cb()),
  /** 아바타 창에 보낼 표시 상태(글·선택지 이름만) */
  publish: (snapshot: unknown) => ipcRenderer.send("cheongeum:snapshot", snapshot),
  /** 아바타·트레이에서 고른 동작: { type: 'stop' | 'reveal' | 'choose' | 'settings', … } */
  onAction: (cb: (action: unknown) => void) => ipcRenderer.on("cheongeum:action", (_e, action: unknown) => cb(action)),
});
