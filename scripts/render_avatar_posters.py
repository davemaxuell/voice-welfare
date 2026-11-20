"""Render the desktop mascot's motion-free portraits. Run with uv run python scripts/render_avatar_posters.py."""

import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


STATIC = Path(__file__).resolve().parents[1] / "src/cheongeum/web/static"
RENDER = """async () => {
    const { framePortrait, HOLD, PORTRAIT_WIDTH, PORTRAIT_HEIGHT } = await import('/avatar/character.js');
    const THREE = await import('/avatar/vendor/three/three.module.min.js');
    const { GLTFLoader } = await import('/avatar/vendor/three/GLTFLoader.js');
    const model = await new GLTFLoader().loadAsync('/avatar/cheongeum-avatar.glb');
    const clips = new Map(model.animations.map(clip => [clip.name, clip]));
    const camera = model.cameras[0];
    framePortrait(camera);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(PORTRAIT_WIDTH * 2, PORTRAIT_HEIGHT * 2, false);
    const mixer = new THREE.AnimationMixer(model.scene);
    const posters = {};
    for (const [name, time] of Object.entries({ ...HOLD, complete: clips.get('complete').duration, speaking: 1, sleeping: 0 })) {
        const action = mixer.clipAction(clips.get(name));
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        action.time = time;
        mixer.update(0);
        renderer.render(model.scene, camera);
        // The desktop applies its own horizontal flip to both the canvas and these images.
        const type = name === 'sleeping' ? 'image/png' : 'image/webp';
        const data = renderer.domElement.toDataURL(type, 1);
        if (!data.startsWith('data:' + type + ';base64,')) throw new Error('Cannot encode ' + name);
        posters[name] = data.split(',')[1];
        action.stop();
    }
    renderer.dispose();
    return posters;
}"""


class AssetHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    with ThreadingHTTPServer(("127.0.0.1", 0), partial(AssetHandler, directory=STATIC)) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
                page = browser.new_page()
                # Establish a local origin without starting the desktop controller.
                page.goto(f"http://127.0.0.1:{server.server_port}/avatar/still.png")
                posters = page.evaluate(RENDER)
                browser.close()
        finally:
            server.shutdown()
    target = STATIC / "avatar"
    (target / "poses").mkdir(exist_ok=True)
    for name, data in posters.items():
        path = target / ("sleeping.png" if name == "sleeping" else f"poses/{name}.webp")
        path.write_bytes(base64.b64decode(data, validate=True))
        print(path.relative_to(STATIC))


if __name__ == "__main__":
    main()
