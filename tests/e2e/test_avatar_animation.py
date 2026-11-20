"""Exercise the desktop player's authored poses and WebGL context recovery."""
import pytest
from playwright.async_api import expect

from test_avatar import FAKE_OVERLAY
from test_web_ui import page, ui_url  # noqa: F401 — shared app and Chromium fixtures


async def test_interrupt_land_and_restore_current_pose(ui_url, page):
    await page.goto(ui_url + "avatar/still.png")
    await page.evaluate("""async () => {
      const { createCharacter } = await import('/avatar/character.js');
      const { AnimationMixer } = await import('/avatar/vendor/three/three.module.min.js');
      // Observe the transforms produced by the shipped mixer and model.
      const update = AnimationMixer.prototype.update;
      AnimationMixer.prototype.update = function (delta) {
        const result = update.call(this, delta);
        window.bodyRig = this.getRoot().getObjectByName('Body').parent;
        return result;
      };
      const stage = document.createElement('div');
      stage.style.cssText = 'width:146px;height:162px';
      const canvas = stage.appendChild(document.createElement('canvas'));
      document.body.replaceChildren(stage);
      window.surfaces = [];
      window.character = await createCharacter(canvas,
        (pose, clip) => { window.currentPose = { pose, clip }; },
        available => {
          surfaces.push(available);
          if (available) {
            const copy = document.createElement('canvas');
            copy.width = canvas.width;
            copy.height = canvas.height;
            const ctx = copy.getContext('2d');
            ctx.drawImage(canvas, 0, 0);
            window.restoredPixels = ctx.getImageData(0, 0, copy.width, copy.height).data
              .some((value, i) => i % 4 === 3 && value > 128);
          }
        });
      window.gpu = canvas.getContext('webgl2').getExtension('WEBGL_lose_context');
    }""")
    assert await page.evaluate("Boolean(character && gpu)")
    await page.evaluate("character.cue('welcome', 'listening'); character.pose('listening')")
    assert await page.evaluate("currentPose.clip") == "welcome"
    await page.evaluate("character.pose('auth-handoff')")
    assert await page.evaluate("currentPose.clip") == "auth-handoff"
    await page.evaluate("character.pose('complete')")
    await page.wait_for_function("currentPose.clip === 'complete' && currentPose.pose === 'still'")
    assert await page.evaluate("bodyRig.position.y") == pytest.approx(.002, abs=.001)
    assert await page.evaluate("bodyRig.scale.y") == pytest.approx(1, abs=.001)

    await page.evaluate("gpu.loseContext()")
    await page.wait_for_function("surfaces.at(-1) === false")
    await page.evaluate("character.pose('listening'); gpu.restoreContext()")
    await page.wait_for_function("surfaces.at(-1) === true")
    assert await page.evaluate("restoredPixels && character.surfaceAvailable")
    assert await page.evaluate("currentPose") == {"pose": "still", "clip": "listening"}
    await page.evaluate("character.pose('sleeping', { interrupt: true })")
    assert await page.evaluate("currentPose.pose") == "sleeping"
    await page.evaluate("character.dispose()")


async def test_bubble_reverses_mid_pop_and_preserves_the_latest_choice(ui_url, page):
    await page.emulate_media(reduced_motion="no-preference")
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    state = await page.evaluate("""() => {
      __send('prefs', {corner:'bottom-right', still:false});
      __send('visibility', {visible:true, id:1, animate:false});
      const base = {instance:'pops', connected:true, mode:'ready', capture:'off', choices:[]};
      let revision = 0;
      window.publishCard = changes => __send('snapshot', {...base, ...changes, revision:++revision});
      publishCard({message:{id:'reply', text:'정부24에서 확인할까요?'}});
      const card = document.getElementById('card');
      const skin = card.querySelector('.bubble');
      const opacity = () => Number(getComputedStyle(skin).opacity);
      const enter = skin.getAnimations()[0];
      enter.pause();
      enter.currentTime = enter.effect.getComputedTiming().duration * .28;
      const rising = opacity();
      publishCard({});
      const leaving = opacity(), closingInert = card.inert;
      const exit = skin.getAnimations()[0];
      exit.pause();
      exit.currentTime = exit.playbackRate < 0 ? exit.currentTime * .45 : exit.effect.getComputedTiming().duration * .4;
      const falling = opacity();
      publishCard({choiceSetId:'approval', prompt:'이 내용을 확인할까요?', choices:[{key:'ok',label:'확인'}]});
      return {rising, leaving, falling, renewed:opacity(), closingInert, reopenedInert:card.inert};
    }""")
    assert 0 < state["rising"] < 1
    assert state["leaving"] == pytest.approx(state["rising"], abs=.035), state
    assert 0 < state["falling"] < state["rising"]
    assert state["renewed"] == pytest.approx(state["falling"], abs=.035), state
    assert state["closingInert"] and not state["reopenedInert"]
    await page.locator(".bubble").evaluate("el => Promise.all(el.getAnimations().map(a => a.finished))")
    await expect(page.locator("#card")).to_be_visible()
    swapped = await page.evaluate("""() => {
      const oldChoice = document.querySelector('#choices button');
      publishCard({choiceSetId:'latest', prompt:'이 내용을 확인할까요?', choices:[{key:'ok',label:'확인'}]});
      oldChoice.click();
      const skin = document.querySelector('.bubble');
      return [getComputedStyle(skin).opacity, skin.getAnimations().length];
    }""")
    assert swapped == ["1", 0], "replacing a visible card should keep its surface on screen"
    await page.get_by_role("button", name="확인", exact=True).click()
    assert await page.evaluate("__calls.filter(c => c[0]==='choose')") == [["choose", "latest", "ok"]]


async def test_avatar_and_menu_reverse_together_and_honor_reduced_motion(ui_url, page):
    await page.emulate_media(reduced_motion="no-preference")
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    await page.evaluate("""() => {
      __send('prefs', {corner:'top-left', still:false});
      __send('visibility', {visible:true, id:10, animate:false});
      __send('snapshot', {instance:'visibility', revision:1, connected:true, mode:'working', busy:true,
        capture:'off', choices:[], message:{id:'reply',text:'찾고 있어요.'}});
    }""")
    await page.locator(".bubble").evaluate("el => Promise.all(el.getAnimations().map(a => a.finished))")
    mid = await page.evaluate("""() => {
      const root = document.getElementById('overlay');
      const parts = ['#avatar','.panel','#card'].map(s => document.querySelector(s));
      const opacities = () => parts.map(el => Number(getComputedStyle(el).opacity));
      __send('visibility', {visible:false, id:11, animate:true});
      const exit = root.getAnimations()[0];
      exit.pause();
      exit.currentTime = exit.effect.getComputedTiming().duration * .6;
      const fading = opacities();
      __send('visibility', {visible:true, id:12, animate:true});
      const stop = document.getElementById('stop'), button = stop.getBoundingClientRect();
      const target = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
      if (target?.closest('button') === stop) target.click();
      return {fading, reversing:opacities(), acks:__calls.filter(c => c[0]==='visibilityDone')};
    }""")
    assert all(0 < opacity < 1 for opacity in mid["fading"]), mid
    assert mid["reversing"] == pytest.approx(mid["fading"], abs=.035), mid
    assert ["visibilityDone", 11] not in mid["acks"], mid
    assert await page.evaluate("__calls.filter(c => c[0] === 'stop')") == [["stop"]]
    await page.locator("#overlay").evaluate("el => Promise.all(el.getAnimations().map(a => a.finished))")
    await expect(page.locator("#stop")).to_be_enabled()
    assert ["visibilityDone", 11] not in await page.evaluate("__calls")

    for prefs, media in ((True, "no-preference"), (False, "reduce")):
        await page.emulate_media(reduced_motion=media)
        immediate = await page.evaluate("""still => {
          __send('prefs', {corner:'top-left', still});
          __send('visibility', {visible:false, id:14, animate:true});
          __send('visibility', {visible:true, id:15, animate:true});
          return {animations:document.getElementById('overlay').getAnimations().length,
                  acks:__calls.filter(c => c[0]==='visibilityDone').slice(-2)};
        }""", prefs)
        assert immediate == {"animations": 0, "acks": [["visibilityDone", 14], ["visibilityDone", 15]]}


async def test_overlay_refits_on_display_change_and_preserves_pose_during_gpu_reset(ui_url, page):  # noqa: F811
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    prefs = {"corner": "bottom-right", "still": False}
    await page.evaluate("(p) => window.__send('prefs', p)", prefs)
    figure = page.locator("#figure")
    await expect(figure).to_have_attribute("data-renderer", "webgl")
    metrics = await page.context.new_cdp_session(page)
    for scale in (1.25, 1.5, 2, 1):
        await metrics.send("Emulation.setDeviceMetricsOverride", {
            "width": 640, "height": 400, "mobile": False, "deviceScaleFactor": scale,
        })
        await page.wait_for_function("v => window.devicePixelRatio === v", arg=scale)
        # Electron forwards display-metrics-changed even if the window keeps its CSS size.
        await page.evaluate("(p) => window.__send('prefs', p)", prefs)
        for attr, size in (("width", 146), ("height", 162)):
            await expect(page.locator("#character")).to_have_attribute(attr, str(int(size * scale + 0.5)))
    await page.evaluate("""() => {
      window.avatarGpu = document.querySelector('#character').getContext('webgl2').getExtension('WEBGL_lose_context');
      avatarGpu.loseContext();
    }""")
    await expect(figure).to_have_attribute("data-renderer", "image")
    await page.evaluate("""() => window.__send('snapshot', {
      instance:'reset', revision:1, connected:true, state:'OBSERVING', mode:'working', capture:'off', choices:[]
    })""")
    await expect(page.locator("#still")).to_have_attribute("src", "/avatar/poses/screen-reading.webp")
    await page.locator("#still").evaluate("img => img.decode()")
    await page.evaluate("avatarGpu.restoreContext()")
    await expect(figure).to_have_attribute("data-renderer", "webgl")
    await expect(figure).to_have_attribute("data-clip", "screen-reading")
