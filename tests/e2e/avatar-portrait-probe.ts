import { AnimationMixer, Box3, LoopOnce, OrthographicCamera, PerspectiveCamera } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { framePortrait } from "../../web/src/avatar/character.ts";

export async function animationMargins() {
  const model = await new GLTFLoader().loadAsync("/avatar/cheongeum-avatar.glb");
  const camera = model.cameras[0];
  if (!(camera instanceof OrthographicCamera || camera instanceof PerspectiveCamera)) throw Error("Missing portrait camera");
  framePortrait(camera);
  const mixer = new AnimationMixer(model.scene);
  const { width, height } = document.querySelector("#figure")!.getBoundingClientRect();
  const box = new Box3(), result: Record<string, number> = {};
  for (const clip of model.animations) {
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    let margin = Infinity;
    const frames = Math.ceil(clip.duration * 30);
    for (let frame = 0; frame <= frames; frame++) {
      action.time = clip.duration * frame / frames;
      mixer.update(0);
      model.scene.updateMatrixWorld(true);
      box.setFromObject(model.scene, true);
      const low = box.min.clone().project(camera), high = box.max.clone().project(camera);
      margin = Math.min(margin, (1 + low.x) * width / 2, (1 - high.x) * width / 2,
        (1 + low.y) * height / 2, (1 - high.y) * height / 2);
    }
    result[clip.name] = margin;
    action.stop();
  }
  return result;
}
