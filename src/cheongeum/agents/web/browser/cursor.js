(() => {
  const root = document.documentElement;
  const SVG = 'http://www.w3.org/2000/svg';
  const MODE = '__MODE__';
  const X = __X__;
  const Y = __Y__;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const WAIT_LIMIT_MS = 120000; // 승인은 2분 뒤 만료되므로 그 뒤에는 기다리는 모습을 거두어들인다
  const GLIDE = 'left .45s cubic-bezier(.34,1.3,.5,1), top .45s cubic-bezier(.34,1.3,.5,1)';

  const div = (css, parent) => {
    const d = document.createElement('div');
    d.style.cssText = css;
    if (parent) parent.appendChild(d);
    return d;
  };

  let c = document.getElementById('__cheongeum_cursor');
  if (!c) {
    c = div('position:fixed;left:-100px;top:-100px;width:0;height:0;z-index:2147483647;pointer-events:none;');
    c.id = '__cheongeum_cursor';
    c.setAttribute('aria-hidden', 'true');
    const arrow = div('position:absolute;left:0;top:0;transform-origin:0 0;', c);
    arrow.className = 'arrow';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '40');
    svg.setAttribute('viewBox', '0 0 14 20');
    svg.style.cssText = 'display:block;overflow:visible;filter:drop-shadow(0 3px 3px rgba(0,0,0,.35));';
    const shape = 'M0 0 L0 16.4 L4 12.8 L6.6 19 L9.4 17.8 L6.8 11.6 L12 11.6 Z';
    for (const [fill, stroke, width] of [['#fff', '#fff', 3.6], ['#ffd640', '#222', 1.2]]) {
      const p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', shape);
      p.setAttribute('fill', fill);
      p.setAttribute('stroke', stroke);
      p.setAttribute('stroke-width', String(width));
      p.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(p);
    }
    arrow.appendChild(svg);
    const bubble = div('position:absolute;display:none;box-sizing:border-box;gap:4px;align-items:center;padding:5px 7px;'
      + 'background:#fff;border:2px solid #222;border-radius:12px;box-shadow:0 2px 4px rgba(0,0,0,.25);', c);
    bubble.className = 'bubble';
    for (let i = 0; i < 3; i++) div('width:5px;height:5px;border-radius:50%;background:#f5a300;', bubble).className = 'dot';
    root.appendChild(c);
  }

  const arrow = c.querySelector('.arrow');
  const bubble = c.querySelector('.bubble');
  const dots = [...c.querySelectorAll('.dot')];

  // 이전 모드의 움직임을 끊는다. 위치 이동(CSS 전환)은 건드리지 않는다.
  (c.__anims || []).forEach((a) => a.cancel());
  const anims = (c.__anims = []);
  const play = (node, frames, options) => {
    if (calm) return;
    const a = node.animate(frames, options);
    anims.push(a);
    return a;
  };
  bubble.style.display = 'none';
  c.dataset.mode = MODE;
  c.style.transition = calm ? 'none' : GLIDE;
  c.style.left = X + 'px';
  c.style.top = Y + 'px';

  const MODES = {
    move: () => {},
    click: () => {
      play(arrow, [{ transform: 'scale(1)' }, { transform: 'scale(.8)', offset: 0.4 }, { transform: 'scale(1)' }],
        { duration: 360, delay: 380, easing: 'ease-out' });
      if (calm) return;
      const ring = div(`position:fixed;left:${X}px;top:${Y}px;width:46px;height:46px;border-radius:50%;z-index:2147483646;pointer-events:none;`
        + 'border:3px solid rgba(255,191,0,.9);box-shadow:0 0 18px rgba(255,191,0,.6);opacity:0;', root);
      ring.setAttribute('aria-hidden', 'true');
      const a = ring.animate([
        { transform: 'translate(-50%,-50%) scale(.3)', opacity: 0.85 },
        { transform: 'translate(-50%,-50%) scale(3.2)', opacity: 0 },
      ], { duration: 700, delay: 420, easing: 'ease-out' });
      a.onfinish = () => ring.remove();
    },
    wait: () => {
      // 말풍선은 화면 가장자리에서 잘리지 않게 반대편에 둔다
      bubble.style.left = (X > innerWidth - 90 ? -54 : 24) + 'px';
      bubble.style.top = (Y > innerHeight - 90 ? -32 : 30) + 'px';
      bubble.style.display = 'flex';
      const turns = Math.round(WAIT_LIMIT_MS / 1800);
      const nod = play(arrow, [
        { transform: 'rotate(0deg)', offset: 0 }, { transform: 'rotate(-10deg)', offset: 0.15 },
        { transform: 'rotate(6deg)', offset: 0.3 }, { transform: 'rotate(0deg)', offset: 0.45 }, { transform: 'rotate(0deg)', offset: 1 },
      ], { duration: 1800, delay: 500, iterations: turns, easing: 'ease-in-out' });
      play(bubble, [{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 250, delay: 500, fill: 'backwards', easing: 'ease-out' });
      dots.forEach((d, i) => play(d, [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)', offset: 0.25 }, { transform: 'translateY(0)', offset: 0.5 }, { transform: 'translateY(0)' }],
        { duration: 900, delay: 500 + i * 150, iterations: Math.round(WAIT_LIMIT_MS / 900), easing: 'ease-in-out' }));
      if (nod) nod.onfinish = () => { bubble.style.display = 'none'; };
    },
  };
  MODES[MODE]();
})()
