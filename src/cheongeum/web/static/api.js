let writer;
let requestSeq = 0;

function headers(values) {
    return { ...(writer ? { 'X-Cheongeum-Writer': writer } : {}), ...values };
}

async function fetchOnceRetried(path, init) {
    try {
        return await fetch(path, init);
    } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return fetch(path, init);
    }
}

async function call(path, init, retry = false) {
    const opts = { ...init, headers: headers({ ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers }) };
    if (retry && path !== '/api/session/recover') opts.headers['X-Cheongeum-Request'] = String(++requestSeq);
    const res = await (retry ? fetchOnceRetried(path, opts) : fetch(path, opts));
    return res.ok ? res.json() : failure(res);
}
async function failure(res) {
    const body = (await res.json().catch(() => ({})));
    const after = res.headers.get('Retry-After');
    const delay = after === null ? NaN : Number.isFinite(Number(after)) ? Number(after) * 1000 : Date.parse(after) - Date.now();
    throw Object.assign(new Error(body.message ?? `요청 실패 (${res.status})`), { code: body.error, status: res.status,
        retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay) : undefined });
}

// The renderer only receives a one-use receipt. Transcript text stays on the local server.
function liveAudio(sessionId) {
    const url = new URL(`/api/session/${encodeURIComponent(sessionId)}/audio/live`, location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    const pending = [];
    let committed = false;
    let cancelled = false;
    let resolve, reject;
    const receipt = new Promise((yes, no) => { resolve = yes; reject = no; });
    receipt.catch(() => {}); // The recording may be cancelled before anyone requests its result.
    const lost = () => reject(new Error('실시간 받아쓰기 연결이 끊겼어요. 다시 말씀해 주세요.'));
    socket.onopen = () => {
        if (cancelled) return socket.close();
        socket.send(JSON.stringify({ writer: writer ?? '' }));
        for (const frame of pending) socket.send(frame);
        pending.length = 0;
        if (committed) socket.send('commit');
    };
    socket.onmessage = ({ data }) => {
        try {
            const msg = JSON.parse(data);
            if (msg.receipt) resolve(msg.receipt);
            else reject(Object.assign(new Error(msg.message), { code: msg.error }));
        } catch { lost(); }
    };
    socket.onerror = lost;
    socket.onclose = () => { pending.length = 0; lost(); };
    return {
        append(frame) {
            if (committed || cancelled) return;
            if (socket.readyState === WebSocket.OPEN) socket.send(frame);
            else if (socket.readyState === WebSocket.CONNECTING) pending.push(frame);
        },
        commit() {
            if (!committed && !cancelled && socket.readyState === WebSocket.OPEN) socket.send('commit');
            committed = true;
            return receipt;
        },
        cancel() {
            cancelled = true;
            pending.length = 0;
            socket.close();
        },
    };
}

async function audioBody(audio) {
    if (typeof audio.commit === 'function') {
        return { type: 'application/json', body: JSON.stringify({ receipt: await audio.commit() }) };
    }
    return { type: audio.type || 'audio/webm', body: audio };
}

export const api = {
    workspace: (sid, path = '', method = 'GET', data) => call(`/api/session/${encodeURIComponent(sid)}/workspace${path}`,
        { method, body: data ? JSON.stringify(data) : undefined }),
    recording: (sid, file, type, signal) => call(`/api/audio/recording?sessionId=${encodeURIComponent(sid)}`, {
        method: 'POST', headers: { 'Content-Type': type }, body: file, signal,
    }),
    liveAudio,
    voiceOffer: (socket, sdp, approvalId = '') => socket.send(JSON.stringify({ writer: writer ?? '', sdp, approvalId })),
    health: () => call('/api/health'),
    settings: () => call('/api/settings'),
    saveSettings: values => call('/api/settings', { method: 'POST', body: JSON.stringify(values) }),
    saveGuardian: contact => call('/api/personal/guardian', { method: 'POST', body: JSON.stringify(contact) }),
    checkKey: apiKey => call('/api/settings/check-key', { method: 'POST', body: JSON.stringify({ apiKey }) }),
    writer: (key) => { writer = key; requestSeq = 0; },
    recover: (token) => call('/api/session/recover', { method: 'POST', body: JSON.stringify({ token, attempt: crypto.randomUUID() }) }, true),
    resume: (sid) => call(`/api/session/${sid}/resume`, { method: 'POST' }, true),
    wake: (sid, stopGeneration) => call(`/api/session/${sid}/wake`, {
        method: 'POST', body: JSON.stringify({ stopGeneration }),
    }, true),
    heartbeat: (sid) => call(`/api/session/${sid}/heartbeat`),
    end: (sid) => call(`/api/session/${sid}`, { method: 'DELETE' }),
    detach: (sid) => {
        void fetch(`/api/session/${sid}/detach`, { method: 'POST', headers: headers(), keepalive: true }).catch(() => undefined);
    },
    /** 녹음 파일을 보내 받아쓰기+턴 처리를 한 번에. 받아쓴 원문은 돌아오지 않는다. */
    async audioTurn(sessionId, audio, actionId = '') {
        const clip = await audioBody(audio);
        const res = await fetchOnceRetried(`/api/audio/turn?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: headers({ 'Content-Type': clip.type, 'X-Cheongeum-Action': actionId,
                               'X-Cheongeum-Request': String(++requestSeq) }),
            body: clip.body,
        });
        return res.ok ? (await res.json()) : failure(res);
    },
    /** 일하는 동안 들은 말을 보낸다. 멈춤 말이면 멈추고, 진행 상황 물음이면 바로 답하고(result), 그 밖의 말은 버린다. */
    async audioStop(sessionId, audio) {
        const clip = await audioBody(audio);
        const res = await fetch(`/api/audio/stop?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: headers({ 'Content-Type': clip.type }),
            body: clip.body,
        });
        return res.ok ? (await res.json()) : failure(res);
    },
    /** rate: 말 빠르기 설정(speechPrefs.rate). 서버 음성도 이 빠르기로 합성한다. */
    async speak(text, lang, rate, absoluteSpeed, signal) {
        const res = await fetch('/api/audio/speak', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang, rate, absoluteSpeed }) });
        return res.ok ? res.blob() : failure(res);
    },
    createSession: (recoverable = false) => call('/api/session', { method: 'POST', body: JSON.stringify(recoverable ? { recovery: true } : { attached: true }) }),
    turn: (sessionId, text, actionId = '') => call('/api/turn', { method: 'POST', body: JSON.stringify({ sessionId, text, actionId, clientPlatform: 'pc' }) }, true),
    confirm: (sessionId, approve, actionId) => call(`/api/session/${sessionId}/confirm`, { method: 'POST', body: JSON.stringify({ approve, actionId }) }, true),
    /** 서버가 제안한 선택지 고르기: { turnId, key, handoffId? }. 지난 제안이면 409 CHOICE_EXPIRED. */
    choice: (sessionId, body) => call(`/api/session/${sessionId}/choice`, { method: 'POST', body: JSON.stringify(body) }, true),
    reminders: (sessionId) => call(`/api/session/${sessionId}/reminders`),
    progress: (sessionId) => call(`/api/session/${sessionId}/progress`),
    language: (sessionId, lang) => call(`/api/session/${sessionId}/language`, { method: 'POST', body: JSON.stringify({ lang }) }),
    cancel: (sessionId) => call(`/api/session/${sessionId}/cancel`, { method: 'POST' }),
    /** 페이지를 떠날 때 호출. keepalive라서 탭이 닫혀도 요청이 전송된다. */
    close: (sessionId) => {
        void fetch(`/api/session/${sessionId}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    },
    consent: (sessionId, granted) => call(`/api/session/${sessionId}/consent`, { method: 'POST', body: JSON.stringify({ granted }) }),
    state: (sessionId) => call(`/api/session/${sessionId}/state`),
};
