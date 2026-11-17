(() => {
  const root = document.documentElement;
  if (!document.getElementById('__ieum_style')) {
    const st = document.createElement('style');
    st.id = '__ieum_style';
    st.textContent = '@keyframes __ieumPulse{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.9}50%{transform:translate(-50%,-50%) scale(1.25);opacity:.65}}'
      + '@keyframes __ieumRipple{from{transform:translate(-50%,-50%) scale(.3);opacity:.85}to{transform:translate(-50%,-50%) scale(3.2);opacity:0}}';
    root.appendChild(st);
  }
  let c = document.getElementById('__ieum_cursor');
  if (!c) {
    c = document.createElement('div');
    c.id = '__ieum_cursor';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:-100px;top:-100px;width:46px;height:46px;border-radius:50%;z-index:2147483647;pointer-events:none;'
      + 'background:radial-gradient(circle, rgba(255,214,64,.95) 0%, rgba(255,191,0,.55) 38%, rgba(255,160,0,.18) 62%, rgba(255,160,0,0) 72%);'
      + 'filter:blur(1.5px);box-shadow:0 0 28px 12px rgba(255,190,40,.45);transition:left .45s cubic-bezier(.22,.8,.3,1), top .45s cubic-bezier(.22,.8,.3,1);'
      + 'animation:__ieumPulse 1.6s ease-in-out infinite;';
    root.appendChild(c);
  }
  c.style.left = '__X__px';
  c.style.top = '__Y__px';
  if (__RIPPLE__) {
    setTimeout(() => {
      const r = document.createElement('div');
      r.setAttribute('aria-hidden', 'true');
      r.style.cssText = 'position:fixed;left:__X__px;top:__Y__px;width:46px;height:46px;border-radius:50%;z-index:2147483646;pointer-events:none;'
        + 'border:3px solid rgba(255,191,0,.9);box-shadow:0 0 18px rgba(255,191,0,.6);animation:__ieumRipple .7s ease-out forwards;';
      root.appendChild(r);
      setTimeout(() => r.remove(), 750);
    }, 420);
  }
})()