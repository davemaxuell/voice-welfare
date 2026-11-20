// WebRTC carries native microphone and speaker audio. The loopback websocket
// authenticates the offer and delivers results from the application's worker.
import { audioContext } from './audio.js';
import { isSpeaking, serverTts } from './speaker.js';

// 청음이 읽는 동안 GPT-Live로 가는 마이크는 꺼 둔다(청음 자신의 목소리가 요청이 되면 안 된다).
// 그래서 읽는 말을 끊는 소리는 mic.js watchBargeIn처럼 여기서 판단한다: 스피커 소리보다 큰 소리가 300ms.
export class BargeDetector {
  constructor() {
    this.floor = 0.01;
    this.bleed = this.floor;
    this.loudMs = 0;
  }

  feed(level, speaking, ms = 50) {
    if (!speaking) {
      if (level < this.floor * 2) this.floor = this.floor * 0.95 + level * 0.05;
      this.bleed = this.floor;
      this.loudMs = 0;
      return false;
    }
    if (level > Math.max(0.02, this.bleed * 2.2, this.floor * 4)) this.loudMs += ms;
    else {
      this.loudMs = Math.max(0, this.loudMs - ms);
      this.bleed = this.bleed * 0.9 + level * 0.1;
    }
    if (this.loudMs < 300) return false;
    this.loudMs = 0;
    return true;
  }
}

export class LiveConversation {
  constructor(sessionId, callbacks) {
    this.sessionId = sessionId;
    this.callbacks = callbacks;
    this.audio = new Audio();
    this.audio.autoplay = true;
    this.enabled = true;
    this.localSpeech = isSpeaking();
    this.paused = false;
    this.closed = false;
    this.interrupted = false;
  }

  async start(deviceId) {
    const peer = this.peer = new RTCPeerConnection();
    const signal = (this.abort = new AbortController()).signal;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, ...(deviceId && { deviceId: { exact: deviceId } }),
    } });
    if (this.closed) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('대화가 종료됐어요.');
    }
    this.stream = stream;
    for (const track of stream.getAudioTracks()) {
      peer.addTrack(track, stream);
      track.onended = () => this.fail('마이크 연결이 끊겼어요.');
    }
    this.updateAudio();
    this.watchBargeIn(stream);
    peer.ontrack = ({ track }) => {
      this.audio.srcObject = new MediaStream([track]);
      this.audio.play().catch(() => {
        if (!this.closed) this.callbacks.notice('실시간 음성을 재생하려면 대화 시작을 다시 선택해 주세요.');
      });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') this.fail('실시간 음성 연결에 실패했어요. 다시 시작하거나 한 번씩 받아쓸 수 있어요.');
    };
    const channel = this.channel = peer.createDataChannel('oai-events');
    channel.onmessage = ({ data }) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event.type === 'session.input_transcript.delta') {
        this.interrupted = false;
        this.updateAudio();
        this.phase('hearing');
      } else if (event.type === 'session.output_transcript.delta' && !this.localSpeech && !this.paused && !this.interrupted) {
        this.phase('speaking');
        this.callbacks.caption(event);
      } else if (event.type === 'session.delegation.created') this.phase('thinking');
    };
    await peer.setLocalDescription(await peer.createOffer());
    if (peer.iceGatheringState !== 'complete') {
      await new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          peer.removeEventListener('icegatheringstatechange', check);
          signal.removeEventListener('abort', done);
          if (signal.aborted) reject(new Error('대화가 종료됐어요.'));
          else resolve();
        };
        const check = () => { if (peer.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, 3500);
        peer.addEventListener('icegatheringstatechange', check);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done(); else check();
      });
    }
    if (this.closed) return;
    const url = new URL('/api/session/' + encodeURIComponent(this.sessionId) + '/audio/conversation', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('실시간 음성 연결 시간이 초과됐어요.'), 25000);
      let ready = false;
      const fail = message => {
        clearTimeout(timer);
        if (!ready) reject(new Error(message)); else this.fail(message);
      };
      signal.addEventListener('abort', () => fail('대화가 종료됐어요.'), { once: true });
      socket.onopen = () => this.callbacks.offer(socket, peer.localDescription.sdp);
      channel.onopen = () => {
        clearTimeout(timer);
        ready = true;
        resolve();
      };
      channel.onclose = () => fail('실시간 음성 대화가 종료됐어요.');
      socket.onmessage = async ({ data }) => {
        try {
          const msg = JSON.parse(data);
          if (msg.error) return fail(msg.message);
          if (msg.sdp) await peer.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          if (msg.result && !this.closed) await this.callbacks.result(msg.result, msg.exact);
        } catch (error) { fail(error.message); }
      };
      socket.onerror = () => fail('실시간 음성 서비스에 연결할 수 없어요.');
      socket.onclose = () => fail('실시간 음성 대화가 종료됐어요.');
    });
  }

  watchBargeIn(stream) {
    // GPT-Live 쪽 원래 트랙을 꺼도 복제본으로 계속 잰다.
    const track = stream.getAudioTracks()[0]?.clone();
    if (!track) return;
    const ctx = audioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const detector = new BargeDetector();
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const v of samples) sum += v * v;
      if (detector.feed(Math.sqrt(sum / samples.length), !!this.localSpeech)) serverTts.cancel();
    }, 50);
    this.stopBargeIn = () => {
      clearInterval(timer);
      source.disconnect();
      track.stop();
    };
  }

  phase(value) {
    if (this.closed) return;
    clearTimeout(this.phaseTimer);
    this.callbacks.phase(value);
    if (value !== 'thinking') this.phaseTimer = setTimeout(() => this.callbacks.phase('listening'), 1200);
  }

  updateAudio() {
    this.audio.muted = !this.enabled || this.paused || this.interrupted || !!this.localSpeech;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !this.paused && !this.localSpeech;
  }

  setLanguage(lang) {
    if (this.language === lang || this.channel?.readyState !== 'open' || !['ko', 'en', 'ja', 'zh'].includes(lang)) return;
    this.language = lang;
    this.channel.send(JSON.stringify({ type: 'session.instructions.append', event_id: crypto.randomUUID(),
      delegation_id: null, content: 'The application selected reply language ' + lang + '. Use it for subsequent speech.' }));
  }

  interrupt() {
    this.interrupted = true;
    this.updateAudio();
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({
      type: 'session.instructions.append', event_id: crypto.randomUUID(), delegation_id: null,
      content: 'Stop speaking immediately and listen to the user.',
    }));
    this.phase('listening');
  }

  fail(message) {
    if (!this.closed) this.callbacks.failure(message);
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.phaseTimer);
    this.stopBargeIn?.();
    this.abort?.abort();
    this.stream?.getTracks().forEach(track => track.stop());
    this.socket?.close();
    this.channel?.close();
    this.peer?.close();
    this.audio.pause();
    this.audio.srcObject = null;
  }
}
