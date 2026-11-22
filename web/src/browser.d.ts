// AudioWorkletGlobalScope (pcm-worklet.ts, clap-worklet.ts). The DOM library leaves these out.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor & { process(inputs: Float32Array[][]): boolean }): void;
declare const sampleRate: number;
declare const currentFrame: number;

/** Electron preload(apps/desktop/preload.cjs)가 넣는 대화 창 다리. */
interface CheongeumDesktop {
  avatarVisible?(visible?: boolean): Promise<boolean | null>;
  isDesktop?: boolean;
  showSetup?(): void;
  setAutoStart?(on: boolean): void;
  getAutoStart?(): Promise<boolean>;
  onTalk(fn: () => void): void;
  publish?(snapshot: object): void;
  onAction?(fn: (action: unknown) => void): void;
}
/** Electron overlay-preload.cjs가 넣는 아바타 창 다리. */
interface CheongeumOverlay {
  ready(): void;
  onSnapshot(fn: (snapshot: unknown) => void): void;
  onPrefs(fn: (prefs: unknown) => void): void;
  onVisibility?(fn: (state: unknown) => void): void;
  visibilityDone(id: unknown): void;
  onFocus(fn: () => void): void;
  resize(width: number, height: number, regions: { x: number; y: number; width: number; height: number }[], anchor: { x: number; y: number }): void;
  move(phase: "move" | "drop" | "cancel", x?: number, y?: number): void;
  talk(): void;
  stop(): void;
  open(focus?: string): void;
  hide(): void;
  release(): void;
  choose(choiceSetId: string, key: string): void;
}
interface Window {
  cheongeumFocusWindow?: () => Promise<void>;
  webkitAudioContext?: typeof AudioContext;
  cheongeumDesktop?: CheongeumDesktop;
  cheongeumOverlay?: CheongeumOverlay;
}
