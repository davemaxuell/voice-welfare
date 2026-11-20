import { AnimationMixer, LoopOnce, OrthographicCamera, PerspectiveCamera, WebGLRenderer } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { framePortrait, HOLD, PORTRAIT_HEIGHT, PORTRAIT_WIDTH } from "../web/src/avatar/character.ts";

export async function renderPosters() {
  const model = await new GLTFLoader().loadAsync("/avatar/cheongeum-avatar.glb");
  const camera = model.cameras[0], clips = new Map(model.animations.map(clip => [clip.name, clip]));
  if (!(camera instanceof PerspectiveCamera || camera instanceof OrthographicCamera)) throw Error("Missing portrait camera");
  const complete = clips.get("complete");
  if (complete === undefined) throw Error("Missing completion animation");
  framePortrait(camera);
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  const mixer = new AnimationMixer(model.scene);
  const posters: Record<string, string> = {};
  try {
    renderer.setSize(PORTRAIT_WIDTH * 2, PORTRAIT_HEIGHT * 2, false);
    for (const [name, time] of Object.entries({ ...HOLD, complete: complete.duration, speaking: 1, sleeping: 0 })) {
      const clip = clips.get(name);
      if (clip === undefined || time === undefined) throw Error("Missing portrait pose " + name);
      const action = mixer.clipAction(clip);
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      action.time = time;
      mixer.update(0);
      renderer.render(model.scene, camera);
      const type = name === "sleeping" ? "image/png" : "image/webp";
      const data = renderer.domElement.toDataURL(type, 1);
      const prefix = "data:" + type + ";base64,";
      if (!data.startsWith(prefix)) throw Error("Cannot encode " + name);
      posters[name] = data.slice(prefix.length);
      action.stop();
    }
  } finally { renderer.dispose(); }
  return posters;
}
