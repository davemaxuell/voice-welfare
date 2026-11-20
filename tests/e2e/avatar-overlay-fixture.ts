// 아바타 창 쪽 연결(overlay-preload.cjs와 같은 이름). tests/e2e/test_avatar.py의 FAKE_OVERLAY와 같은 글이다.
export const FAKE_OVERLAY = `
window.__calls = [];
const handlers = {};
const call = (name) => (...args) => window.__calls.push([name, ...args]);
window.cheongeumOverlay = {
  ready() {
    call('ready')();
    handlers.visibility?.({visible:true, id:0, animate:false});
  },
  resize: call('resize'), talk: call('talk'), stop: call('stop'), open: call('open'),
  hide: call('hide'), release: call('release'), choose: call('choose'), visibilityDone: call('visibilityDone'),
  onSnapshot: (cb) => { handlers.snapshot = cb; },
  onPrefs: (cb) => { handlers.prefs = cb; },
  onFocus: (cb) => { handlers.focus = cb; },
  onVisibility: (cb) => { handlers.visibility = cb; },
};
window.__send = (kind, value) => handlers[kind](value);
`;
