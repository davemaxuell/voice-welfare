"""데스크톱 아바타(헤드리스): 대화 창이 보내는 표시 상태와 아바타 페이지를 가짜 데스크톱 연결로 확인한다.
실제 Electron 창·초점·전역 단축키는 apps/desktop/test/(avatar.e2e.cjs, native-a11y.cjs)에서 본다."""
import asyncio
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest_asyncio
import uvicorn
from conftest import create_test_runtime
from playwright.async_api import expect
from test_web_ui import FAKE_SPEECH, free_port, page, serve_js, ui_url  # noqa: F401 — 같은 서버·브라우저 픽스처

from cheongeum.server import close_all, create_app
from cheongeum.server.app import mount_web_ui

AXE = (Path(__file__).resolve().parents[2] / "scripts" / "vendor" / "axe.min.js").read_text(encoding="utf-8")

# 대화 창 쪽 데스크톱 연결(preload.cjs와 같은 이름): 보낸 상태를 모으고, 메인 프로세스 대신 동작을 넣는다.
FAKE_DESKTOP = """
window.__published = [];
window.cheongeumDesktop = {
  isDesktop: true,
  onTalk() {},
  publish: (s) => window.__published.push(JSON.parse(JSON.stringify(s))),
  onAction: (cb) => { window.__act = cb; },
};
"""

# 아바타 창 쪽 연결(overlay-preload.cjs와 같은 이름)
FAKE_OVERLAY = """
window.__calls = [];
const handlers = {};
const call = (name) => (...args) => window.__calls.push([name, ...args]);
window.cheongeumOverlay = {
  ready() {
    call('ready')();
    handlers.visibility?.({visible:true, id:0, animate:false});
  },
  resize: call('resize'), talk: call('talk'), stop: call('stop'), open: call('open'),
  hide: call('hide'), release: call('release'), choose: call('choose'), visibilityDone: call('visibilityDone'),
  onSnapshot: (cb) => { handlers.snapshot = cb; },
  onPrefs: (cb) => { handlers.prefs = cb; },
  onFocus: (cb) => { handlers.focus = cb; },
  onVisibility: (cb) => { handlers.visibility = cb; },
};
window.__send = (kind, value) => handlers[kind](value);
"""


async def latest(page):
    return await page.evaluate("window.__published.at(-1)")


async def test_all_animation_frames_fit_the_desktop_portrait(ui_url, page):  # noqa: F811
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    await page.evaluate("window.__send('prefs', {corner:'top-right', still:true})")
    bounds = await page.evaluate("""async () => {
      const THREE = await import('/avatar/vendor/three/three.module.min.js');
      const { GLTFLoader } = await import('/avatar/vendor/three/GLTFLoader.js');
      const { framePortrait } = await import('/avatar/character.js');
      const model = await new GLTFLoader().loadAsync('/avatar/cheongeum-avatar.glb');
      const camera = model.cameras[0];
      framePortrait(camera);
      const mixer = new THREE.AnimationMixer(model.scene);
      const {width, height} = document.querySelector('#figure').getBoundingClientRect();
      const box = new THREE.Box3(), result = {};
      for (const clip of model.animations) {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
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
          margin = Math.min(margin, (1+low.x)*width/2, (1-high.x)*width/2,
                            (1+low.y)*height/2, (1-high.y)*height/2);
        }
        result[clip.name] = margin;
        action.stop();
      }
      return result;
    }""")
    assert {"complete", "sleeping", "speaking", "ready"} <= bounds.keys()
    assert all(margin >= 3 for margin in bounds.values()), bounds


async def test_static_poses_match_the_frame_and_ground_line(ui_url, page):  # noqa: F811
    await page.add_init_script(FAKE_OVERLAY)
    await page.emulate_media(reduced_motion="reduce")
    await page.goto(ui_url + "avatar/")
    base = {"connected": True, "instance": "posters", "mode": "ready", "state": "IDLE",
            "capture": "off", "choices": [], "status": "", "speaking": False}
    cases = [
        ("ready", {}), ("sleeping", {"sleeping": True}), ("listening", {"mode": "listening"}),
        ("thinking", {"mode": "working"}), ("speaking", {"speaking": True}),
        ("confirmation", {"state": "NEEDS_CLARIFICATION"}), ("auth-handoff", {"mode": "auth-handoff"}),
        ("screen-reading", {"state": "OBSERVING", "mode": "working"}),
        ("screen-reading", {"state": "BROWSING", "reading": True}), ("try-again", {"state": "VALIDATION_ERROR"}),
        ("stopped", {"state": "PAUSED"}), ("complete", {"state": "DONE"}),
    ]
    feet = {}
    for revision, (pose, changes) in enumerate(cases, 1):
        await page.evaluate("(s) => window.__send('snapshot', s)", {**base, **changes, "revision": revision})
        image = page.locator("#figure img:visible")
        await expect(image).to_have_count(1)
        result = await image.evaluate("""async img => {
          await img.decode();
          const {width, height} = img.getBoundingClientRect();
          const c = document.createElement('canvas');
          c.width=width; c.height=height;
          const ctx=c.getContext('2d');
          ctx.drawImage(img,0,0,width,height);
          const pixels=ctx.getImageData(0,0,width,height).data;
          let foot = -1;
          for (let i=3; i<pixels.length; i+=4) {
            if (pixels[i]>32) foot=Math.floor((i/4)/width);
          }
          return {src:img.getAttribute('src'), width, height, w:img.naturalWidth, h:img.naturalHeight, foot};
        }""")
        assert result["src"].endswith(f"/{pose}." + ("png" if pose == "sleeping" else "webp"))
        assert result["w"] * result["height"] == result["h"] * result["width"], result
        assert result["foot"] > 0, pose
        feet[pose] = result["foot"]
    assert abs(feet["ready"] - feet["sleeping"]) <= 2, feet
    assert abs(feet["complete"] - feet["ready"]) <= 2, feet


async def test_controller_cards_carry_no_values_and_dispatch_once(ui_url, page):  # noqa: F811
    await page.add_init_script(FAKE_DESKTOP)
    confirms: list[str] = []
    page.on("request", lambda r: confirms.append(r.url) if r.url.endswith("/confirm") else None)
    await page.goto(ui_url + "?desktop=1")
    consent = await page.wait_for_function("window.__published.find((s) => s.choices.some((c) => c.key === 'consent-yes'))")
    card = await consent.json_value()
    assert [c["label"] for c in card["choices"]] == ["동의하고 음성 대화 시작", "동의하지 않음", "안내 보기"]
    consents: list[str] = []
    page.on("request", lambda r: consents.append(r.url) if r.url.endswith("/consent") else None)
    # 카드를 두 번 눌러도(바쁨 표시가 없는 결정) 동의는 한 번만 나간다
    await page.evaluate("(id) => { window.__act({ type: 'choose', choiceSetId: id, key: 'consent-yes' }); window.__act({ type: 'choose', choiceSetId: id, key: 'consent-yes' }); }", card["choiceSetId"])
    await expect(page.locator("#consent-panel")).to_be_hidden()
    await expect(page.locator("#log")).to_contain_text("동의해 주셔서 감사합니다")
    assert len(consents) == 1, consents

    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("127.0.0.1:5174/external.html 열어줘")
    await box.press("Enter")
    await expect(page.locator("#st-access")).to_contain_text("읽기 전용")
    await box.fill("이름 칸에 김하늘 써줘")
    await box.press("Enter")
    await expect(page.get_by_role("button", name="입력 승인")).to_be_enabled()
    approval = await latest(page)
    assert approval["mode"] == "choice"
    assert [c["label"] for c in approval["choices"]] == ["입력 승인", "내용 확인", "취소"]
    assert approval["prompt"] == "입력란을 채울까요?"
    published = json.dumps(await page.evaluate("window.__published"), ensure_ascii=False)
    assert "김하늘" not in published, "typed values never reach the avatar"
    assert "actionId" not in published, "server references stay in the conversation window"
    prior_messages = await page.evaluate("window.__published.map(s => s.message?.id).filter(Boolean)")

    await page.evaluate(
        "(id) => { window.__act({ type: 'choose', choiceSetId: id, key: 'approve' }); window.__act({ type: 'choose', choiceSetId: id, key: 'approve' }); }",
        approval["choiceSetId"],
    )
    await expect(page.locator("#confirm-panel")).to_be_hidden()
    await expect(page.locator("#fields")).to_contain_text("입력됨: 김하늘")
    assert len(confirms) == 1, confirms
    reply = await page.wait_for_function("""ids => window.__published.find(s =>
        !s.busy && !s.choices.length && s.message?.text && s.message.id && !ids.includes(s.message.id))""", arg=prior_messages)
    assert set((await reply.json_value())["message"]) == {"id", "text"}
    assert "김하늘" not in json.dumps(await page.evaluate("window.__published"), ensure_ascii=False), (
        "the approval result must also keep the entered value out of the always-on-top window"
    )

    await page.evaluate("(id) => window.__act({ type: 'choose', choiceSetId: id, key: 'approve' })", approval["choiceSetId"])
    await expect(page.locator("#log")).to_contain_text("선택지가 바뀌었어요")
    assert len(confirms) == 1, "a stale card sends nothing"
    await page.locator("#stop-all").click()
    await page.wait_for_function("window.__published.at(-1)?.state === 'STOPPED'")
    stopped = await latest(page)
    assert stopped["message"] is None, "stop clears the previous reply"
    assert stopped["sleeping"] is True
    await box.fill("장애인연금 지원 대상이 누구야?")
    async with page.expect_response(lambda response: response.url.endswith("/api/turn")) as first_request:
        await box.press("Enter")
    await page.wait_for_function("rev => window.__published.some(s => s.revision > rev && s.sleeping === false)", arg=stopped["revision"])
    answer = await (await first_request.value).json()
    assert answer["state"] != "STOPPED", answer["speech"]
    assert answer["answerCard"]["grounded"] and re.search(r"18세|십팔\s*세|열여덟", answer["speech"]), answer["speech"]
    await expect(page.locator("#log li").last).to_contain_text(answer["speech"])


async def test_avatar_page_renders_cards_as_text_and_passes_axe(ui_url, page):  # noqa: F811
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    await page.evaluate("window.__send('prefs', { corner: 'bottom-right', still: true })")
    base = {"connected": True, "instance": "a", "capture": "off", "speaking": False, "busy": False, "lang": "ko", "site": None, "pending": False}
    await page.evaluate("(s) => window.__send('snapshot', s)", {
        **base, "revision": 2, "mode": "choice", "status": "선택을 기다리고 있어요.", "prompt": "<b>누르기</b>", "site": "127.0.0.1:5174",
        "choiceSetId": "a-1", "choices": [{"key": "approve", "label": "<i>입력 승인</i>"}, {"key": "review", "label": "내용 확인", "open": "confirm"}, {"key": "reject", "label": "취소"}],
    })
    await expect(page.locator("#card-prompt")).to_have_text("<b>누르기</b>")
    await expect(page.get_by_role("button", name="<i>입력 승인</i>")).to_be_visible()
    await expect(page.locator("#card-site")).to_have_text("대상: 127.0.0.1:5174")

    # 순서가 앞선(번호가 작은) 상태는 버린다
    await page.evaluate("(s) => window.__send('snapshot', s)", {**base, "revision": 1, "mode": "ready", "status": "기다리고 있어요.", "prompt": None, "choiceSetId": None, "choices": []})
    await expect(page.locator("#card")).to_be_visible()

    await page.get_by_role("button", name="<i>입력 승인</i>").click()
    await page.get_by_role("button", name="내용 확인").click()
    calls = await page.evaluate("window.__calls.filter((c) => c[0] === 'choose' || c[0] === 'open')")
    assert calls == [["choose", "a-1", "approve"], ["open", "confirm"]]

    await page.evaluate("(s) => window.__send('snapshot', s)", {**base, "revision": 3, "mode": "choice", "status": "선택을 기다리고 있어요.", "prompt": "누르기", "choiceSetId": "a-1",
                                                               "pending": True, "choices": [{"key": "approve", "label": "입력 승인"}, {"key": "review", "label": "내용 확인", "open": "confirm"}]})
    await expect(page.get_by_role("button", name="<i>입력 승인</i>")).to_be_disabled()
    await expect(page.get_by_role("button", name="내용 확인")).to_be_enabled()

    await page.add_script_tag(content=AXE)
    for snapshot in (
        {**base, "revision": 4, "mode": "auth-handoff", "status": "사이트에서 직접 진행해 주세요.", "prompt": "localhost:5174에서 직접 로그인해 주세요.",
         "choiceSetId": "a-2", "choices": [{"key": "auth-done", "label": "로그인했어요"}, {"key": "auth-cancel", "label": "인증 취소"}]},
        {**base, "revision": 5, "mode": "speaking", "capture": "on", "speaking": True, "status": "말하는 중이에요.", "prompt": None, "choiceSetId": None, "choices": []},
        {"connected": False},
    ):
        await page.evaluate("(s) => window.__send('snapshot', s)", snapshot)
        result = await page.evaluate("() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })")
        assert result["violations"] == [], [(v["id"], v["help"]) for v in result["violations"]]
        assert len(result["passes"]) >= 5, "axe checked the page"
    await expect(page.locator("#mic-text")).to_have_text("마이크 꺼짐")
    await expect(page.get_by_role("button", name="말하기")).to_be_disabled()

    # 동의 카드 동안 말하기 버튼은 동의가 아니다: 눌리지 않는다
    await page.evaluate("(s) => window.__send('snapshot', s)", {**base, "instance": "b", "revision": 1, "mode": "consent", "status": "시작 전에 동의가 필요해요.", "prompt": "시작 전 안내를 듣고 동의해 주세요.",
                                                               "choiceSetId": "b-1", "choices": [{"key": "consent-yes", "label": "동의하고 음성 대화 시작"}]})
    await expect(page.get_by_role("button", name="말하기")).to_be_disabled()
    # 마이크를 끄고 기다릴 때는 캐릭터만 앞에 두고, 다음 선택지가 오면 카드를 펼친다.
    idle = await page.evaluate("""async () => (await import('/companion.js')).desktopView(
        {sessionId: 's', consent: 'granted', state: 'IDLE'}, {capture: 'off', speaking: false})""")
    await page.evaluate("(s) => window.__send('snapshot', s)", {**idle, "instance": "b", "revision": 2})
    await expect(page.locator("#card")).to_be_hidden()
    # 다른 일을 처리하는 중이면 선택지를 누를 수 없다(누르면 아무 일 없는 버튼을 두지 않음)
    await page.evaluate("(s) => window.__send('snapshot', s)", {**base, "instance": "b", "revision": 3, "mode": "choice", "busy": True, "status": "처리하는 중이에요.", "prompt": "버튼을 누를까요?",
                                                               "choiceSetId": "b-2", "choices": [{"key": "approve", "label": "누르기 승인"}, {"key": "review", "label": "내용 확인", "open": "confirm"}]})
    await expect(page.get_by_role("button", name="누르기 승인")).to_be_disabled()
    await expect(page.get_by_role("button", name="내용 확인")).to_be_enabled()


async def test_avatar_keeps_its_transparent_stopped_pose_in_every_corner(ui_url, page):  # noqa: F811
    await page.emulate_media(reduced_motion="reduce")
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    base = {
        "connected": True, "capture": "off", "speaking": False, "busy": False,
        "choices": [], "lang": "ko", "status": "기다리고 있어요.", "message": None,
    }
    measure = """() => {
        const figure = document.getElementById('figure');
        const { x, y, width, height } = figure.getBoundingClientRect();
        const painted = [];
        for (let node = figure; node; node = node.parentElement) {
            const css = getComputedStyle(node);
            if (css.backgroundColor !== 'rgba(0, 0, 0, 0)' || css.backgroundImage !== 'none') {
                painted.push(node.id || node.tagName);
            }
        }
        return { x, y, width, height, painted };
    }"""
    for corner in ("bottom-right", "top-right", "bottom-left", "top-left"):
        await page.evaluate("(corner) => window.__send('prefs', { corner, still: true })", corner)
        stopped = {**base, "instance": corner, "revision": 1, "mode": "ready", "state": "STOPPED", "resting": True}
        await page.evaluate("(s) => window.__send('snapshot', s)", stopped)
        reference = await page.evaluate(measure)
        assert reference["painted"] == []
        assert reference["width"] >= 120 and reference["height"] >= 100, "keep the full-sized stopped avatar"

        for revision, mode in enumerate(
            ("starting", "consent", "working", "speaking", "listening", "choice", "auth-handoff", "problem", "ended", "offline"), start=2
        ):
            has_choices = mode in ("consent", "choice", "auth-handoff")
            changes = {
                "instance": corner, "revision": revision, "mode": mode, "connected": mode != "offline",
                "busy": mode == "working", "speaking": mode == "speaking", "capture": "on" if mode == "listening" else "off",
                "choiceSetId": str(revision) if has_choices else None,
                "choices": [{"key": "review", "label": "내용 확인", "open": "confirm"}] if has_choices else [],
                "prompt": "이 내용을 확인할까요?" if has_choices else None,
            }
            await page.evaluate("(s) => window.__send('snapshot', s)", {**base, **changes})
            await expect(page.locator("#overlay")).to_have_attribute("data-mode", mode)
            assert await page.evaluate(measure) == reference, f"the figure moved or gained a backdrop in {mode} at {corner}"
            if has_choices:
                card = await page.locator("#card").bounding_box()
                assert card and 0 <= card["x"] and 0 <= card["y"]
                # The head includes transparent padding inside the portrait, so measure the painted image.
                silhouette_top = await page.locator("#figure img:visible").evaluate("""async img => {
                    await img.decode();
                    const frame = img.getBoundingClientRect();
                    const canvas = document.createElement('canvas');
                    canvas.width = frame.width;
                    canvas.height = frame.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                    const first = pixels.findIndex((v, i) => i % 4 === 3 && v > 32);
                    if (first < 0) throw Error('Empty mascot image');
                    return frame.top + Math.floor(first / 4 / canvas.width);
                }""")
                tip = await page.locator(".bubble").evaluate("""el => {
                    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
                    const tail = getComputedStyle(el, '::after'), matrix = new DOMMatrix(tail.transform);
                    const w = parseFloat(tail.width), h = parseFloat(tail.height);
                    return {
                        x: box.left + parseFloat(style.borderLeftWidth) + parseFloat(tail.left) + w / 2 + matrix.e,
                        y: box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(tail.bottom) - h / 2
                           + matrix.f + (Math.abs(matrix.b) * w + Math.abs(matrix.d) * h) / 2,
                    };
                }""")
                gap = silhouette_top - tip["y"]
                assert 2 <= gap <= 21, (mode, corner, gap)
                assert abs(tip["x"] - reference["x"] - reference["width"] / 2) <= 2, (mode, corner, tip)


async def test_long_choice_scrolls_inside_the_bubble_on_a_short_display(ui_url, page):
    await page.set_viewport_size({"width": 320, "height": 316})
    await page.emulate_media(reduced_motion="reduce")
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    for corner in ("top-left", "bottom-right"):
        await page.evaluate("""corner => {
          __send('prefs', {corner, maxWidth:320, maxHeight:316, still:true});
          __send('snapshot', {instance:corner, revision:1, connected:true, mode:'choice', capture:'off',
            lang:'ko', prompt:'신청 내용을 확인해 주세요. '.repeat(20), choiceSetId:corner,
            choices:[{key:'review',label:'서류 검토'},{key:'ok',label:'확인'}]});
        }""", corner)
        bubble = page.locator(".bubble-body")
        assert await bubble.evaluate("el => el.scrollHeight > el.clientHeight")
        dock = await page.locator(".dock").bounding_box()
        card = await page.locator("#card").bounding_box()
        assert 0 <= card["y"] and card["y"] + card["height"] < dock["y"] + 30
        assert 0 <= dock["x"] and dock["x"] + dock["width"] <= 320
        assert dock["y"] + dock["height"] <= 316
        await page.get_by_role("button", name="확인", exact=True).click()
        assert await page.evaluate("window.__calls.filter(c=>c[0]==='choose').at(-1)") == ["choose", corner, "ok"]


async def test_message_bubbles_expire_once_and_choices_stay_available(ui_url, page):  # noqa: F811
    await page.clock.install()
    await page.emulate_media(reduced_motion="reduce")
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    await page.evaluate("window.__send('prefs', { corner: 'bottom-right', still: true })")
    message = {"id": "reply-1", "text": "<b>정부24에서 확인할 수 있어요.</b>"}
    base = {
        "connected": True, "instance": "first", "mode": "ready", "lang": "ko", "capture": "off",
        "speaking": False, "busy": False, "status": "기다리고 있어요.", "choices": [], "message": message,
    }
    async def publish(revision, **changes):
        await page.evaluate("(s) => window.__send('snapshot', s)", {**base, "revision": revision, **changes})

    balloon = page.locator("#card")
    await publish(1)
    await expect(balloon).to_be_visible()
    await expect(balloon).to_contain_text(message["text"])
    await expect(balloon.locator("b")).to_have_count(0)
    await expect(page.locator("#choices button")).to_have_count(0)

    await balloon.hover()
    await page.clock.fast_forward(120_000)
    await expect(balloon).to_be_visible()
    await page.locator("#avatar").hover()
    await page.clock.fast_forward(120_000)
    await expect(balloon).to_be_hidden()
    await publish(2, mode="listening", capture="on")
    await expect(balloon).to_be_hidden()

    await publish(3, message={**message, "id": "reply-2"})
    await expect(balloon).to_be_visible()
    await publish(4, mode="choice", choiceSetId="set-1", prompt="계속할까요?", choices=[{"key": "ok", "label": "계속"}])
    await expect(balloon).to_contain_text("계속할까요?")
    await expect(balloon).not_to_contain_text(message["text"])
    await page.clock.fast_forward(120_000)
    choice = page.get_by_role("button", name="계속", exact=True)
    await expect(choice).to_be_visible()
    await page.evaluate("window.__send('focus')")
    await expect(choice).to_be_focused()
    await choice.press("Enter")
    assert await page.evaluate("window.__calls.filter(c => c[0] === 'choose')") == [["choose", "set-1", "ok"]]


async def test_sleep_wake_keeps_the_first_action_and_respects_reduced_motion(ui_url, page):  # noqa: F811
    await page.emulate_media(reduced_motion="reduce")
    await page.add_init_script(FAKE_OVERLAY)
    await page.goto(ui_url + "avatar/")
    await page.evaluate("window.__send('prefs', {corner: 'bottom-right', still: false})")
    base = {
        "connected": True, "instance": "sleep", "mode": "ready", "state": "STOPPED",
        "capture": "off", "speaking": False, "busy": False, "lang": "ko", "choices": [], "status": "멈췄어요.",
    }
    async def publish(revision, **changes):
        await page.evaluate("(s) => window.__send('snapshot', s)", {**base, "revision": revision, **changes})

    figure = page.locator("#figure")
    picture = figure.locator("img:visible")
    await publish(1, state="IDLE", sleeping=False)
    awake = await picture.evaluate("(img) => img.src")
    await publish(2, mode="speaking", speaking=True, sleeping=True)
    await expect(figure).to_have_attribute("data-sleeping", "true")
    await expect(figure).to_have_attribute("data-pose", "still")
    await picture.evaluate("(img) => img.decode()")
    assert await picture.evaluate("(img) => img.getAnimations().length") == 0
    asleep = await picture.evaluate("(img) => img.src")
    assert asleep != awake
    await publish(3, sleeping=True)
    assert await picture.evaluate("(img) => img.src") == asleep

    await page.get_by_role("button", name="말하기").press("Enter")
    assert await page.evaluate("window.__calls.filter(c => c[0] === 'talk')") == [["talk"]]
    await publish(4, mode="listening", capture="on", sleeping=False)
    await expect(figure).to_have_attribute("data-sleeping", "false")
    assert (await picture.get_attribute("src")).endswith("/poses/listening.webp")
    await publish(5, sleeping=True)
    await expect(figure).to_have_attribute("data-sleeping", "true")
    await publish(6, state="IDLE", sleeping=False)
    await expect(figure).to_have_attribute("data-sleeping", "false")
    await expect(figure).to_have_attribute("data-renderer", "image")
    assert await picture.evaluate("(img) => img.src") == awake


class SaidStt:
    """녹음 대신 글자를 보내는 받아쓰기(바로 돌려준다)."""

    name = "test-said"
    supported = True
    localLanguages = ["ko"]

    async def transcribe(self, audio: bytes, *, language: str, mime_type: str, signal=None) -> dict:
        return {"text": audio.decode().strip()}


@pytest_asyncio.fixture
async def said_ui_url():
    rt = create_test_runtime({"REQUIRE_CONSENT": "true"})
    app, sessions = create_app(rt, voice=SimpleNamespace(stt=SaidStt(), tts=rt.tts))
    mount_web_ui(app)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="off"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}/"
    server.should_exit = True
    await task
    await close_all(sessions)
    await rt.close()


# 마이크 대신: 듣기를 시작하면 window.__listening = true, window.__say(글)이 그 발화를 끝낸다.
SAY_MIC = """
export const browserStt = { supported: false, listen() { return () => {}; } };
export async function startRecording() { throw new Error('no mic'); }
export async function listMicrophones() { return []; }
export function preferredMicrophone() { return undefined; }
export class VoiceLoop {
  async start() {}
  get deviceLabel() { return '시험 마이크'; }
  async isSilent() { return false; }
  async startClapDetector() {}
  listenOnce() {
    return new Promise((resolve) => {
      this.pending = resolve;
      window.__listening = true;
      window.__say = (text) => { window.__listening = false; this.pending = undefined; resolve(new Blob([text.padEnd(300, ' ')], { type: 'audio/webm' })); };
    });
  }
  cancelListening() { window.__listening = false; this.pending?.(null); this.pending = undefined; }
  watchBargeIn() { return () => {}; }
  async listenAfterBarge() { return null; }
  endUtterance() {}
  stop() { this.cancelListening(); }
}
"""


@pytest_asyncio.fixture
async def voice_page(said_ui_url, page):  # noqa: F811
    await page.route(lambda url: str(url).endswith("/mic.js"), serve_js(SAY_MIC))
    await page.route(lambda url: str(url).endswith("/speaker.js"), serve_js(FAKE_SPEECH))
    await page.add_init_script("window.__speakMs = 50;")
    await page.goto(said_ui_url)
    await page.get_by_role("button", name="안내 듣고 시작하기 (Enter)").click()
    await page.get_by_role("button", name="동의하고 시작 (Enter)").click()
    await page.wait_for_function("window.__listening === true")
    return page


async def test_first_spoken_request_after_stop_opens_the_requested_form(voice_page):
    page = voice_page
    async with page.expect_response(lambda response: response.url.endswith("/cancel")) as stopped:
        await page.locator("#stop-all").click()
    assert (await (await stopped.value).json())["state"] == "STOPPED"
    await page.wait_for_function("window.__listening === false")
    await page.locator("#conv-start").click()
    await page.wait_for_function("window.__listening === true")
    async with page.expect_response(lambda response: "/api/audio/turn?" in response.url) as spoken:
        await page.evaluate("window.__say('장애인연금 신청 도와줘')")
    answer = await (await spoken.value).json()
    assert answer["state"] == "APPLICATION_OPEN", answer["speech"]
    await expect(page.locator("#fields")).to_contain_text("성명")


async def test_voice_approval_binds_to_the_decision_shown_when_listening_began(voice_page):
    """듣기 시작 뒤에 새로 뜬 승인은 그 말('응')로 승인되지 않는다. 다음 듣기부터는 그 승인에 묶인다."""
    page = voice_page

    box = page.get_by_label("명령 입력 (말하듯이 입력하세요)")
    await box.fill("127.0.0.1:5174/external.html 열어줘")
    await box.press("Enter")
    await expect(page.locator("#st-access")).to_contain_text("읽기 전용")
    await box.fill("이름 칸에 김하늘 써줘")
    await box.press("Enter")
    await expect(page.get_by_role("button", name="입력 승인")).to_be_enabled()

    await page.evaluate("window.__say('응')")
    await expect(page.locator("#log")).to_contain_text("확인할 작업이 바뀌었어요")
    await expect(page.locator("#fields")).not_to_contain_text("입력됨: 김하늘")

    await page.wait_for_function("window.__listening === true")
    await page.evaluate("window.__say('응')")
    await expect(page.locator("#fields")).to_contain_text("입력됨: 김하늘", timeout=20000)
