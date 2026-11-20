// 아바타 창 전용. 대화 창의 표시 상태를 받고, 정해진 동작 이름만 메인 프로세스로 보낸다.
const { contextBridge, ipcRenderer } = require('electron');

const act = (action) => ipcRenderer.send('overlay:action', action);

// macOS forwards mouse moves even while clicks pass through the transparent window.
// Windows and Linux apply their input regions directly in the main process.
let regions = [];
let lastInteractive;
if (process.platform === 'darwin') {
  window.addEventListener('mousemove', ({ clientX, clientY }) => {
    const interactive = !regions.length || regions.some((r) =>
      clientX >= r.x && clientX < r.x + r.width && clientY >= r.y && clientY < r.y + r.height);
    if (interactive === lastInteractive) return;
    lastInteractive = interactive;
    ipcRenderer.send('overlay:interactive', interactive);
  }, { passive: true });
}

contextBridge.exposeInMainWorld('cheongeumOverlay', {
  ready: () => ipcRenderer.send('overlay:ready'),
  onSnapshot: (cb) => ipcRenderer.on('cheongeum:snapshot', (_e, snapshot) => cb(snapshot)),
  onPrefs: (cb) => ipcRenderer.on('overlay:prefs', (_e, prefs) => cb(prefs)),
  onVisibility: (cb) => ipcRenderer.on('overlay:visibility', (_e, state) => cb(state)),
  visibilityDone: (id) => ipcRenderer.send('overlay:visibility-done', id),
  onFocus: (cb) => ipcRenderer.on('overlay:focus', () => cb()),
  resize: (width, height, hitRegions) => {
    regions = Array.isArray(hitRegions) ? hitRegions : [];
    lastInteractive = undefined;
    ipcRenderer.send('overlay:resize', { width, height, regions });
  },
  talk: () => act({ type: 'talk' }),
  stop: () => act({ type: 'stop' }),
  open: (focus) => act({ type: 'open', focus }),
  hide: () => act({ type: 'hide' }),
  release: () => act({ type: 'release' }),
  choose: (choiceSetId, key) => act({ type: 'choose', choiceSetId, key }),
});
