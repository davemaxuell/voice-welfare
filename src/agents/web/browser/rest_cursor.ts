export function restingCursor() {
  if (document.getElementById('__cheongeum_cursor')) return null;
  const el = [...document.querySelectorAll('main h1, h1, main h2, main, [role="main"], article, h2')]
    .find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight; });
  if (!el) return { x: Math.round(innerWidth / 2), y: Math.min(160, Math.round(innerHeight / 3)) };
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + Math.min(r.width, 300) / 2), y: Math.round(r.top + Math.min(r.height, 60) / 2) };
}
