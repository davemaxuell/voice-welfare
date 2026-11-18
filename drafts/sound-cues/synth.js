// 청음 합성 신호음 후보(Web Audio). speaker.js의 earcon()과 같은 방식이라 파일·라이선스가 필요 없다.
// 모두 사인·삼각파에 20ms 이상 직선으로 커지게 시작해 박수 감지기(봉우리/RMS > 4)에 걸리지 않게 하고,
// (지수 곡선으로 키우면 끝 몇 ms에 몰려 커져서 날카롭게 잡힌다 — 지금 earcon이 3.96)
// 기본음은 330~1050Hz(노트북 스피커와 나이 든 귀에 잘 들리는 대역)에 둔다.
(function () {
  const N = { Fs4: 369.99, A4: 440, C5: 523.25, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5 };
  const BELL = [[2, 0.2], [3, 0.05]];

  /** 음 하나. to가 있으면 glide초 동안 미끄러진다. 끝나는 시각을 돌려준다. */
  function tone(c, out, t, { f, to, glide, dur, type = 'sine', gain = 0.22, attack = 0.02, partials = [] }) {
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    for (const [ratio, rel] of [[1, 1], ...partials]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f * ratio, t);
      if (to) o.frequency.exponentialRampToValueAtTime(to * ratio, t + (glide ?? dur));
      const pg = c.createGain();
      pg.gain.value = rel;
      o.connect(pg).connect(g);
      o.start(t);
      o.stop(t + dur + 0.02);
    }
    return t + dur;
  }

  /** 가벼운 메아리(공간감). 마이크가 열려 있을 때 나는 소리에는 쓰지 않는다(꼬리가 말로 들릴 수 있음). */
  function echo(c, out, life, delay = 0.12, feedback = 0.22) {
    const input = c.createGain();
    const d = c.createDelay(1);
    d.delayTime.value = delay;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2500;
    const fb = c.createGain();
    fb.gain.value = feedback;
    input.connect(out);
    input.connect(d);
    d.connect(lp).connect(fb);
    fb.connect(d);
    fb.connect(out);
    if (typeof OfflineAudioContext === 'undefined' || !(c instanceof OfflineAudioContext))
      setTimeout(() => {
        fb.disconnect();
        d.disconnect();
      }, (life + 1.5) * 1000);
    return input;
  }

  // 지금 speaker.js earcon()과 똑같이
  function current(freqs) {
    return (c, out, t) => {
      for (const f of freqs) {
        const o = c.createOscillator();
        const g = c.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.13);
        t += 0.14;
      }
      return t;
    };
  }

  const cues = {
    // 마이크 켜짐: 위로 미끄러지는 '뾰롱'
    start: (c, out, t) => {
      tone(c, out, t, { f: N.A4, to: N.A5, dur: 0.16, gain: 0.18 });
      return tone(c, out, t + 0.12, { f: N.A5, dur: 0.3, partials: BELL });
    },
    // 이제 말하세요: 지금의 '띵(두 음)'을 종소리 음색으로
    listen: (c, out, t) => {
      tone(c, out, t, { f: N.E5, dur: 0.2, partials: BELL });
      return tone(c, out, t + 0.09, { f: N.A5, dur: 0.24, partials: BELL });
    },
    // 다 들었어요: 짧은 'beep'(살짝 내려앉음). 마이크가 열려 있으므로 0.1초 안에 끝난다.
    heard: (c, out, t) => tone(c, out, t, { f: N.B5, to: N.A5, dur: 0.09, gain: 0.2 }),
    // 생각 중: 물방울 같은 'bloop'(아래에서 위로)
    thinking: (c, out, t) => tone(c, out, t, { f: 330, to: 700, glide: 0.1, dur: 0.15, partials: [[2, 0.1]] }),
    // 아직 일하는 중: 아주 작은 'boop'
    working: (c, out, t) => tone(c, out, t, { f: N.C5, to: 494, dur: 0.1, gain: 0.08 }),
    // 승인이 필요해요: 올라가며 끝나는 '띠리링?'
    approve: (c, out, t) => {
      const o = echo(c, out, 0.6);
      tone(c, o, t, { f: N.C5, dur: 0.12 });
      tone(c, o, t + 0.09, { f: N.E5, dur: 0.12 });
      return tone(c, o, t + 0.18, { f: N.A5, dur: 0.4, partials: BELL });
    },
    // 직접 해 주세요(로그인·본인인증 인계): 초인종 '딩-동'
    handoff: (c, out, t) => {
      const o = echo(c, out, 1.1);
      tone(c, o, t, { f: N.E5, dur: 0.5, gain: 0.2, partials: [[2, 0.25], [3, 0.08]] });
      return tone(c, o, t + 0.32, { f: N.C5, dur: 0.75, gain: 0.2, partials: [[2, 0.25], [3, 0.08]] });
    },
    // 모의접수 완료: 밝은 '도-미-솔-도'
    success: (c, out, t) => {
      const o = echo(c, out, 0.8);
      tone(c, o, t, { f: N.C5, dur: 0.14 });
      tone(c, o, t + 0.07, { f: N.E5, dur: 0.14 });
      tone(c, o, t + 0.14, { f: N.G5, dur: 0.14 });
      return tone(c, o, t + 0.21, { f: N.C6, dur: 0.55, partials: BELL });
    },
    // 문제가 생겼어요: 낮게 내려가는 부드러운 두 음(부저 소리 아님)
    problem: (c, out, t) => {
      tone(c, out, t, { f: N.A4, dur: 0.16, type: 'triangle', gain: 0.2 });
      return tone(c, out, t + 0.15, { f: N.Fs4, dur: 0.26, type: 'triangle', gain: 0.2 });
    },
    // 멈췄어요: 아래로 떨어지는 '뿅'(바로 끝남)
    stopped: (c, out, t) => tone(c, out, t, { f: 700, to: 300, dur: 0.18 }),
    // 마이크 꺼짐: 시작의 거울
    end: (c, out, t) => {
      tone(c, out, t, { f: N.A5, to: N.A4, dur: 0.16, gain: 0.18 });
      return tone(c, out, t + 0.12, { f: N.A4, dur: 0.3, partials: BELL });
    },
    // 기한 알림: '딩동' 두 번
    reminder: (c, out, t) => {
      const o = echo(c, out, 1.3);
      for (const s of [0, 0.7]) {
        tone(c, o, t + s, { f: N.C6, dur: 0.35, partials: BELL });
        tone(c, o, t + s + 0.18, { f: N.G5, dur: 0.5, partials: BELL });
      }
      return t + 1.38;
    },
  };

  window.CUE_SYNTH = { cues, current: { listen: current([660, 990]), heard: current([520]) } };
})();
