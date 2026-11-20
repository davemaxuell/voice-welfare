# Cheongeum desktop avatar and quick actions

This proposal expands the approved avatar concept with interaction details, component choices, and a validation plan.

The engineering companion traces each interaction through the desktop windows and existing backend. [Implementation and backend integration](../plans/2026-11-19-avatar-backend-integration.md)

The visual concept shows quick choices beside the avatar and the conversation after it opens. [Desktop concept image](../../ui-concepts/cheongeum-avatar-and-quick-choices.png)

## The everyday experience

Cheongeum lives near the edge of the desktop while the user works in Chrome. The 3D avatar is a recognizable place to return to. **말하기** starts voice input, and clicking the avatar opens the full conversation. When Cheongeum needs a simple decision, it shows two or three labeled buttons beside the avatar. A user can finish a short interaction there, switch to typing in the conversation, or return to the browser at any point.

| Surface | What the user sees | How they access it |
| --- | --- | --- |
| Resting avatar | A still character, **말하기**, and the microphone state | Start with **말하기** or the existing `Ctrl/Cmd+Shift+Space` shortcut. Use the tray to show or hide the avatar and to open the conversation. |
| Quick actions | One short prompt, the site or task when relevant, and up to three buttons | Click, focus the choices with the keyboard, or say a button label during an active listening turn. A proposed **선택지 보기** shortcut brings focus to the choices from Chrome. |
| Expanded conversation | The current transcript, text input, sources, and any pending decision | Click the avatar or use **대화 열기** from the tray. Closing the window returns to the desktop view with the task still in place. |

Start with a compact avatar at the lower-right of the display work area and let people choose another corner through the tray. Open the card inward from the chosen edge. Keep the browser focused when a card appears automatically. When the user deliberately opens the choices or conversation, give the requested surface focus and return to the prior surface on dismissal where the OS permits. Make the avatar easy to hide when it covers a site control. The shortcut and tray stay available while the avatar is hidden. Test this at display scaling and with more than one monitor. [Electron window interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions) · [Electron display work areas](https://www.electronjs.org/docs/latest/api/screen) · [W3C focus visibility guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)

## What the avatar communicates

| Moment | Visible behavior | Voice and control |
| --- | --- | --- |
| Ready | Still pose and **마이크 꺼짐** when capture is off | A deliberate action starts listening. Onboarding offers a sound check and teaches the shortcut using a safe practice task. |
| Listening | **듣는 중** with a clear microphone indicator | Play the existing listening cue. Keep the physical microphone indicator accurate if Cheongeum can listen for interruption while it speaks. |
| Working | A specific status such as **복지로에서 신청 방법을 찾는 중**, with **멈춰** in a stable place | Use the existing progress cue and occasional grounded update. Offer Stop through the tray and prototype a global keyboard Stop action. |
| Speaking | Subtle mouth movement and a short caption | Use the existing narration and interruption controls. Offer **다시 듣기** after a substantive answer. |
| Awaiting a choice | A stable card with one question and specific action labels | Read the choices once and offer a way to review them. Keep the decision accessible until the task resolves it. |
| Browser handoff | Site name, next step, and **마이크 꺼짐** | Announce the handoff once, then give the browser and screen reader room. Resume voice only when the user deliberately starts it again. |
| Problem or stopped | Plain text with a realistic next step | If voice input fails, offer **다시 말하기** and **직접 입력**. If the browser is unavailable, offer an official guidance link when one is available. |

Use a calm, stylized head-and-shoulders character, a fixed camera, and one small acknowledgment when an interaction begins. Use an opaque, high-contrast surface for labels and controls over any desktop background. Aim for targets at least 44 × 44 CSS pixels and keep the focus outline visible. Provide a still-avatar mode that respects the OS motion preference. Pair every meaningful animation with a text or accessible state. Reuse Cheongeum’s sound cues and test how its spoken status and screen-reader feedback interact so one event is heard clearly. [Existing sound cues](2026-11-18-sound-cues-design.md) · [W3C status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) · [W3C target sizing](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) · [W3C reduced motion guidance](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

Give each control a predictable effect. **숨기기** removes the avatar from view. **멈춰** interrupts speech and sends Stop for the active task. **이용 종료** ends the session. Report that the task has stopped once Cheongeum confirms it, and discard any quick action tied to the interrupted turn.

## How a task plays out

1. Someone says **복지로에서 신청하는 것 좀 도와줘**. While Chrome stays in view, Cheongeum offers **신청 방법 읽기** and **입력 도와주기** where the current page supports those actions. The spoken choices use the same words as the buttons.
2. The user asks for form help. If an action requires approval, the card names the action and destination. **입력 승인**, **수정**, and **취소** give the user explicit control. Sensitive values stay out of the floating card. Closing it hides the prompt while the decision stays pending. Selecting **취소** declines the pending action.
3. At a verified authentication gate, the card says **복지로에서 직접 로그인해 주세요**. Cheongeum hands off to Chrome and closes the mic. **로그인했어요** and **취소** remain available by keyboard or click while the mic is off. **로그인했어요** tells Cheongeum to check the active page and resume only if the gate has cleared. A user who wants to speak again deliberately reopens voice after the handoff.
4. At the final submission step, explain what the user needs to do on the official site. Keep the actual submission with the user. If they click the avatar at any step, the expanded view opens to that same task and shows the same pending decision.

Show cards in response to an active task or a decision the user needs to make. In an ordinary read-only turn, return to the compact avatar after the answer. Keep button order stable while the user decides. If the underlying page or pending action changes, withdraw the stale choice and explain what is available now. Cheongeum already has turn and approval identifiers to support this. [Existing web session and approval calls](../../../src/cheongeum/web/static/api.js) · [Microsoft Research on timing and correction in AI interfaces](https://www.microsoft.com/en-us/research/blog/guidelines-for-human-ai-interaction-design/) · [Pucci et al. on pairing speech with contextual web controls](https://pmc.ncbi.nlm.nih.gov/articles/PMC11246435/)

## Components that fit together

| Component | Role in Cheongeum |
| --- | --- |
| **Electron `BrowserWindow`, `screen`, tray, and `globalShortcut`** | Use a tightly bounded desktop overlay for the avatar and its card. Reuse the current app window for the expanded conversation. Check whether shortcuts register and give users the tray path when a shortcut is occupied. Test whether the overlay leaves Chrome keyboard focus and clicks intact before choosing the window styling. [Existing Electron shell](../../../apps/desktop/main.cjs) · [BrowserWindow documentation](https://www.electronjs.org/docs/latest/api/browser-window) · [Global shortcut documentation](https://www.electronjs.org/docs/latest/api/global-shortcut) |
| **Native HTML buttons and one shared session** | Keep controls in the DOM, with the 3D canvas inside a labeled conversation button. Have the desktop surfaces share a single owner for capture, speech, and task state. Send only the display state the overlay needs and route actions through the existing approval and browser handoff paths. Treat background screen-reader announcements as a behavior to verify on each OS. [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility) · [Existing state and handoff rendering](../../../src/cheongeum/web/static/app.js) |
| **Three.js, glTF and Blender** | Use `GLTFLoader` and `AnimationMixer` for a small local `.glb`. The CC0 **RobotExpressive** sample can test character scale and animation transitions. An original Cheongeum model can be exported from Blender with a few poses and a mouth control. Render a still image when motion is disabled or WebGL fails, and stop drawing frames when the character is still or hidden. [RobotExpressive demo](https://threejs.org/examples/webgl_animation_skinning_morph.html) · [Upstream model license](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/RobotExpressive/README.md) · [Three.js animation system](https://threejs.org/manual/pages/animation-system.html) · [Blender glTF export](https://docs.blender.org/manual/en/latest/addons/scene_gltf2.html) |
| **Existing TTS and Web Audio** | Use speech start and end to drive a simple speaking pose first. If closer synchronization helps, sample the amplitude of Cheongeum’s server-generated playback through Web Audio and apply it to the mouth. Keep the state-driven animation on the browser speech fallback. This is a proposal for sound-driven movement, with phoneme timing a later design question. [Current server and browser speech playback](../../../src/cheongeum/web/static/speaker.js) · [Web Audio `AnalyserNode` specification](https://www.w3.org/TR/webaudio-1.0/#AnalyserNode) |

Windows Voice Access provides a desktop precedent for making listening and command progress legible while another app is open. The web co-design study involved people with speech impairments. Its use of limited contextual choices is a pattern to test with Cheongeum’s users. The value of a moving 3D character for this audience is still a design hypothesis. [Microsoft Voice Access](https://support.microsoft.com/en-gb/accessibility/windows/voice-access/get-started-with-voice-access) · [Pucci et al., 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11246435/)

## First prototype and evaluation

Start on Windows with Chrome and synthetic data. Use a single flow that starts from the desktop, offers two choices over the practice site, pauses at a simulated login, and returns to the same task. Include a misunderstanding that the user can correct, a Stop during a slow task, and entry into the transcript mid-task. For each, observe whether the person can identify who acts next, tell when the microphone is off, and resume or cancel without help. Log accidental focus changes, repeated announcements, and any time someone must open the conversation just to choose a button.

Run the flow by mouse and keyboard, with NVDA, and by voice with the avatar hidden. Exercise laptop speakers and headphones, high contrast, reduced motion, display scaling, and monitor changes. Check the overlay and talk shortcut on macOS with VoiceOver before treating it as equivalent. Compare the still and animated avatar with identical controls to see whether movement helps people notice speech or adds distraction. The existing pilot tasks already cover follow-up, interruption, Stop, and form correction. A desktop handoff task using a simulated gate would add the missing transition. [Pilot test plan](../../user-test/plan.md) · [Existing task cards](../../user-test/tasks.md)
