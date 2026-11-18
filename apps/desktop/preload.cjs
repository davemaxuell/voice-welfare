// 웹 UI에 데스크톱 기능만 최소로 노출한다(Node API는 노출하지 않음).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cheongeumDesktop', {
  isDesktop: true,
  /** 전역 단축키(다른 창을 보고 있어도)로 '지금 말하기' */
  onTalk: (cb) => ipcRenderer.on('cheongeum:talk', () => cb()),
});
