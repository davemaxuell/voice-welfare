async function call(path, init) {
    const res = await fetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(body.message ?? `요청 실패 (${res.status})`);
    return body;
}
async function failure(res) {
    const body = (await res.json().catch(() => ({})));
    throw new Error(body.message ?? `요청 실패 (${res.status})`);
}
export const api = {
    health: () => call('/api/health'),
    /** 녹음 파일을 보내 받아쓰기+턴 처리를 한 번에. 받아쓴 원문은 돌아오지 않는다. */
    async audioTurn(sessionId, audio) {
        const res = await fetch(`/api/audio/turn?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: { 'Content-Type': audio.type || 'audio/webm' },
            body: audio,
        });
        return res.ok ? (await res.json()) : failure(res);
    },
    async speak(text, lang) {
        const res = await fetch('/api/audio/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang }) });
        return res.ok ? res.blob() : failure(res);
    },
    createSession: () => call('/api/session', { method: 'POST' }),
    turn: (sessionId, text) => call('/api/turn', { method: 'POST', body: JSON.stringify({ sessionId, text, clientPlatform: 'pc' }) }),
    confirm: (sessionId, approve) => call(`/api/session/${sessionId}/confirm`, { method: 'POST', body: JSON.stringify({ approve }) }),
    reminders: (sessionId) => call(`/api/session/${sessionId}/reminders`),
    language: (sessionId, lang) => call(`/api/session/${sessionId}/language`, { method: 'POST', body: JSON.stringify({ lang }) }),
    cancel: (sessionId) => call(`/api/session/${sessionId}/cancel`, { method: 'POST' }),
    /** 페이지를 떠날 때 호출. keepalive라서 탭이 닫혀도 요청이 전송된다. */
    close: (sessionId) => {
        void fetch(`/api/session/${sessionId}`, { method: 'DELETE', keepalive: true }).catch(() => undefined);
    },
    consent: (sessionId, granted) => call(`/api/session/${sessionId}/consent`, { method: 'POST', body: JSON.stringify({ granted }) }),
    state: (sessionId) => call(`/api/session/${sessionId}/state`),
};
