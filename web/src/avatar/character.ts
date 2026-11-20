// 청음 캐릭터(graphics/animations/cheongeum-avatar.glb). 상태마다 이름 붙은 동작이 있다.
// 말하기와 잠자는 숨결은 반복하고, 나머지 상태는 대표 자세에 도달하면 그리기를 멈춘다.
// WebGL이나 모델을 쓸 수 없으면 null을 돌려준다(부르는 쪽이 같은 버튼 안의 정지 그림을 쓴다).
import {
  AnimationMixer, LoopOnce, LoopRepeat, OrthographicCamera, PerspectiveCamera, WebGLRenderer,
  type AnimationAction, type AnimationClip,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL = "/avatar/cheongeum-avatar.glb";
const FADE = 0.25;
const SLEEP_FADE = 0.48;
export const PORTRAIT_WIDTH = 146;
export const PORTRAIT_HEIGHT = 162;

// Keep the seated mascot at the original scale. The taller crop adds 12 DIP
// above the square portrait for the jump and 4 below its feet for the shadow.
export function framePortrait(camera: PerspectiveCamera | OrthographicCamera) {
  camera.zoom = 1.2;
  camera.setViewOffset(PORTRAIT_WIDTH, PORTRAIT_WIDTH, 0, -12, PORTRAIT_WIDTH, PORTRAIT_HEIGHT);
}

// 상태 자세를 멈출 시각(초). 완주 동작은 착지까지 재생한 뒤 마지막 자세를 유지한다.
export const HOLD: Readonly<Partial<Record<string, number>>> = {
  ready: 0.8,
  listening: 1.66,
  thinking: 1.6,
  confirmation: 1.94,
  "screen-reading": 3.31,
  "try-again": 1.63,
  "auth-handoff": 2.37,
  stopped: 1.98,
};

export type Character = NonNullable<Awaited<ReturnType<typeof createCharacter>>>;

export async function createCharacter(canvas: HTMLCanvasElement, onPose: (pose: string, clip: string) => void, onSurface?: (available: boolean) => void) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch {
    return null;
  }
  const gltf = await new GLTFLoader().loadAsync(MODEL).catch(() => null);
  const clips = new Map<string, AnimationClip>((gltf?.animations ?? []).map((clip) => [clip.name, clip]));
  if (gltf === null || !["ready", "speaking", "sleeping"].every((name) => clips.has(name))) {
    renderer.dispose();
    return null;
  }
  const scene = gltf.scene;
  const found = gltf.cameras[0];
  const camera = found instanceof PerspectiveCamera || found instanceof OrthographicCamera ? found : new OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 10);
  framePortrait(camera);
  const mixer = new AnimationMixer(scene);
  let surfaceAvailable = !renderer.getContext().isContextLost();
  const stage = canvas.parentElement ?? canvas;
  function fitCanvas() {
    const width = Math.round(stage.clientWidth * window.devicePixelRatio);
    const height = Math.round(stage.clientHeight * window.devicePixelRatio);
    if (width === 0 || height === 0 || (canvas.width === width && canvas.height === height)) return;
    renderer.setSize(width, height, false);
    if (surfaceAvailable) renderer.render(scene, camera);
  }
  const sizeObserver = new ResizeObserver(fitCanvas);
  sizeObserver.observe(stage);
  let resolution: MediaQueryList | undefined;
  function watchResolution() {
    resolution = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    resolution.addEventListener("change", watchResolution, { once: true });
    fitCanvas();
  }
  watchResolution();

  let active: AnimationAction | undefined;
  let stopAt = Infinity;
  let then: string | undefined;
  let frame = 0;
  let drawnAt = 0;
  // Keep the weights actually on screen if a new state interrupts a transition.
  const layers = new Set<AnimationAction>();
  let blend: { elapsed: number; duration: number; weights: [AnimationAction, number][] } | null = null;

  function report() {
    const name = active?.getClip().name ?? "";
    const moving = name === "sleeping" || name === "speaking" ? name : "moving";
    onPose(frame !== 0 ? moving : "still", name);
  }

  function blendLayers(delta: number) {
    if (blend === null) return;
    blend.elapsed += delta;
    const t = Math.min(1, blend.elapsed / blend.duration);
    const eased = t * t * (3 - 2 * t);
    for (const [action, weight] of blend.weights) {
      const target = action === active ? 1 : 0;
      action.setEffectiveWeight(weight * (1 - eased) + target * eased);
      if (t === 1 && action !== active) {
        action.stop();
        layers.delete(action);
      }
    }
    if (t === 1) blend = null;
  }

  function play(name: string, { next }: { next?: string } = {}) {
    const clip = clips.get(name) ?? clips.get("ready");
    if (clip === undefined) return;
    const action = mixer.clipAction(clip);
    const crossingSleep = name === "sleeping" || [...layers].some((layer) => layer.getClip().name === "sleeping");
    // Reusing a still-visible action preserves its breathing/gesture phase on a quick reversal.
    if (!layers.has(action)) action.reset().setEffectiveWeight(layers.size > 0 ? 0 : 1);
    else if (action === active && blend === null) action.reset().setEffectiveWeight(1);
    action.paused = false;
    const loop = clip.name === "sleeping" || clip.name === "speaking";
    action.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.play();
    layers.add(action);
    blend = layers.size > 1 ? {
      elapsed: 0,
      duration: crossingSleep ? SLEEP_FADE : FADE,
      weights: [...layers].map((layer): [AnimationAction, number] => [layer, layer.getEffectiveWeight()]),
    } : null;
    active = action;
    stopAt = loop ? Infinity : Math.max(FADE, next !== undefined ? clip.duration : HOLD[clip.name] ?? clip.duration);
    then = next;
    run();
  }

  // 작은 그림이라 초당 30장이면 충분하다(주사율이 높은 화면에서 전력 아끼기)
  function tick(now: number) {
    frame = 0;
    if (document.hidden || active === undefined) return;
    const fps = active.getClip().name === "sleeping" && blend === null ? 15 : 30;
    if (now - drawnAt >= 1000 / fps) {
      const delta = Math.min(0.1, (now - (drawnAt !== 0 ? drawnAt : now)) / 1000);
      // Sample the authored hold exactly, even when a slow frame steps past it.
      if (active.time + delta >= stopAt) {
        active.time = stopAt;
        active.paused = true;
      }
      blendLayers(delta);
      mixer.update(delta);
      drawnAt = now;
      renderer.render(scene, camera);
    }
    if (active.time < stopAt || blend !== null) {
      frame = requestAnimationFrame(tick);
      return;
    }
    if (then !== undefined) { play(then); return; }
    active.paused = true;
    drawnAt = 0;
    report();
  }

  function run() {
    if (disposed || !surfaceAvailable) return;
    if (frame === 0 && !document.hidden) frame = requestAnimationFrame(tick);
    report();
  }

  let disposed = false;
  const onVisible = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      drawnAt = 0;
    } else if (active !== undefined && (!active.paused || blend !== null)) run();
  };
  document.addEventListener("visibilitychange", onVisible);
  function onContextLost(event: Event) {
    event.preventDefault();
    surfaceAvailable = false;
    cancelAnimationFrame(frame);
    frame = 0;
    drawnAt = 0;
    onSurface?.(false);
  }
  function onContextRestored() {
    // The poster has been showing the current state while the GPU was unavailable.
    if (then !== undefined) play(then);
    if (blend !== null) blendLayers(blend.duration);
    if (Number.isFinite(stopAt) && active !== undefined) {
      active.time = stopAt;
      active.paused = true;
    }
    mixer.update(0);
    renderer.render(scene, camera);
    surfaceAvailable = true;
    onSurface?.(true);
    if (active?.paused === true) report();
    else run();
  }
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  play("ready");
  return {
    refreshResolution: fitCanvas,
    get surfaceAvailable() { return surfaceAvailable; },
    /** 현재 상태에 해당하는 짧은 동작만 끝까지 재생한다. */
    pose(name: string, { interrupt = false }: { interrupt?: boolean } = {}) {
      if (then === name && !interrupt) return;
      if (active?.getClip().name !== name) play(name);
    },
    get waking() {
      return active?.getClip().name !== "sleeping" && blend?.weights.some(([layer]) => layer.getClip().name === "sleeping") === true;
    },
    /** 한 번 하는 동작(인사·음성 받음·말씀하세요 등) 뒤에 상태 자세로 */
    cue(name: string, next: string) {
      play(name, { next });
    },
    speak() {
      if (active?.getClip().name !== "speaking") play("speaking");
    },
    dispose() {
      disposed = true;
      sizeObserver.disconnect();
      resolution?.removeEventListener("change", watchResolution);
      document.removeEventListener("visibilitychange", onVisible);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      cancelAnimationFrame(frame);
      frame = 0;
      mixer.stopAllAction();
      renderer.dispose();
    },
  };
}
