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
    /** 일하는 동안 들은 말을 보낸다. 멈춤 말이면 멈추고, 진행 상황 물음이면 바로 답하고(result), 그 밖의 말은 버린다. */
    async audioStop(sessionId, audio) {
        const res = await fetch(`/api/audio/stop?sessionId=${encodeURIComponent(sessionId)}`, {
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
