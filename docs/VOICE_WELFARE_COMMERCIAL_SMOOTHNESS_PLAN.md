# Cheongeum (`voice-welfare`) — Commercial Desktop Smoothness & UX Improvement Plan

> **Implementation-ready engineering brief** · Reviewed **2026-11-21** · Repository: [davemaxuell/voice-welfare](https://github.com/davemaxuell/voice-welfare) · Reference commit: [`bd096bb`](https://github.com/davemaxuell/voice-welfare/commit/bd096bb8085f3eaaab67d8bd89e7508edf66398d)
>
> **Purpose:** Improve perceived speed, fluidity, reliability, accessibility, and maintainability of the **existing** Cheongeum desktop voice agent. This is a guide for incremental implementation, not an instruction to redesign or rewrite the product.
>
> **Evidence standard:** This document is based on reading the linked GitHub repository, selected source files, tests, and project documentation. **I did not run the app, profiler, native accessibility tests, or performance benchmarks.** Where a slowdown or bug is not reproduced, the item is explicitly labeled a **hypothesis to measure**. Numerical budgets are **proposed targets**, not observed results.

---

## 1. Product goal and non-negotiable constraints

Cheongeum (`청음`) is a speech-first assistant for Korean public services, particularly people who may struggle with digital interfaces, including older adults and blind or low-vision users. Its desktop experience must be understandable **with audio alone**, with visible UI providing an equivalent—not privileged—path.

A commercial-quality experience here means:

1. **Instant acknowledgement**: the app responds immediately when a user speaks, clicks, presses Stop, or requests help.
2. **Truthful state**: it never implies that it is listening, has completed an action, or has submitted an application unless that state is confirmed.
3. **Responsive while working**: AI requests, browser navigation, audio processing, and application packaging do not freeze the interactive shell.
4. **Recoverable workflows**: lost connections, slow sites, cancelled tasks, or manual authentication never produce silent failure or duplicated consequential actions.
5. **Accessible motion and sound**: animations clarify state but are never required to understand it; screen readers, keyboard users, and reduced-motion settings remain fully supported.
6. **Consistent multilingual interaction**: language changes do not break Stop, consent, focus, or current task context.

### Safety invariants — preserve exactly

- Preserve the existing **consent-before-collection** and privacy/redaction behavior.
- Preserve **PolicyGuard**, site restrictions, grounding verification, and protection from untrusted page instructions.
- Preserve the distinction between **practice submission** and a **real government submission**. Do not automate real submissions, passwords, identity verification, or CAPTCHAs.
- Maintain the existing **approval fingerprint / expiry / stale choice** logic. A faster UI must **never** double-execute an action.
- Keep **Stop** high priority and idempotent. Do not delay cancellation for an animation or network reply.
- Preserve the **single conversation controller**: the Electron avatar overlay displays state and sends narrowly scoped choices, but must not own a duplicate microphone, conversation, or agent session.
- **Do not edit** `src/evaluation/data/demo_scenarios.json` to make metrics pass.
- Read `CLAUDE.md`, `port-manifest.json`, and relevant fixtures before changing public contracts or behavior.
- Keep user-facing copy and code comments in **Korean** unless existing project conventions indicate otherwise. This specification is in English for the engineering team.

---

## 2. Existing stack — do not migrate unnecessarily

The inspected code already uses:

| Existing layer | Verified evidence | Decision |
|---|---|---|
| Desktop runtime | `apps/desktop/src/main.ts`: Electron 45, utility process, tray, overlay IPC, global shortcuts | **Keep Electron**. Do not migrate to Tauri/Flutter for perceived smoothness alone. |
| UI | `web/src/App.tsx`, `web/src/conversation.ts`: React 19, TypeScript, external UI store | **Keep React + TypeScript**. Profile update granularity. |
| Build | `vite.config.ts`, `package.json`: Vite, separate main/overlay entry points | Keep Vite. Measure build outputs and real loading. |
| Styling and motion | `web/src/styles.css`: design tokens, native CSS transitions, keyframes, dark/high-contrast/reduced-motion states | **Reuse existing CSS motion**; do not add Motion/GSAP by default. |
| Avatar | `web/src/avatar/character.ts`: Three.js, GLB, lazy loading, 15/30 FPS limits, still-image fallback | Keep existing architecture; profile GPU and asset cost. |
| Voice | `web/src/voice-edge.ts`, `web/src/mic.ts`, `web/src/speaker.ts`, `src/server/voice_edge.ts`: WebRTC, audio, turn routing | Optimize perceived latency without changing consent/privacy ownership. |
| App/backend | Hono, WebSocket, Zod, `src/orchestrator/`, Playwright browser agent | Keep boundaries and safety gates. |
| Testing | Vitest, Playwright E2E, evaluation scripts, Windows CI and packaging jobs | Extend existing tests; do not introduce a parallel test ecosystem. |

**Already well implemented:** support for `prefers-reduced-motion`, CSS tokens, keyboard focus handling, polite/assertive announcements, typed IPC, avatar fallback, approval deduplication, Stop/cancellation tests, and some native UI coverage. Improve these foundations rather than removing them.

**Repository caveat:** some older documentation (e.g. `docs/desktop-ui-handoff.md`, older Python-oriented QA reports) references pre-migration file paths. For new code changes, use the **current TypeScript source** as the source of truth.

---

## 3. Proposed measurable experience budgets

Instrument and record a **baseline first**. Tune thresholds on representative hardware and networks; report p50 and p95, not only averages. Initial targets below are **goals**, not claims that the application currently fails them.

| Experience / SLI | Proposed target | Measurement |
|---|---|---|
| Local click / keyboard interaction feedback | Visual or audible acknowledgement within **100 ms**, p95 | Input timestamp → first visible state/earcon; use trace marks |
| Stop acknowledgement (local UI) | **≤ 200 ms p95**, excluding remote cleanup | Trigger → user-visible/audible Stop acknowledgement |
| UI animation under normal interactive load | **60 FPS target** for standard transitions; no long frame > 50 ms in target flows | Chrome Performance trace / DevTools FPS |
| Avatar rendering | Preserve **30 FPS active / 15 FPS sleeping** cap; near-zero render loop when a static state is held | rAF/GPU profiling; verify current behavior |
| No perceptual dead air after input | Show a truthful state indication within **250 ms**; audio if appropriate | Timestamp from action to status cue, not end-to-end model reply |
| Large thread navigation | No observable keystroke lag at **100 / 1,000 / 5,000** synthetic messages | Input delay, memory, long tasks, screen-reader tests |
| Background idle cost | **Measure baseline**, then choose a defensible per-platform CPU/memory budget | Process CPU/GPU/memory over 5–10 minutes |
| Voice latency | Break down **capture → end-of-utterance → transcript → delegation → first agent action → first spoken answer**; optimize largest p95 segment | Structured monotonic trace IDs (never raw speech or personal data) |
| Recovery | No duplicate consequential action and no stale status after Stop/reconnect | Deterministic network/IPC race tests |

Separate performance samples by: (a) first launch vs warm launch, (b) avatar enabled vs still-image mode, (c) foreground vs tray/background, (d) no API key / synthetic vs real connection, (e) Korean vs translated languages, (f) normal vs throttled network, and (g) screen reader/reduced motion.

**Do not “fix” network latency with deceptive UI.** Communicate *which step is actually running* rather than pretending an action has completed.

---

## 4. Priority 0 — correctness and measurement before cosmetic changes

### P0-01. Add privacy-safe performance tracing

**Files to inspect:** `web/src/conversation.ts`, `web/src/voice-edge.ts`, `web/src/api.ts`, `src/server/voice_edge.ts`, `src/orchestrator/session.ts`, `apps/desktop/src/main.ts`.

**Implementation:**

- Define a tiny typed event/timing schema: `traceId`, `sessionGeneration`, `turnId` (opaque/random), `stage`, `startedAt`, `durationMs`, `result`, `cancelled`, `source`.
- Track local monotonic durations with `performance.now()` and `performance.mark/measure`; record the server separately using its own monotonic clock. **Never subtract unsynchronized client and server timestamps as if they were the same clock.**
- Instrument: Electron service-ready, controller loaded, UI ready, avatar first visible, first input response, microphone capture granted, capture end, transcript committed, delegation, tool step, verification, first audible response, Stop requested/acknowledged, and recovery.
- Create a **development-only** diagnostics panel/report command with counts, p50/p95, long-task records, UI render/update counts, and basic resource metrics.
- Keep plaintext transcripts, government page text, screenshots, field contents, phone numbers, addresses, API keys, and model prompts **out of telemetry**. Favor local opt-in aggregation.
- Avoid putting raw dates or cross-device timestamps into the same time-to-response computation without clock calibration.

**Acceptance:** The same synthetic scenario yields an ordered trace of all completed stages and correctly marks aborted/failed stages. Analytics remain disabled or appropriately minimized by default. The report explicitly distinguishes network/model delay from UI blocking.

### P0-02. Harden progress polling against stale async completions

**Concrete code-review finding:** `web/src/conversation.ts` currently defines `PROGRESS_POLL_MS = 2000`. In `watchProgress()`, `setInterval` starts asynchronous `api.progress(...)` calls. Its callback updates `ui.activity` with `set({ activity: next.activity })` **before** checking `on`. This suggests a late response may update the UI after the watcher has been stopped. The interval can also start another request before the previous request finishes. **This is a code-level risk, not a reproduced production bug.**

**Implement safely:**

1. Capture the relevant session/turn/generation when the watcher starts.
2. Use an `inFlight` guard or a serialized async loop; prevent overlapping progress requests.
3. After each `await`, check `active`, current session/turn/generation, and cancellation **before any mutation or speech**.
4. Ignore unchanged `activity` and `seq` values; avoid calling `set(...)` for no-op progress.
5. Where the API supports it, abort stale requests; otherwise discard their response. Do not add an unsafe cancellation mechanism to the server.
6. Ensure `finally` clears both timers and any subscription and that Stop wins over late progress.
7. Keep existing spoken-progress throttling and do not announce intermediate state over active user speech.

**Acceptance:** Reproduce with a delayed fake progress response: Stop/end session before the delayed request resolves; afterwards **no stale activity appears, no audio plays, and no new overlay card is published**. A 10-second server delay must not create five concurrent poll requests. Existing Stop, recovery, and progress tests continue passing.

### P0-03. Baseline native behaviors and resource costs

**Files/tests:** `apps/desktop/src/main.ts`, `apps/desktop/test/`, `tests/e2e/avatar.test.ts`, `tests/e2e/web-ui.test.ts`.

- Capture Windows startup, tray idle, avatar animation, window hidden, full chat visible, microphone active, and a long browser task.
- Inspect Electron main, utility service, conversation renderer, overlay renderer, and Chromium browser agent as **distinct processes**.
- Record CPU, memory, GPU, long tasks, FPS, and service startup. Watch for leaks after 20 open/close cycles and 20 voice starts/stops.
- `backgroundThrottling: false` currently exists to keep background audio functional. **Do not change it globally without validating voice behavior**; first measure whether specific non-audio work can be paused or moved elsewhere.

**Acceptance:** A documented baseline JSON/Markdown report and reproduction recipe exist before any performance-related library is added or large component is refactored.

---

## 5. Priority 1 — high-value responsiveness improvements

### P1-01. Reduce unnecessary React work without breaking focus

**Source:** `web/src/App.tsx` calls `useSyncExternalStore(subscribe, snapshot)` at the app root and computes `viewOf(ui, env)` whenever the store emits. `web/src/conversation.ts` calls `render()` after `set()`, notifies all store subscribers and publishes a desktop snapshot. This is simple and correct but may become expensive with frequent captions, progress updates and long message lists.

**Plan:**

- First run React Profiler on: rapid speech captions, idle progress polling, approval state changes, and 1,000-message transcripts.
- Track the count and cost of `App`, `Log`, `Message`, `WorkflowPanel`, `StatusPanel`, and overlay updates.
- **Only where measured**, separate high-frequency voice/progress state from stable transcript/setting state using selective subscriptions, memoized selectors, or component-local subscriptions. Do not mutate store objects in place; React snapshots must remain stable between changes.
- Consider `React.memo` for immutable `Message` rows or segmenting the log only if the profiler demonstrates a win. Avoid `useMemo` everywhere as an unmeasured blanket rule.
- Keep text input DOM identity and keyboard focus. `App.tsx` deliberately retains input and focus behavior; do not introduce remounts when a status or card changes.
- Preserve a complete accessible transcript path. If windowing/virtualization is eventually justified, use a separate accessible history/navigation strategy; ordinary virtual lists can hide older messages from screen readers.

**Acceptance:** Under synthetic frequent progress/caption updates, unrelated panels and old message rows stop rerendering where practical; keystrokes remain responsive; existing UI text/focus/ARIA assertions pass; accessible chat history is not lost.

### P1-02. Make long-running agent progress event-driven *only if it improves p95*

**Current state:** `watchProgress` polls every two seconds during active work, while the stack already uses WebSockets in voice/session paths. Polling is a reasonable first implementation; replacing it just to adopt a fashionable transport is not a goal.

**Preferred sequence:**

1. Fix overlapping and stale polling first (P0-02).
2. Measure time from confirmed backend step to visible/appropriate spoken update.
3. If progress is noticeably delayed, add **opt-in server push** (existing authenticated WebSocket or SSE) with `{sessionId/turnId, seq, stage, status}` metadata only; keep local progress state authoritative.
4. Reconnect via the existing recovery protocol and fetch a snapshot after reconnect; handle missing, duplicated, and out-of-order sequence numbers.
5. Preserve 15-second spoken-progress spacing; faster visible updates **must not create incessant speech**.

**Acceptance:** A delayed progress event or replayed duplicate cannot roll the UI backward, speak twice, or create a new approval. With transport disconnected, status remains truthful and can recover from a snapshot.

### P1-03. Establish one coherent interaction-state vocabulary

**Files:** `web/src/conversation.ts`, `web/src/view.ts`, `web/src/companion.ts`, `web/src/avatar/overlay.ts`, `web/src/voice-edge.ts`, `src/core/turn.ts`.

Define or map these **product-level states** without necessarily changing internal enums:

| State | Visual treatment | Audio behavior | What must be true |
|---|---|---|---|
| Idle/ready | Calm avatar, clear Talk affordance | Silence unless prompted | No active mic capture |
| Starting microphone | Brief pending cue, clear label | Short nonverbal cue if appropriate | Do **not** claim mic is on before a real track is live |
| Listening | Persistent mic-on indication | Listening earcon; no overlapping TTS | Valid active capture track |
| Transcribing / planning | Quiet visible state | Minimal cue, then descriptive progress for long waits | Request accepted but not yet completed |
| Browsing / checking | Actual action/site label | Sparse progress; no speculative success | Observed action/step matches displayed state |
| Confirmation required | One clear decision, explicit target in full review | Read one question and options | Current immutable approval/choice reference |
| Authentication handoff | Mic off; manual action instructions | Announce once, then pause | User controls credentials/authentication |
| Speaking | Synchronized playback/avatar | Suppress self-capture and progress overlap | Actual output playback |
| Stopped / failed | Stable, explicit status and next step | Immediate stop cue, short explanation | Outstanding work canceled or honestly marked uncertain |

- Preserve `Ctrl/Cmd+Shift+Space` for speaking and `Ctrl/Cmd+Shift+K` for viewing choices unless explicitly redesigning shortcuts with tests.
- Ensure screen, avatar, tray, spoken wording, and internal operation all agree. Avoid a spinning indicator that implies the agent is still working after cancellation.
- Never rely on color or animation alone; include text, icon/shape, and audio/keyboard access.

**Acceptance:** A state-machine test covers normal, interrupted, failed, and reconnected paths, including `mic starting → Stop`, `speaking → barge-in`, and `manual login → return`.

### P1-04. Optimize voice perceived latency without sacrificing correctness

**Files:** `web/src/voice-edge.ts`, `web/src/mic.ts`, `web/src/speaker.ts`, `src/server/voice_edge.ts`, `src/voice/`.

- Use P0 timing data to rank latency components rather than guessing whether ASR, TTS, model planning, or site navigation dominates.
- Keep capture/processing/response status immediate and honest. Earcons may convey *request acknowledged*, but never *action succeeded* before verification.
- Verify mic-on status against real active media tracks, and confirm the existing device-disconnect and autoplay fallback paths.
- Maintain barge-in support and prioritize Stop; prevent the agent's own TTS from being transcribed as a new user instruction.
- Measure Korean first and add English/Chinese/Japanese cases, including **language switching mid-conversation**, numeric amounts, dates, phone numbers, and office names.
- If caching short fixed TTS cues is considered, only cache safe, non-personal, locale/version-qualified phrases and verify consent and audio preferences first. Never preload or log private speech.
- If playback is streamed, ensure interruption closes/flushes both the audio queue and the logical speech state.

**Acceptance:** All voice paths either start promptly or explain a recoverable error with a keyboard fallback. Stop works at every stage. No sentence overlap or stale spoken confirmation occurs in synthetic tests.

### P1-05. Preserve economical 3D avatar behavior

**Files:** `web/src/avatar/character.ts`, `web/src/avatar/overlay.ts`, `web/src/avatar/overlay.css`, `vite.config.ts`, `graphics/animations/cheongeum-avatar.glb`.

The current implementation already **lazy-imports Three.js**, falls back to a still image, renders about **30 FPS while active / 15 FPS while sleeping**, and stops the rendering loop when holding many static poses. The source GLB is about **1.27 MB**. These are generally good choices; do not replace them reflexively.

- Measure first-show time, GLB decode time, GPU frame time, memory, and idle power on low-power integrated graphics.
- Retain the still-image pathway as a first-class option. When users select still/reduced motion, avoid initializing unnecessary WebGL resources.
- Keep idle/hidden frames paused; verify avatar state survives screen change, DPI scaling, GPU context loss, renderer crash, and monitor changes.
- Optimize GLB textures/geometry or poster assets **only if measurable**; validate visual fidelity and fallback latency before and after compression.
- Do not add Rive, Lottie, GSAP, or Motion to the 3D overlay without a specific requirement unmet by Three.js/CSS.

**Acceptance:** The avatar never steals focus unexpectedly; passive cards leave the browser active; still mode and reduced-motion mode do not pay a recurring rendering cost; no GPU/context leak appears after repeated show/hide.

---

## 6. Priority 2 — polish that matters to real users

### P2-01. Create a restrained visual motion language

**Source:** `web/src/styles.css` already defines animation tokens, entrance transitions, `@keyframes`, dark mode, high-contrast mode and reduced-motion branches.

Implement a concise motion spec rather than more animations:

| Interaction | Proposed duration | Rule |
|---|---:|---|
| Hover/press feedback | 80–150 ms | Must never delay click execution |
| Small status/chip change | 120–200 ms | Prefer opacity/transform; protect reading order |
| Dialog/card entrance | 180–260 ms | Fade + subtle position change; avoid spring overshoot on safety approvals |
| Layout move | 180–280 ms | Only when movement clarifies a change; stable focus |
| Progress indicator | Continuous only during real work | Stop motion immediately when status ends |
| Avatar breathing/speaking | Existing authored behavior | Never compete with accessibility or battery targets |

- Use `transform`/`opacity` for performance-sensitive movement where feasible; avoid animating large layout-affecting properties without a reason.
- Do not animate **Stop** behind a modal transition.
- Do not draw user's attention away from the government web page with endlessly repeating decorative motion.
- For `prefers-reduced-motion`, use immediate state changes or subtle non-spatial emphasis. Preserve visibility, focus and choice availability.
- Respect dark/high contrast, forced-colors, zoom, and Windows text scaling.

**Acceptance:** Compare recorded screenshots and keyboard/focus behavior in normal/reduced motion. No essential semantic content is conveyed by motion alone.

### P2-02. Speech-first accessibility release gate

**Files:** `web/src/App.tsx`, `web/src/FirstRun.tsx`, `web/src/SettingsDialog.tsx`, `web/src/styles.css`, `web/src/avatar/overlay.ts`, `tests/e2e/`, `docs/user-test/`.

- Use **WCAG 2.2 AA** as a verification target where applicable, not as a claim of existing certification.
- Validate NVDA on supported Windows builds, keyboard-only control, high-contrast/forced-colors, 200% and 400% zoom where applicable, and reduced motion. On supported macOS builds, test VoiceOver separately.
- Audit `aria-live` outputs for duplicate or competing announcements: conversation log, phase, activity, and assertive `#announce`. More live regions do **not** necessarily mean more accessibility.
- Never steal focus for passive progress or an overlay animation. Move focus deliberately only for explicit user decisions or required navigation, and provide an obvious return path.
- Preserve real HTML buttons, labels, heading order, visible focus rings, and sufficiently large targets for motor impairments.
- Test the entire **voice-only** pathway with the display visually hidden: start, choose language, consent, ask about a program, hear source/next action, refuse, Stop, recover, and finish.
- Recruit representative users. The repo's own README reports **no completed participant sessions**, so automated axe tests alone cannot validate usability.

**Acceptance:** Automated checks plus recorded human/manual outcomes, not just “axe found 0 violations.” No key task requires watching the avatar or reading small text.

### P2-03. Long transcripts and histories without sacrificing reading access

- Establish realistic upper bounds and test 100, 1,000, 5,000 messages, with both concise and long content.
- First profile `Log`/`Message` rendering and scrolling; avoid adding a virtualization dependency unless rendering is demonstrably costly.
- If pagination/virtualization is introduced, preserve search, keyboard selection, aria-live behavior, and an accessible path to every historical message.
- Do not automatically yank scroll position when the user has scrolled up. The existing `useFollowThread()` mechanism should remain the behavioral baseline.
- Preserve source citations, confirmation descriptions, and correction history.

**Acceptance:** No dropped messages, no focus loss, no forced scroll, and a bounded render cost under synthetic load.

### P2-04. Fault tolerance and honest recovery

- Make error states actionable: mic permission denied, lost microphone, disconnected model/voice service, blocked public site, stale approval, timed-out navigation, and changed page after manual login.
- Preserve explicit statuses: *retrieving*, *verifying*, *waiting for resident*, *not confirmed*, *stopped*, *complete*.
- Audit retries for side-effecting actions. Retry read-only requests selectively; never replay a potentially successful consequential action without re-observation and fresh authorization.
- Continue using existing scoped recovery and request-ledger mechanisms; avoid new duplicate session stores or new persistence of unredacted data.
- For browser operations that cannot be canceled immediately, cancel the logical turn, isolate late results, and truthfully tell the user whether a late page navigation may still have happened.

**Acceptance:** Under forced failures and reconnection, the voice and visual explanation match the verified state, and no duplicate writes occur.

---

## 7. Priority 3 — production packaging, observability and CI

### P3-01. Control actual bundle/startup cost

**Files:** `vite.config.ts`, `apps/desktop/scripts/build.ts`, `apps/desktop/src/main.ts`.

- Generate a measured bundle report for both `main` and `avatar` entry points; record JS parse/execute and GLB load time as well as file sizes.
- Preserve the existing lazy import of `web/src/avatar/character.ts` and avoid including Three.js in the main conversation bundle.
- Check first paint with warm and cold cache, real disk speed, and low-memory systems.
- Investigate deferring nonessential features (examples, noninteractive workflow views, optional models) only after profiling; avoid hiding important consent or safety controls behind lazy loading.
- Do not simply raise Vite's warning thresholds to silence a real regression. Keep budgets specific to entry point and measured device.

### P3-02. Add a repeatable UI performance suite to existing tests

**Current CI:** `.github/workflows/ci.yml` already runs Windows typecheck, lint, unit/E2E, evaluation and packaging. Extend it, rather than replacing it.

Recommended tests:

1. **Input-to-feedback:** synthetic click/Talk/Stop timing with production build.
2. **Progress race:** delayed progress response after Stop; overlap control and dedupe.
3. **Rerender count:** 30 seconds of polling/captions with unrelated panels stable.
4. **Large log:** 1,000-message interaction and scroll pinning without focus loss.
5. **Avatar:** normal/hidden/still/reduced-motion, monitor scale changes and WebGL fallback.
6. **Native desktop:** tray shortcuts, overlay keyboard focus, conversation renderer crash/relaunch.
7. **Voice:** multilingual transcript and TTS, speaking overlap, barge-in, disconnected device.
8. **Accessibility:** axe plus keyboard/focus assertions; manual NVDA release checklist.

Avoid making GitHub-hosted CI depend on flaky live model latency. Use deterministic fixtures for PR blocking, and run real-service performance studies separately with costs/credentials controlled. Store sanitized benchmark summaries and trace artifacts; do not upload user transcripts or sensitive screenshots.

**Acceptance:** PRs detect meaningful local performance regressions, while network and GPU variability are handled through stable, platform-specific baselines rather than arbitrary hard failures.

### P3-03. Instrument errors and uptime without harvesting private content

- Track anonymized event categories for startup failure, crash, denied mic permission, broken audio track, WebRTC disconnection, browser timeout, page change, and stale approval.
- Prefer **local diagnostics export** and explicit opt-in for centralized telemetry.
- Apply retention/rotation and redact at the event-creation boundary, before any sink.
- Report user-visible recovery success, not only successful HTTP responses.

---

## 8. Recommended engineering backlog

| ID | Priority | Task | Key files | Definition of done |
|---|---|---|---|---|
| UX-01 | **P0** | Establish privacy-safe latency/render baseline | `conversation.ts`, `voice-edge.ts`, `main.ts` | Reproducible baseline for UI, voice, avatar, background modes |
| UX-02 | **P0** | Fix stale/overlapping progress polls | `conversation.ts`, E2E tests | No late UI/speech update after Stop; ≤1 active poll |
| UX-03 | **P0** | Audit cancellation, speech and approval races | orchestrator, `api.ts`, `voice-edge.ts` | No duplicate consequential action or misleading completion |
| UX-04 | **P1** | Profile and selectively isolate high-frequency React state | `App.tsx`, `conversation.ts`, `view.ts` | Reduced unnecessary rerenders; focus/history preserved |
| UX-05 | **P1** | Align on-screen/tray/avatar/spoken status | `companion.ts`, `overlay.ts`, `view.ts` | One truthful state in every surface, including failures |
| UX-06 | **P1** | Make progress push optional if measured delay warrants it | server progress paths, `conversation.ts` | Reconnect/ordering tested; no redundant speech |
| UX-07 | **P1** | Profile avatar GLB/GPU/battery cost | `character.ts`, `overlay.ts` | Smooth, still/reduced-motion friendly; no leaked loops |
| UX-08 | **P2** | Standardize existing motion tokens and feedback | `styles.css`, `App.tsx` | Consistent transitions, no focus or reduced-motion regression |
| UX-09 | **P2** | Conduct screen-reader and target-user task tests | `docs/user-test/`, manual test plan | Recorded voice-only, NVDA/keyboard findings and fixes |
| UX-10 | **P2** | Stress-test long conversations and interrupted tasks | E2E, `App.tsx` | 1k-message tests; reliable Stop/reconnect |
| UX-11 | **P3** | Bundle/packaged startup assessment | Vite, desktop build scripts | Entry-point budget and cold/warm startup report |
| UX-12 | **P3** | Add deterministic performance-regression checks | `.github/workflows/ci.yml` | Automated, sanitized summary with clear tolerance |

**Recommended first PR:** UX-01 + UX-02 only. They are measurable, bounded and unlikely to require redesign. **Second PR:** UX-04 + UX-05 with profiler evidence. Keep visual polish separate from backend correctness and latency changes.

---

## 9. Suggested test matrix

| Scenario | What to do | Expected outcome |
|---|---|---|
| A. First run | New install, select language, microphone, consent | Guided voice + screen path; no premature recording |
| B. Normal voice question | Ask about a welfare program | Immediate acknowledgement, valid source/next action |
| C. Slow government page | Inject 8–15 s navigation delay | Truthful progress, UI and Stop remain responsive |
| D. Stop during pending HTTP response | Delay `api.progress` and browser work; press Stop | No stale status/audio or repeated execution after delay |
| E. Stale approval | Show confirm, change browser target, approve | Current target rechecked; unsafe action rejected |
| F. Manual login | Request login, hand off, return | Mic released; never automates credentials/verification |
| G. Voice interruption | Speak while TTS is active | Correct barge-in; no self-transcription/overlap |
| H. Device failure | Disconnect mic or deny permission | Clear message, keyboard fallback, safe cleanup |
| I. Language switch | Korean → English → Korean within one task | Task context, figures and Stop semantics preserved |
| J. Screen reader | NVDA + Windows; equivalent Mac test later | Correct focus/announcements, no overlay focus theft |
| K. Reduced motion | OS reduced motion + app still-avatar preference | Same tasks possible; no unnecessary WebGL work |
| L. Large transcript | 100/1,000/5,000 synthetic messages | Responsive input, full accessible history |
| M. Hide/show cycles | Toggle avatar/chat 20 times, change monitors | One controller/session, no process or GPU leak |
| N. Network reconnection | Disconnect/reconnect voice and progress transport | Snapshot recovery; no duplicate approval or speech |
| O. Practice vs real mode | Navigate mock form and a real service site | Correct mode messaging and no real submission |

Run synthetic and deterministic automation first, then native hardware/assistive-technology tests, then representative participant sessions. Keep the evidence for each level distinct.

---

## 10. Tools to use (and tools *not* to add yet)

### Primary tools already appropriate

- **Chrome/Edge DevTools Performance + Memory**: long tasks, layout/paint, animation performance, heap growth.
- **React DevTools Profiler**: rerender counts and expensive updates in `App`, `Log`, and panels.
- **Playwright + Vitest**: deterministic UX, state, interaction and accessibility assertions.
- **Electron process metrics / OS performance monitors**: main/service/renderer/overlay resource costs.
- **Windows Performance Recorder/Analyzer, NVDA**: Windows-native performance/accessibility checks where available.
- **Existing Vite/esbuild configuration**: chunk analysis, loading and cold-start inspection.
- **Existing CSS and Web Animations API**: most motion and microinteractions.
- **Three.js**: current avatar; keep its existing lazy loading and frame limits.

### Only if evidence demonstrates the need

- **Motion (formerly Framer Motion)**: if complex coordinated React transitions genuinely cannot be maintained with existing CSS/WAAPI. Not necessary for ordinary buttons/cards.
- **TanStack Virtual**: if transcript rendering is provably expensive **and** an accessible history strategy is implemented.
- **Zustand / selector store**: if high-frequency external-store updates remain costly after scoped component subscriptions; avoid introducing a second source of truth.
- **TanStack Query**: if there are multiple new server-state queries where its caching/retry semantics materially simplify the design. The existing API/session logic may be preferable for consequential actions.
- **SSE/WebSocket progress push**: only when measurement shows the two-second poll is inadequate; ensure event replay/deduplication.

**Avoid:** wholesale Electron→Tauri migrations, mandatory GPU animations, global visual effects, extra state libraries with overlapping ownership, new cross-window session controllers, optimistic success for irreversible actions, and logging voice/PII to diagnose performance.

---

## 11. Execution procedure for a coding agent

Apply the work **incrementally** to the current checkout. Do not interpret this plan as permission to make every change at once.

### Stage A — inspect and establish baseline

```bash
# Repository root, Node 24+
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
npm run eval
npm run build:web

# When local desktop packaging prerequisites are installed:
npm run test:desktop
# Native checks and package tests only on a compatible Windows machine:
# npm run test:desktop-native
# npm run test:desktop-packaged
```

Record exit codes and **actual** results. Do not describe tests as passing unless executed. Benchmark with synthetic fixtures, never users' private voice recordings or application data.

### Stage B — one safe, reviewable PR at a time

1. Create a feature branch. Capture baseline screenshots, traces and a concise notes file.
2. Implement the smallest change for one backlog ID. Favor changes in existing modules over new infrastructure.
3. Add targeted regression tests **before** or alongside the change.
4. Run the relevant focused tests, then typecheck/lint, then full unit/E2E as appropriate.
5. Confirm focus, aria-live, mic state, Stop, approvals, and privacy are not regressed.
6. Report **before/after measurements**, test commands/results, remaining uncertainty and rollback approach.
7. Open a PR; do not merge merely because local synthetic tests are green.

### Stage C — release validation

- Test a packaged Windows build on a representative machine, including low-power integrated graphics if possible.
- Test actual microphone/headphones, tray shortcuts, Start/Stop, native focus, monitor resizing, GPU fallback and a fresh installation.
- Conduct NVDA, high-contrast, reduced-motion and keyboard-only checks.
- Validate with representative users, especially blind/low-vision and older adults.
- Confirm security and privacy gates before a production release.

---

## 12. Copy/paste prompt for Claude Code, Codex or another coding agent

```text
You are improving the EXISTING Cheongeum desktop voice welfare agent.
Repository: https://github.com/davemaxuell/voice-welfare

Read the current checkout's CLAUDE.md, README.md, package.json,
web/src/App.tsx, web/src/conversation.ts, web/src/view.ts,
web/src/companion.ts, web/src/avatar/character.ts,
web/src/avatar/overlay.ts, web/src/styles.css,
apps/desktop/src/main.ts, and related tests.

Read docs/VOICE_WELFARE_COMMERCIAL_SMOOTHNESS_PLAN.md.
The current TypeScript implementation is authoritative; some older docs
still refer to legacy Python paths.

FIRST SCOPE: Implement only UX-01 and UX-02 (performance instrumentation
and safe progress polling). Do not refactor all UI modules, migrate
frameworks, add animation/state libraries, change model routing,
change agent safety policies, or redesign the product.

Before coding:
1) Audit existing behavior and reproduce/pin the suspected polling race.
2) Define privacy-safe before/after measurements.
3) Write/update deterministic tests for concurrent progress requests,
   Stop before delayed completion, stale session/turn responses,
   duplicate progress sequence, and audio announcements.

Implementation requirements:
- Never apply a progress response after watcher cancellation/Stop or
  after its owning session/turn generation is no longer current.
- Serialize/dedupe progress polling; do not cause overlapping requests.
- Avoid unnecessary React/store updates when progress is unchanged.
- Keep all approval, consent, manual login, microphone, privacy,
  screen-reader and voice-only UX invariants intact.
- Do not log private contents.
- Preserve the existing single-controller desktop/overlay model.

Run actual tests and report their exit codes. Compare measured p50/p95
where test conditions allow. Show a small PR-ready diff, risks,
tradeoffs and any follow-up ideas, but do not claim tests or native
accessibility checks that were not run. Do not modify unrelated files.
```

---

## 13. Relevant current-source links

- [README and product boundaries](https://github.com/davemaxuell/voice-welfare/blob/main/README.md)
- [Engineering conventions](https://github.com/davemaxuell/voice-welfare/blob/main/CLAUDE.md)
- [Current React application](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/App.tsx)
- [Conversation state and progress polling](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/conversation.ts)
- [React UI derivation](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/view.ts)
- [CSS and reduced-motion styles](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/styles.css)
- [Desktop avatar renderer](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/character.ts)
- [Avatar overlay and UI](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/overlay.ts)
- [Electron shell / utility process ownership](https://github.com/davemaxuell/voice-welfare/blob/main/apps/desktop/src/main.ts)
- [Browser voice integration](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/voice-edge.ts)
- [Server voice integration](https://github.com/davemaxuell/voice-welfare/blob/main/src/server/voice_edge.ts)
- [UI E2E tests](https://github.com/davemaxuell/voice-welfare/blob/main/tests/e2e/web-ui.test.ts)
- [Avatar E2E tests](https://github.com/davemaxuell/voice-welfare/blob/main/tests/e2e/avatar.test.ts)
- [Windows CI](https://github.com/davemaxuell/voice-welfare/blob/main/.github/workflows/ci.yml)

**Document ownership:** This file is a proposed engineering plan only. Nothing in the GitHub repository was edited when preparing it.
