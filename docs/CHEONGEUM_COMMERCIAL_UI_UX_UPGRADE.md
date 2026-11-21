# Cheongeum (청음) — Commercial-Grade UI/UX Upgrade Blueprint

**Repository:** [davemaxuell/voice-welfare](https://github.com/davemaxuell/voice-welfare)  
**Review date:** 2026-11-21  
**Artifact type:** Implementation specification and coding-agent handoff  
**Scope:** Existing React + TypeScript web client and Electron desktop app, including the floating avatar and voice-driven public-service workflows  
**Code changes performed:** None. This document proposes changes; it does not modify the repository.

> **Evidence and limitations.** This is a source-based review of the repository's `main` branch and existing product/design/test documentation, **not** a visual inspection of a running build or a completed usability study. Code observations below are distinguishable from proposed improvements. A suspected usability issue is not a confirmed defect until reproduced. Do not remove or replace working behavior merely because it appears on a checklist.

## Executive objective

Raise Cheongeum to the level of a dependable, accessible, polished **commercial Windows/macOS desktop assistant**, with a companion web interface. The core interaction remains **voice-first, user-controlled and source-grounded**. The floating avatar should be helpful but never obstruct the public-service website; the full conversation view should be comprehensible to new users, including users who rely on screen readers or have low vision.

**What success looks like:**

1. People always know whether Cheongeum is listening, speaking, using tools, waiting for them, or stopped.
2. The same action has the same name, effect and visual treatment in the avatar card, full conversation, tray and spoken prompts.
3. An ordinary user can start, interrupt, correct, resume and finish a supported task without needing to understand an AI architecture.
4. Focus, keyboard control and screen-reader output remain predictable across all windows and handoff states.
5. The UI is visually coherent across dark/light/high-contrast modes, Windows scaling, different screen sizes and all supported languages.
6. Perceived performance is smooth, without misleading progress indicators or responsiveness regressions.
7. All existing consent, privacy, confirmation, grounding and real-world action restrictions are preserved.

---

## 1. Existing architecture — preserve what works

### Observed in the repository

| Surface / capability | Current implementation | Upgrade implication |
|---|---|---|
| Full conversation/workspace | [`web/src/App.tsx`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/App.tsx), [`web/src/view.ts`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/view.ts), [`web/src/conversation.ts`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/conversation.ts) | Improve hierarchy, copy, presentation and testability while retaining shared session behavior. |
| Design and adaptive styles | [`web/src/styles.css`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/styles.css) already contains theme variables, high-contrast rules, reduced-motion styles and responsive layout rules | Consolidate rather than replace. Run contrast, zoom, overflow and motion audits. |
| Floating assistant | [`web/src/avatar/overlay.ts`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/overlay.ts), [`web/src/avatar/overlay.css`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/overlay.css) | Align tokens with the full workspace, protect focus/geometry and test all state transitions. |
| Desktop shell | [`apps/desktop/src/main.ts`](https://github.com/davemaxuell/voice-welfare/blob/main/apps/desktop/src/main.ts) | Preserve tray, global shortcuts, single session controller and overlay-to-main communication. |
| Initial setup | [`web/src/FirstRun.tsx`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/FirstRun.tsx), [`web/src/first-run.ts`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/first-run.ts) | Shorten cognitive load and validate focus, consent and recovery; do not reorder consent unsafely. |
| Settings | [`web/src/SettingsDialog.tsx`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/SettingsDialog.tsx) | Progressive disclosure, consistent labels/help and clear save/rollback states. |
| Research and remembered tasks | [`web/src/workflows.tsx`](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/workflows.tsx) | Ensure secondary functionality does not overwhelm the primary voice task. |
| Safety and authority | [`docs/rules.md`](https://github.com/davemaxuell/voice-welfare/blob/main/docs/rules.md), README, backend guards and approval paths | Keep approval, page re-checks, prohibited submissions, authentication handoff, PII protection and stop priority. |
| Test infrastructure | [`tests/e2e`](https://github.com/davemaxuell/voice-welfare/tree/main/tests/e2e), [`apps/desktop/test`](https://github.com/davemaxuell/voice-welfare/tree/main/apps/desktop/test), Vitest, Playwright | Extend existing tests, including native accessibility and packaged desktop cases. |

### Existing strengths that must not be lost

- A voice-first assistant with both an expanded conversation view and a compact avatar overlay.
- Separate **Talk**, **Stop**, **Hide** and **End session** semantics.
- Explicit consent and a user-controlled authentication/submission boundary.
- An existing high-contrast mode, dark-mode styling and `prefers-reduced-motion` support.
- Focusable, semantically structured HTML; some screen-reader live regions and automated accessibility coverage.
- Task/action evidence, official sources, timestamps and approval controls already represented in the UI.
- Korean, English, Chinese and Japanese language pathways.
- Playwright/Vitest test suites for avatar behavior, microphone, language changes, approvals and recovery.

**Important version note:** Some November 19 handoff documents still link to older Python/static paths such as `apps/desktop/main.cjs` and `src/cheongeum/web/static/...`. The current root `package.json` and `web/src/`, `apps/desktop/src/`, `src/` TypeScript paths should guide new implementation. Check the active build before editing and do not blindly apply legacy file paths.

---

## 2. Non-negotiable product design rules

| ID | Rule | Acceptance standard |
|---|---|---|
| R01 | **State is always truthful** | Do not display `Listening` unless audio capture is actually active; do not show `Done` until the task has completed. |
| R02 | **A user can always stop** | Stop interrupts local voice/playback promptly and requests backend cancellation; show pending cancellation until confirmed. |
| R03 | **Never steal focus unexpectedly** | Passive avatar cards must not take focus away from Chrome or a screen reader. Explicitly opened UI may acquire focus. |
| R04 | **One decision, one execution** | Two clicks, voice + click or stale approval IDs never cause duplicate consequential actions. |
| R05 | **No surprising autonomy** | Clearly show the target site, proposed operation and any approval boundary before an action affecting user data. |
| R06 | **Voice and visuals agree** | A spoken prompt and its corresponding on-screen choice use equivalent labels and meanings. |
| R07 | **Essential actions have non-voice alternatives** | Every important function is operable with keyboard and visible controls, including during microphone failure. |
| R08 | **No hidden unsafe defaults** | Real submission, login, identity verification, payments and CAPTCHA remain manual where existing policy requires it. |
| R09 | **Source-grounded answers** | Welfare information identifies source, dataset type/date where relevant, verification time and appropriate next step. |
| R10 | **Simple first, advanced on demand** | Primary task controls dominate; optional audio/model/workflow/debug features remain discoverable but secondary. |
| R11 | **No performance theater** | Progress and status are derived from real events, not a fabricated percentage or fake estimated completion time. |
| R12 | **Accessible across modalities** | Text, visual indicators, assistive-tech status and audio cues convey the same essential outcome without repeated announcements. |

---

## 3. Prioritized product backlog

**Priority definitions:** P0 = trust, accessibility or core interaction blocker; P1 = high-value commercial polish; P2 = optimization or further enhancement. These are proposed work items, not confirmed failing tests.

| ID | Priority | Work item | Main files |
|---|---|---|---|
| UI-01 | **P0** | Audit and complete localization of user-visible strings | `App.tsx`, `view.ts`, `workspace-language.ts`, `SettingsDialog.tsx`, `main.ts` |
| UI-02 | **P0** | Explicit cross-surface voice/task state contract | `conversation.ts`, `view.ts`, `overlay.ts`, desktop IPC |
| UI-03 | **P0** | Focus, announcement and keyboard interaction audit | `App.tsx`, `FirstRun.tsx`, `SettingsDialog.tsx`, overlay, desktop tests |
| UI-04 | **P0** | Consent / approval / auth / Stop regression coverage | UI + existing backend tests |
| UI-05 | **P1** | Shared design tokens and component primitives | `styles.css`, `overlay.css`, React components |
| UI-06 | **P1** | Simplify full-window information hierarchy | `App.tsx`, `workflows.tsx`, `styles.css` |
| UI-07 | **P1** | Overlay legibility, placement and focus-safe geometry | `overlay.css`, `overlay.ts`, desktop main |
| UI-08 | **P1** | Motion and rendering performance pass | `avatar/character.ts`, `overlay.ts`, styles |
| UI-09 | **P1** | Loading, offline, empty, retry and recovery patterns | `conversation.ts`, `App.tsx`, `view.ts` |
| UI-10 | **P1** | Text scaling, zoom, density and long-string handling | both CSS systems and layout tests |
| UI-11 | **P1** | Real-world usability validation with intended users | `docs/user-test`, reports |
| UI-12 | **P2** | Screen-level visual regression automation | existing Playwright suites |
| UI-13 | **P2** | Better contextual next-actions and discoverability | `App.tsx`, overlay choice cards |
| UI-14 | **P2** | Privacy-preserving UX analytics and release scorecard | evaluation scripts / local diagnostics |

### UI-01 — Complete localization (P0)

**Observed:** Some top-level areas in `App.tsx` use `workspaceText`/`t(...)`, while other visible JSX strings are directly written in Korean (e.g. confirmation headings, welfare answer details, sidebar section labels and selected helper labels). The Electron tray also contains Korean literals. This may cause mixed-language surfaces; verify each supported locale in a running build.

**Implementation:**

- Create or extend the existing translation dictionary; **do not** introduce a second competing i18n system.
- Centralize every user-visible copy string, accessible name, error text, status, tooltip and tray label, with interpolation for site/task names.
- Preserve the original language of external evidence/source titles; translate explanatory UI text separately.
- Switch language without losing typed content, choices, focus, session or pending approval.
- Audit `lang` on foreign-language spans and the live caption/transcript.
- Match the language of a quick-choice label to its spoken equivalent.

**Acceptance:** No unexplained Korean-only application chrome in English, Chinese or Japanese UI; native tray labels are appropriately localized where platform integration permits. Regression tests cover language switching mid-task, pending decisions and long translated strings.

### UI-02 — Truthful state model (P0)

**Observed:** The overlay already receives fields such as `capture`, `speaking`, `busy`, `status`, `choices`, `choiceSetId` and `pending`; the conversation view also renders phase/status. This is a solid starting point, but multiple representations should be tested for consistency.

Use a **derived presentation model**, not independent competing state machines:

```ts
// Illustrative UI contract; map to existing schemas, do not duplicate backend truth.
type PresentationState = {
  capture: 'off' | 'requesting' | 'on' | 'error';
  playback: 'idle' | 'speaking' | 'interrupted';
  task: 'idle' | 'interpreting' | 'using_tool' | 'awaiting_choice'
      | 'awaiting_approval' | 'auth_handoff' | 'cancelling'
      | 'completed' | 'stopped' | 'failed' | 'offline';
  taskLabel?: string;
  activeSite?: string;
  actionId?: string;            // existing approval/choice identity
  sessionId?: string;           // do not serialize secrets into the overlay
  recoverable?: boolean;
};
```

Treat **capture, playback and task execution as orthogonal dimensions**. The mic may be on while the assistant speaks if the implementation explicitly supports interruption; an auth handoff requires a mic-off presentation where the active policy dictates that.

**Acceptance:** The avatar, full conversation, tray and speech cues never disagree about microphone capture, task completion, pending authorization or Stop. An inactive task does not display a persistent busy indicator. A dropped connection shows offline/reconnecting instead of indefinitely `Thinking`.

### UI-03 — Keyboard, focus and screen-reader pass (P0)

- Verify the focus sequence for consent, first run, settings, recording review, approval, handoff, error and reconnection.
- Returning from a modal restores focus to the triggering control or a sensible replacement. Modal focus remains inside its dialog.
- Opening a passive overlay bubble does not move focus from Chrome; the dedicated **Show choices** shortcut may explicitly focus its controls.
- Escape, Stop, Hide and End session remain semantically distinct; never silently dismiss a high-stakes pending choice as an approval.
- Audit all `aria-live`, `role="log"`, `role="status"` and assertive announcements to prevent duplicate narration or interruption of speech guidance.
- Ensure screen readers are given the actual purpose and current state of disabled controls, and that the status is not conveyed only by color, waveform or avatar pose.
- Preserve the current visible focus outline and test it against the edge/clipping behavior of Electron's shaped window.

**Acceptance:** A keyboard-only user can perform every supported flow; NVDA on Windows and VoiceOver on macOS can identify the active control and correct state; no passive bubble steals website focus.

### UI-04 — Consent and consequential actions (P0)

**Preserve** the repository's established policy constraints: explicit consent; private input protection; page/action re-checks; approval ID freshness; auth handoff; refusal to submit a real application; clear indication that practice submissions are not real.

Test: two quick clicks on the same card, voice approval followed by a click, approval after navigation to a different page, simultaneous Stop and approval, reconnection during pending authorization, and stale choices after a new task. Count actual actions, not just UI click handlers. Sensitive form values belong in an intentionally opened review surface, **never** a passive floating card.

### UI-05 — Design system consolidation (P1)

**Observed:** Both `web/src/styles.css` and `web/src/avatar/overlay.css` define their own theme variables. This is understandable for a separate renderer, but makes visual drift possible.

Establish a common semantic token contract. Preserve the existing ivory/indigo identity and theme intent; migrate incrementally rather than replacing every rule.

| Token group | Initial suggested scale or rule | Notes |
|---|---|---|
| Space | `4, 8, 12, 16, 24, 32, 48px` | A small set of spacing steps, not arbitrary margins for each component. |
| Font | Body `16–18px` where practical; dense secondary UI `14px` only when readable | Prefer user-configurable text size and OS scaling, particularly for older and low-vision users. |
| Line height | Body roughly `1.5–1.65`; controls as needed | Korean multiline labels need room. |
| Radius | `8, 12, 16, 24px`, pill reserved for appropriate controls | Preserve visual identity; do not over-round data panels. |
| Control size | Pointer/touch-friendly primary targets `44×44px` or larger | WCAG 2.2 AA minimum is generally `24×24 CSS px` with exceptions; 44×44 is the product's ergonomic target, not the AA rule. |
| Focus | Visible 3px focus ring or equivalent strong indicator | Must work in dark, light, high contrast and forced-color modes. |
| Color | `canvas`, `surface`, `surface-raised`, `text`, `text-muted`, `border`, `accent`, `danger`, `warning`, `success`, `focus` | Use semantic variables; ensure meaning is not color-only. |
| Shadow | 2–3 levels maximum for daily UI | Elevation should mean focus/overlay, not decoration. |
| Animation | 120–220ms microfeedback; 180–300ms small surface transitions | Heuristics only; verify with real device and reduced-motion setting. |

Suggested token bridge:

```css
/* Example contract: map aliases to existing variables rather than restyling blindly. */
:root {
  --ui-space-1: 4px;
  --ui-space-2: 8px;
  --ui-space-3: 12px;
  --ui-space-4: 16px;
  --ui-space-6: 24px;
  --ui-control-min: 44px;
  --ui-motion-fast: 140ms;
  --ui-motion-base: 220ms;
}
```

First define the token source and how it is shared between the main app and independently bundled avatar page. Create or extract reusable **Button, StatusBadge, TaskCard, ChoiceGroup, DialogHeader, SourceCitation, EmptyState** patterns only when they remove genuine duplication. Do not add a large component framework solely to meet this document.

### UI-06 — Information hierarchy (P1)

The existing full workspace combines conversation, current task, sound settings, source references, action history and research/notes. Keep the information, but give each part a clear priority:

```text
FULL WINDOW — RECOMMENDED READING ORDER
┌────────────────────────────────────────────────────────────────────┐
│ Cheongeum   [Current mic state]   [Settings] [Stop] [End session] │
├──────────────────────────────────────┬─────────────────────────────┤
│ CURRENT CONVERSATION                 │ CURRENT TASK                │
│ Source-grounded reply                │ Site · current step         │
│ Follow-up / approval card            │ Actual status · next action │
│                                      ├─────────────────────────────┤
│ Transcript                           │ Sources / action history    │
│                                      │ (collapsible)               │
├──────────────────────────────────────┴─────────────────────────────┤
│ [Type your request…] [Send] [Talk / Mic state]                     │
│ Advanced: audio settings · workflows · diagnostics (disclosure)   │
└────────────────────────────────────────────────────────────────────┘
```

This is a **hierarchy**, not a mandate to recreate the layout. The existing two-column view is a useful baseline. During real task execution, show **one obvious primary next action** while Stop remains independently reachable. Advanced settings should not compete visually with the task.

**Acceptance:** In a five-second glance test, users can identify current activity, whether the mic is live, the next action and how to stop. At narrow widths, the conversation and primary action remain usable without horizontal scrolling.

### UI-07 — Floating avatar and card (P1)

- Preserve clicking the avatar to **open the conversation**. Keep **Talk** as a separate deliberate action.
- Show actual mic state in text, not solely animation or color.
- Show at most one task question with up to three contextual choices, matching the existing design direction.
- Use simple labels: `말하기`, `멈춰`, `숨기기`, `대화 열기`, `로그인했어요`, `인증 취소` and their localized equivalents.
- Cards should open inward from the chosen screen corner, fit the usable work area and not cover browser controls unnecessarily.
- Keep noninteractive transparent regions click-through. Do not introduce a window shape that blocks interaction underneath or obscures the browser focus indicator.
- Test 100%, 125%, 150%, 200% and where appropriate higher Windows display scaling, multiple monitors, short screens and taskbar changes.
- Offer a still-avatar option and a reliable non-WebGL fallback. An unavailable or throttled GPU must not disable Talk, Stop or choice controls.
- An approval card must identify the **specific action**, not a generic `Continue`; never expose private entered values on the passive overlay.

**Acceptance:** The overlay remains navigable, readable, unobtrusive and responsive at all tested sizes. Moving, hiding and reopening the overlay do not create a second voice session or duplicate a decision.

### UI-08 — Motion and runtime efficiency (P1)

Prioritize **functional** motion: acknowledgment, entry/exit, state change and orientation. Avoid perpetual decorative animation that consumes attention or GPU time while the user reads a public-service site.

- Animate preferably using `transform` and `opacity`; avoid repeated layout-inducing property changes.
- Limit simultaneously active animations; do not animate every message if a large batch of transcript entries arrives at once.
- Keep animation cancellation and reversal deterministic when new input interrupts an existing transition.
- Respect `prefers-reduced-motion`, the still-avatar setting and Windows accessibility settings; provide a static state label.
- Reduce avatar render activity while idle, hidden, minimized, not visible or in power-saving circumstances when safe.
- Preserve currently supported pause/resume, frame and geometry tests.

**Suggested measurement targets (engineering goals, not guarantees):** responsive visual acknowledgment of local controls within ~100ms, common input handling without main-thread stalls, fluid animation targeting 60fps on supported hardware, stable memory across repeated open/close cycles. Measure GPU/CPU cost, microphone latency and action-cancellation latency independently. Do **not** treat webpage Core Web Vitals as native Electron UX metrics.

### UI-09 — All system states need a useful response (P1)

Define a reusable pattern for every state:

| State | Primary message | Available next action |
|---|---|---|
| Ready | `Ready. Microphone off.` | Talk / type |
| Listening | `Listening…` with real capture state | Stop listening |
| Understanding | `Understanding your request…` | Stop |
| Tool action | `Checking Bokjiro for application steps…` | Stop; view activity |
| Answer ready | Plain-language answer + source / checked time | Ask follow-up / hear again |
| Awaiting approval | Specific action + destination | Approve / edit / reject |
| Authentication handoff | `Complete login in the browser yourself.` + mic-off state | I finished / cancel |
| Offline or disconnected | `Connection lost. Your last step is saved if recoverable.` | Reconnect / type / new task |
| Recoverable failure | Explain what could not be done, without false success | Retry / view source / change approach |
| Stopped | `Stopped` only after stop acknowledgement as appropriate | Resume new request |

Use exact, localized labels; this table is illustrative. Never offer Resume if the checkpoint has expired or recovery is unsafe.

### UI-10 — Legibility and layout resilience (P1)

- Test text resizing to 200% and zoom/reflow to 400% on supported web surfaces, applying WCAG criteria appropriately.
- Ensure Korean line breaks, Japanese text, Chinese text and longer English translations do not clip buttons or force horizontal overflow.
- Use `min-width: 0`, intrinsic sizing and appropriate wrapping in flex/grid components. Preserve a stable input/composer and accessible scrolling.
- Audit the avatar's smaller text (some styles use `12–14px`) against real low-vision usability; offer larger display/text preferences before adding more compact text.
- Distinguish `secondary` information visually without reducing required content below usable contrast.
- Preserve scroll position when reviewing earlier messages; if new messages arrive while scrolled up, expose a **New messages** action instead of moving the reader unexpectedly.

### UI-11 — Validation with target users (P1)

The README states **zero completed real-user tests** as of the reviewed version; `docs/user-test/plan.md` already proposes a first study with visually impaired participants. Implement that plan before calling the experience universally usable.

- Recruit 3–5 adult users from the defined first cohort, with consent and appropriate research-ethics review.
- Include NVDA, relevant local Korean screen-reader use and VoiceOver where applicable.
- Compare with users' existing workflows, not a straw-man baseline.
- Use synthetic welfare scenarios only; never collect unnecessary real identifiers.
- Record success, help requests, time on task, corrections, unintended actions, trust, SUS and observed friction.
- Include noisy and quiet audio conditions, an unavailable microphone, disconnected network, language switching and browser authentication handoff.
- Include older adults and other digitally excluded populations in **separate follow-up cohorts** rather than assuming the first cohort represents them.

---

## 4. Interaction contract: one consistent experience

### Primary surface responsibilities

| Surface | Owns | Must not own |
|---|---|---|
| Desktop main process | Window/tray/shortcut management, trusted IPC and OS integration | Independent copy of task semantics or voice session truth |
| Full conversation | Session presentation, transcript, rich confirmations, settings, source evidence, typed input | Unsafe bypass around backend decisions |
| Avatar overlay | Status summary, deliberate Talk/Stop/Hide/Open controls, short choices | Direct service-side mutation, secrets, private field review, a second mic/audio session |
| Public-service website/browser | Official source content and user-operated authentication/submission | Instructions that override the assistant's policy or user consent |
| Backend/orchestrator | Task states, action authorization, identifiers, grounding, cancellation/recovery policies | Misleading progress values synthesized for aesthetic reasons |

### Decision and interruption sequence

1. A task result or actual browser state produces a display update with a stable decision ID.
2. Both the conversation and avatar show **the same decision**, using shared semantic labels.
3. Before accepting voice or click approval, validate the current decision identity and relevant page/action context.
4. Immediately disable or mark the submitted decision pending in both surfaces to prevent ambiguity; the backend remains the authority for deduplication.
5. On Stop, cancel the in-flight request when supported, withdraw stale choices and return to a recoverable or stopped state.
6. Do not claim a real-world action completed until the resulting screen or authoritative API confirms it.

### Modal and popover hierarchy

- **Modal:** First-run, settings, substantial consent/approval review where required. Focus managed, background inert and explicitly dismissible according to policy.
- **Non-modal contextual card:** Short decision beside avatar; never steals focus and should not hide browser content for long periods.
- **Toast/status:** Brief non-critical notification. Do not use toast-only feedback for durable errors, approvals or user decisions.
- **Transcript:** Persistent record for conversation, source evidence and correction. Preserve readable history and user scroll position.

---

## 5. Accessibility specification

**Target:** WCAG 2.2 AA for applicable web-rendered surfaces, plus practical keyboard and screen-reader acceptance on supported desktop platforms. Automated checks are necessary but not sufficient.

| Requirement | Implementation and test |
|---|---|
| Text contrast | Normal text ≥4.5:1; large text ≥3:1 unless an applicable exception. |
| Non-text contrast | Meaningful UI component boundaries and state indicators ≥3:1 where required. |
| Pointer targets | At least WCAG 2.2 AA minimum (generally 24×24 CSS px with exceptions); prefer 44×44+ for this audience. |
| Focus indicators | Clearly visible, non-obscured, consistent in all themes, including avatar overlay. |
| Keyboard | Tab/Shift+Tab, Enter/Space, Escape and global shortcuts; no keyboard trap or unexpected focus jump. |
| Semantic control names | Accessible name contains visible label text; icons do not stand alone without a useful name. |
| Screen-reader state | Single concise announcement for important transitions; do not flood live regions each time the backend polls. |
| Speech alternatives | Text controls and transcript always available when mic or audio output fails. |
| Motion | Respect reduced-motion preference and still-avatar mode; no critical meaning depends on animation. |
| Zoom and reflow | Required content/actions available and readable at enlarged scale without obstructive clipping. |
| Language | Correct document/element language for interface and mixed-language content. |
| Sensory redundancy | Important alerts are not communicated only by sound, color or moving character. |

**Reference:** [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [WAI-ARIA Authoring Practices: Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [WCAG target size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum).

---

## 6. Design QA and interaction test matrix

Run the matrix on **actual application builds**, not only isolated mock components.

| Scenario | Expected behavior | Automation target |
|---|---|---|
| First-run without API key | Clear supported fallback or setup guidance; no surprise mic/upload | First-run + consent E2E |
| Consent declined | No capture/upload and no misleading ready-to-record state | Unit + E2E |
| Voice capture starts | Mic indicator and actual capture agree | Microphone E2E |
| Tool takes longer than usual | Actual working status, cancel option, no fabricated progress | Stubbed slow backend |
| Stop while speaking | Playback interrupted and task cancellation requested | Unit + E2E + native |
| Stop during approval | No stale action executes afterward | Approval E2E |
| Two approval inputs at once | At most one authorized action | Existing regression + cross-window E2E |
| Browser login required | Mic-off handoff, verified page on return | Auth/recovery E2E |
| Overlay passive bubble | Chrome retains focus | Native desktop test |
| Overlay quick-choice shortcut | Focus moves deliberately to choices and returns safely | Native keyboard test |
| Overlay moved or hidden | No duplicated session; window does not block the underlying page | Native multi-monitor/manual |
| 125–200% display scaling | No clipped avatar, no inaccessible card, no lost focus ring | Screenshot + manual |
| English/Chinese/Japanese | No accidental Korean-only chrome; choices fit | Localized UI snapshots |
| Reduced motion / still mode | Static feedback remains understandable | Existing avatar test + manual |
| Offline/reconnected | Correct state and safe recovery boundary | Stubbed network fault test |
| Screen reader with TTS enabled | No duplicated or overlapping critical announcements | NVDA/VoiceOver manual |
| External evidence unavailable | Clear limitation; no invented amount/eligibility | Grounding E2E |
| Real submit or identity verification | Remains explicitly user-operated as designed | Policy regression |

### Existing commands to reuse

Run from the root of the **current TypeScript checkout** (Node requirement in `package.json` is `>=24`):

```bash
npm ci
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
npm run build:web
npm run start:desktop
```

Desktop-specific checks exist too; execute on compatible operating systems and with appropriate test fixtures:

```bash
npm run test:desktop
npm run test:desktop-avatar
npm run test:desktop-native
npm run test:desktop-packaged
```

These are **existing script names**, not a claim that they passed during this review. Do not report a test as passed unless it actually ran and passed in the edited checkout.

### Add or expand automated coverage

- Token/theme accessibility snapshots (light, dark, high contrast, forced colors).
- Screenshot baselines for 360, 768, 1024, 1440px web view widths and relevant Electron window geometries.
- Large-text and language expansion tests (Korean, English, Chinese, Japanese).
- One canonical cross-window state/choice contract test.
- Live-region announcement-count assertions for repeated polls and interrupted tasks.
- Overlay click-through and focus-return tests on Windows.
- Memory/performance soak test: many conversation opens/closes, avatar shows/hides, repeated audio sessions, network failures.
- Manual screen-reader and usability evidence attached to the release decision.

---

## 7. Implementation order with release gates

### Phase A — Audit and correctness (P0)

**Tasks:** Capture screenshots/recordings and current state behavior; establish baseline; inventory UI strings; map task/mic/playback status; audit focus and announcements; verify consent/Stop/approval/auth tests.

**Exit gate:** No unknown consequential-action regression; baseline screenshots exist; key states are accounted for; localization and accessibility gaps are recorded as reproducible tickets.

### Phase B — Consistency and hierarchy (P1)

**Tasks:** Consolidate semantic tokens incrementally; unify buttons/cards/status presentations; localize remaining application chrome; reorganize the information hierarchy without breaking the existing UI contracts.

**Exit gate:** Consistent visual treatment across main window and avatar, no mixed-language interface chrome, no new contrast or keyboard regressions.

### Phase C — Smoothness and resilience (P1)

**Tasks:** Profile UI/overlay animation; tune motion; improve disconnect/loading/retry/empty states; verify DPI, small screens, low-power devices and multi-monitor behavior.

**Exit gate:** No major visible jank in the tested hardware matrix; a user can always interrupt or recover; overlay never blocks the primary task unexpectedly.

### Phase D — Validation and release (P1–P2)

**Tasks:** Extend native accessibility testing; run the planned user study; review real usability findings; compare before/after task completion and error rates; publish a release checklist.

**Exit gate:** Safety regression suite passed, known accessibility blockers resolved, participant feedback reviewed, all claimed KPIs backed by measured data.

**Change control:** One focused PR per area where possible (localization, token consolidation, state UI, native focus, motion, tests). Capture baseline before each refactor. Do not replace the framework, introduce redundant state managers, modify unrelated backend intelligence, or overwrite uncommitted work without an explicit need.

---

## 8. Suggested performance and experience scorecard

These are **proposed targets** to be measured after establishing a baseline, not observed repository performance.

| Measure | Initial target / release expectation |
|---|---|
| Control acknowledgment | UI responds locally within about 100ms in ordinary conditions; measure 95th percentile. |
| Motion quality | Smooth at target refresh rates, commonly 60fps, on supported baseline hardware. |
| Stop response | Immediate local acknowledgment; backend cancellation time reported separately. |
| State correctness | 100% match of displayed capture/playback state against instrumented events in test scenarios. |
| Duplicate execution | Zero unauthorized duplicate consequential actions in the regression matrix. |
| Accessibility blockers | Zero known critical blockers in tested core flows; automated axe report plus manual verification. |
| Localization completeness | 100% of application-owned core-flow copy covered for `ko`, `en`, `zh`, `ja`. |
| Task completion | Establish participant baseline before choosing a statistically meaningful improvement target. |
| Trust/understanding | Ask whether users could accurately explain what the agent was doing and what it would do next. |
| Resource consumption | Profile idle CPU/GPU, memory, overlay wake/sleep and audio sessions; set limits from hardware evidence. |

---

## 9. Ready-to-paste prompt for a coding agent

> You are upgrading the existing Cheongeum (`davemaxuell/voice-welfare`) UI to commercial-grade quality. Treat this document as your implementation specification and **read the current TypeScript source** before changing anything. This is an incremental improvement, **not** a redesign-from-scratch or framework migration.
>
> First read `README.md`, `package.json`, `web/src/App.tsx`, `web/src/view.ts`, `web/src/conversation.ts`, `web/src/styles.css`, `web/src/avatar/overlay.ts`, `web/src/avatar/overlay.css`, `web/src/FirstRun.tsx`, `web/src/SettingsDialog.tsx`, `apps/desktop/src/main.ts`, `docs/rules.md` and relevant tests. Existing November 19 documentation may mention obsolete Python/static paths; prefer active build references.
>
> **Step 1:** Inspect the current git status and preserve all existing work. Establish UI/screenshots, test and accessibility baselines. Write down verified gaps; do not invent bugs.
>
> **Step 2:** Implement P0 work in small changes: complete core UI localization, synchronize truthful mic/playback/task status, audit focus and announcements, preserve approval/Stop/consent/auth policy behavior. Run relevant tests after each slice.
>
> **Step 3:** Implement P1 changes: unify semantic tokens across the conversation and overlay, improve task hierarchy, optimize avatar readability/geometry, tune motion with reduced-motion support, and provide coherent loading/error/recovery states. Preserve existing behavior and visual identity unless evidence supports a focused change.
>
> **Step 4:** Expand Playwright/Vitest and native accessibility regression tests. Run `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:e2e`, `npm run build:web`, plus applicable desktop tests. Never claim unrun checks passed. Include manual NVDA/VoiceOver checks as a release requirement, clearly distinguished from automated checks.
>
> **Step 5:** Produce a change log mapping every work item to affected files, before/after screenshots where available, test outcomes, measured performance and any remaining risks. Favor focused, reviewable commits or PRs. Do not touch unrelated backend logic, secret storage, private datasets or real-world action policy.
>
> Safety acceptance is mandatory: no real form submission by the agent, no unauthorized account/authentication action, no PII leaked to the passive overlay, no double approval execution, no autofocus into Chrome from passive cards, and a consistently accessible Stop path.

---

## 10. Repository and standards references

**Code and project docs**

- [Repository README](https://github.com/davemaxuell/voice-welfare/blob/main/README.md)
- [Current React workspace](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/App.tsx)
- [Main styles and existing theme tokens](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/styles.css)
- [Floating avatar controller](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/overlay.ts)
- [Avatar styles](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/overlay.css)
- [Electron shell](https://github.com/davemaxuell/voice-welfare/blob/main/apps/desktop/src/main.ts)
- [Original avatar design specification](https://github.com/davemaxuell/voice-welfare/blob/main/docs/superpowers/specs/2026-11-19-avatar-assistant-ui.md)
- [Desktop handoff and earlier assumptions](https://github.com/davemaxuell/voice-welfare/blob/main/docs/desktop-ui-handoff.md)
- [User-study plan](https://github.com/davemaxuell/voice-welfare/blob/main/docs/user-test/plan.md)
- [Policy and voice/agent rules](https://github.com/davemaxuell/voice-welfare/blob/main/docs/rules.md)

**External normative/product references**

- [W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [Understanding target size (minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
- [WAI-ARIA Authoring Practices — Modal dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [Microsoft Fluent 2](https://fluent2.microsoft.design/)
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Material Design 3](https://m3.material.io/)
- [Electron accessibility guidance](https://www.electronjs.org/docs/latest/tutorial/accessibility)

**Final principle:** *A high-quality assistant must feel calm and capable because its behavior is reliable and comprehensible, not because its animation is elaborate.*
