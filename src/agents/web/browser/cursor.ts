export type CursorMode = "move" | "click" | "wait";

/** Render inside the page. The function is serialized into a separate JavaScript realm. */
export function drawCursor({ x, y, mode }: { x: number; y: number; mode: CursorMode }) {
  type Cursor = HTMLElement & { animations?: Animation[]; waitTimer?: number; place?: () => void };
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const waitLimit = 120_000;
  const div = (css: string, parent?: Element | ShadowRoot) => {
    const node = document.createElement("div");
    node.style.cssText = css;
    parent?.appendChild(node);
    return node;
  };
  const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>, parent: Element) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    parent.appendChild(node);
    return node;
  };

  const existing = document.getElementById("__cheongeum_cursor") as Cursor | null;
  const cursor: Cursor = existing ?? div("all:initial;position:fixed;width:0;height:0;z-index:2147483647;pointer-events:none;");
  if (existing === null) {
    cursor.id = "__cheongeum_cursor";
    cursor.setAttribute("aria-hidden", "true");
    // Portal styles often include generic rules for arrows, bubbles and SVGs.
    const shadow = cursor.attachShadow({ mode: "open" });
    const direction = div("position:absolute;left:0;top:0;transform-origin:0 0;", shadow);
    direction.className = "direction";
    const arrow = div("transform-origin:0 0;", direction);
    arrow.className = "arrow";
    const icon = svg("svg", { width: "35", height: "35", viewBox: "0 0 28 28" }, arrow);
    icon.style.cssText = "display:block;overflow:visible;filter:drop-shadow(0 2px 2px #211b394d);";
    const coat = svg("linearGradient", { id: "coat", x1: "0", y1: "1", x2: ".8", y2: "0" }, svg("defs", {}, icon));
    svg("stop", { offset: "0", "stop-color": "#baa9d2" }, coat);
    svg("stop", { offset: ".56", "stop-color": "#f1dcdf" }, coat);
    svg("stop", { offset: "1", "stop-color": "#ffdfbe" }, coat);
    // Cheongeum's twin crown, dark eyes and small peach smile share a silhouette with the pointer tip.
    const outline = "M0 0 10 6.8Q11.4 4.6 13.3 5.7L14.5 6.2Q15.2 2.9 17.8 4.2C22.3 6.8 25.8 13.2 26 18.1L26.1 22.6Q26.1 25.8 23.4 24.7L21.8 24Q13.8 26.8 8.5 23.1C5.9 21.3 5.1 18.1 5.4 14.2Z";
    svg("path", { d: outline, fill: "#fff", stroke: "#fff", "stroke-width": "3.5", "stroke-linejoin": "round" }, icon);
    svg("path", { d: outline, fill: "url(#coat) #f1dcdf", stroke: "#403550", "stroke-width": "1.4", "stroke-linejoin": "round" }, icon);
    const face = svg("g", { class: "face" }, icon);
    for (const cx of ["12.2", "21.1"]) svg("ellipse", { cx, cy: "15.3", rx: "1.25", ry: "1.55", fill: "#382b46" }, face);
    svg("path", { d: "M15 17.6q1.8 1.8 3.7-.1", fill: "none", stroke: "#bc6749", "stroke-width": "1.3", "stroke-linecap": "round" }, face);

    const bubble = div("position:absolute;display:none;align-items:center;gap:4px;padding:5px 7px;background:#fff7f1;"
      + "border:2px solid #493d59;border-radius:12px;box-shadow:0 2px 4px #251a3840;", shadow);
    bubble.className = "bubble";
    for (let i = 0; i < 3; i++) div("width:5px;height:5px;border-radius:50%;background:#8b709b;", bubble);
    document.documentElement.appendChild(cursor);
    // A dialog, popover or fullscreen element sits above every ordinary z-index.
    const raise = () => {
      if (!cursor.isConnected) return;
      cursor.popover = "manual";
      if (cursor.matches(":popover-open")) cursor.hidePopover();
      cursor.showPopover();
    };
    document.addEventListener("toggle", event => {
      if (event.target instanceof HTMLElement && event.target !== cursor && event.target.matches(":modal, :popover-open")) raise();
    }, true);
    document.addEventListener("fullscreenchange", raise);
    if (document.fullscreenElement !== null || document.querySelector(":modal, :popover-open") !== null) raise();
    const resize = () => {
      if (cursor.isConnected) cursor.place?.();
      else window.removeEventListener("resize", resize);
    };
    window.addEventListener("resize", resize);
  }

  const shadow = cursor.shadowRoot;
  if (shadow === null) return;
  const direction = shadow.querySelector<HTMLElement>(".direction")!;
  const arrow = shadow.querySelector<HTMLElement>(".arrow")!;
  const face = shadow.querySelector(".face")!;
  const bubble = shadow.querySelector<HTMLElement>(".bubble")!;
  cursor.animations?.forEach(animation => animation.cancel());
  const animations: Animation[] = [];
  cursor.animations = animations;
  window.clearTimeout(cursor.waitTimer);
  const play = (node: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
    const animation = node.animate(frames, options);
    animations.push(animation);
    return animation;
  };
  cursor.dataset.mode = mode;
  cursor.style.transition = calm || existing === null ? "none" : "left .42s ease-out, top .42s ease-out";
  cursor.place = () => {
    const left = Math.max(0, Math.min(x, innerWidth - 1));
    const top = Math.max(0, Math.min(y, innerHeight - 1));
    const flipX = left + 39 > innerWidth, flipY = top + 39 > innerHeight;
    cursor.style.left = left + "px";
    cursor.style.top = top + "px";
    direction.style.transform = `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`;
    face.setAttribute("transform", flipY ? "translate(0 32) scale(1 -1)" : "");
    bubble.style.left = (left > innerWidth - 82 ? -74 : 33) + "px";
    bubble.style.top = (top > innerHeight - 45 ? -32 : 19) + "px";
  };
  cursor.place();
  bubble.style.display = mode === "wait" ? "flex" : "none";

  if (mode === "wait") {
    cursor.waitTimer = window.setTimeout(() => { bubble.style.display = "none"; }, waitLimit);
    if (!calm) {
      Array.from(bubble.children).forEach((dot, i) => play(dot, [
        { transform: "none" }, { transform: "translateY(-3px)", offset: .25 }, { transform: "none", offset: .5 }, { transform: "none" },
      ], { duration: 900, delay: 350 + i * 120, iterations: Math.floor(waitLimit / 900), easing: "ease-in-out" }));
    }
  } else if (mode === "click" && !calm) {
    play(arrow, [{ transform: "none" }, { transform: "scale(.83)", offset: .4 }, { transform: "none" }],
      { duration: 320, delay: 330, easing: "ease-out" });
    const ring = div("position:absolute;left:-17px;top:-17px;width:30px;height:30px;border:2px solid #796693;border-radius:50%;opacity:0;", shadow);
    const flash = play(ring, [{ transform: "scale(.35)", opacity: .85 }, { transform: "scale(1.8)", opacity: 0 }],
      { duration: 520, delay: 360, easing: "ease-out" });
    flash.onfinish = flash.oncancel = () => ring.remove();
  }
}
