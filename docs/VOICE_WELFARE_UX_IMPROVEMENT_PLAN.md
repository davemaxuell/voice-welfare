# Cheongeum / Voice Welfare — Commercial-Grade UX Improvement Plan

**Repository:** [davemaxuell/voice-welfare](https://github.com/davemaxuell/voice-welfare)  
**Product:** 청음 (Cheongeum), a voice-first assistant for navigating Korean public services  
**Reviewed branch:** `main`  
**Reference commit:** [`bd096bb8085f3eaaab67d8bd89e7508edf66398d`](https://github.com/davemaxuell/voice-welfare/commit/bd096bb8085f3eaaab67d8bd89e7508edf66398d) (2026-11-21)  
**Document date:** 2026-11-21  
**Scope:** UX, UI, voice interaction, accessibility, onboarding, agent transparency, reliability, and UX validation.  
**Status:** Proposed implementation plan; **not** an assertion that every recommended change is currently missing.

> **Evidence boundary:** This report is based on a read-only review of repository code and project documentation through GitHub. I did **not** install or launch the app, run its test suite, conduct usability sessions, or observe a live production deployment. Findings from older pilot reports are historical regression signals and must be rechecked against the referenced TypeScript `main` commit. Do not confuse existing test coverage with successful real-user validation.

---

## 1. Product objective and non-negotiables

**Goal:** Make Cheongeum feel like a reliable, commercially deployable assistant that people—especially older adults, blind/low-vision users, first-time computer users, and multilingual Korean public-service users—can operate independently and confidently.

A successful experience lets someone:

1. Understand the assistant's purpose and limitations immediately.
2. Start, stop, and correct a voice interaction without memorizing commands.
3. Know whether the microphone is **off, listening, processing, or speaking**.
4. Understand what the agent is doing, which website it is interacting with, and what needs their approval.
5. Hear the answer and, when useful, inspect concise on-screen evidence, dates, links, and next actions.
6. Recover from wrong recognition, network failure, unavailable sites, authentication handoff, and unexpected cancellation.
7. Finish a useful task without exposing credentials or accidentally submitting an official form.

**Preserve the existing safety contract.** The real official application/submission step, login, identity verification, and security codes stay under the user's control. Practice-site submissions must be visually and audibly marked as simulations. Never represent an attempted browser action as completed without verification. Never send voice or screen content before informed consent.

**Guiding priorities:** **functional correctness and consent > accessible control > clear feedback > task completion > efficiency > visual refinement**. Animation is not proof of usability.

---

## 2. What the repository already implements

Do not redesign or reimplement existing features blindly. Confirm them first.

| Existing foundation, observed in source | Current entry points | Recommended next action |
|---|---|---|
| React 19, TypeScript, Vite web interface; Electron desktop shell | `web/src/App.tsx`, `apps/desktop/src/main.ts`, `package.json` | Incrementally refine existing components; do not propose a new frontend framework or rewrite. |
| Conversation, keyboard input, one-shot voice and live conversation controls | `web/src/App.tsx`, `web/src/conversation.ts`, `web/src/mic.ts`, `web/src/voice-edge.ts` | Audit mode transitions, cancellation, latency, focus and transcripts. |
| Desktop avatar, small quick-choice card, still-image fallback, preferences and tray interactions | `web/src/avatar/overlay.ts`, `web/src/avatar/overlay.css`, `apps/desktop/src/main.ts` | Validate focus, status accuracy, visibility and performance on actual desktop hardware. |
| Confirmation, rejection, mock receipt and human authentication handoff | `web/src/App.tsx` (`Decisions`), backend approval and browser paths | Make actions, effects and ownership explicit; test race conditions and stale decisions. |
| First-run dialog and separate settings dialog | `web/src/FirstRun.tsx`, `web/src/first-run.ts`, `web/src/SettingsDialog.tsx` | Verify voice-only completion and friction; do not claim onboarding is absent. |
| High-contrast styling, visible-focus CSS, skip link, `role="log"`, reduced-motion behavior | `web/src/styles.css`, `web/src/avatar/overlay.css`, `web/src/App.tsx` | Keep these, then validate with real screen readers and forced-colors/reduced-motion modes. |
| Welfare sources, source-check dates, action history and a status panel | `web/src/App.tsx` (`AnswerPanel`, `StatusPanel`, `sources-panel`, `actions-panel`) | Consolidate presentation and make uncertainty prominent. |
| Background research and saved-note controls with periodic refresh | `web/src/workflows.tsx`, `src/server/workflows.ts` | Add clear queued/running/error/needs-input/complete experiences and reliable accessibility announcements. |
| Automated evaluation, native desktop tests, user-study plans | `tests/e2e/`, `apps/desktop/test/native-a11y.cjs`, `docs/user-test/` | Separate synthetic pass rates from results observed with people. |

**Evidence links:** [App.tsx](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/App.tsx) · [overlay.ts](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/overlay.ts) · [main.ts](https://github.com/davemaxuell/voice-welfare/blob/main/apps/desktop/src/main.ts) · [first-run spec](https://github.com/davemaxuell/voice-welfare/blob/main/docs/superpowers/specs/2026-11-19-first-run-setup-design.md) · [user-test plan](https://github.com/davemaxuell/voice-welfare/blob/main/docs/user-test/plan.md).

### Specific issues and verification targets

**F01 — Partial localization of the core screen (confirmed in source).** `App.tsx` routes many strings through `workspaceText(...)`, but others are literal Korean, including decision headings (`실행하기 전에 확인해 주세요`, `직접 인증이 필요해요`), mock receipt text, answer/source section headings, status field labels and sidebar headings. These can remain Korean when English, Chinese or Japanese is selected. Centralize user-visible strings and add locale coverage tests.

**F02 — First-run independence must be proven (validation gap).** `FirstRun.tsx` implements a modal setup flow, but `docs/superpowers/specs/2026-11-19-first-run-setup-design.md` explicitly discusses voice-only usability and helper/user handover. The presence of an accessible dialog is not evidence that a person unfamiliar with keyboards or API keys can independently finish setup. Verify the implementation against the spec and run observed sessions.

**F03 — BYOK setup is an adoption barrier (product decision).** The current interface requests an OpenAI API key (`SettingsDialog.tsx`, `FirstRun.tsx`). For a mainstream welfare product, this is substantial friction, especially for less technical users. Retain a safe bring-your-own-key path if needed, but consider a managed account/subscription/organization-provisioned path. This is a product proposal, not a code defect. Never silently bill a user.

**F04 — Overlay position follows the primary monitor (confirmed code behavior).** `apps/desktop/src/main.ts` computes overlay placement with `screen.getPrimaryDisplay().workArea`. This can be acceptable as a default, but follow-browser, monitor selection and hot-plug behavior should be designed and tested explicitly. Preserve tray and shortcut alternatives if the overlay is inaccessible.

**F05 — Background task operation uses 3.5-second polling and a generic error pathway (confirmed source behavior).** `web/src/workflows.tsx` calls `refresh()` every 3500 ms while expanded and maps several errors to generic copy. Make the current state and next recovery action explicit, and ensure visible feedback begins immediately on submit. A push mechanism is optional; *clarity* is the requirement.

**F06 — Dense main screen may increase mental workload (design hypothesis).** `App.tsx` displays a conversation beside status, sources, actions, audio settings and research panels. The density is potentially costly to first-time or screen-reader users. Validate against real tasks before restructuring; use progressive disclosure and task-oriented summaries.

**F07 — Long, animated transitions need task testing (performance hypothesis).** `web/src/styles.css` defines spring durations including `--spring: 620ms`; overlay controls and character poses animate. Reduced motion is considered in code. Audit actual animation frequency and apparent input latency. Eliminate animation that makes Stop, approval or form feedback feel late.

**F08 — Historical failures warrant explicit regression gates, not assumed current defects.** `docs/2026-11-19-0700-welfare-agent-qa.md` describes wrong eligibility geography, spurious authentication, and navigation completing after Stop. The follow-up document reports fixes and regression tests on an older working tree; it also lists unresolved verification of real Chrome, NVDA, translation quality, focus, duplicate announcements, and follow-up context. Reproduce or disprove these against the **current** TypeScript branch before filing bugs.

**F09 — Real-user evidence is missing from the repository's reported baseline.** The README says real-user testing was at zero as documented, while simulated tests and axe checks exist. Treat commercial readiness as **unvalidated** until participant tests, native assistive-technology runs, and representative network/site failures are recorded.

---

## 3. Priority backlog (implement in this order)

Definitions: **P0** = core safe/independent use; **P1** = reliability and coherence; **P2** = polish/optimization. Recommended acceptance criteria below are **targets**, not verified current scores.

| ID | Priority | Workstream | Concrete delivery | Done when |
|---|---|---|---|---|
| UX-01 | P0 | Complete locale coverage | Centralize all visible and spoken UI strings, pluralization and formatting | `ko/en/zh/ja` core journeys show no unintended Korean-only system chrome; native-language review logged |
| UX-02 | P0 | Voice state truthfulness | One canonical display contract for mic capture, model processing, TTS and browser task | On-screen/ARIA/overlay/tray indicators agree with actual subsystem states |
| UX-03 | P0 | Immediate Stop | Stable Stop available by button, tray, voice and documented shortcut where supported | Stopping interrupts audible output and prevents stale queued work; outcome explicitly confirmed |
| UX-04 | P0 | Approval and handoff | Clear action/site/scope preview; fresh approval binding; secure login handback | Exactly one effective action per approval; user can cancel; official submit remains manual |
| UX-05 | P0 | Accessible first run | Consent, key provisioning, mic check, intro, helper handover and solo path | All essential paths usable by keyboard and tested with NVDA; no capture before consent |
| UX-06 | P0 | Honest source & eligibility explanation | Distinguish verified facts, user-supplied facts and unknown eligibility conditions | No unsupported claim of benefit eligibility, approval, contact hours or application success |
| UX-07 | P0 | Failure recovery | Explicit microphone/network/model/browser/consent/site errors with next steps | Every blocking error offers a safe retry, input fallback, official page or clear stop |
| UX-08 | P1 | Simplify task-focused layout | Primary conversation + compact task summary; secondary advanced disclosure | Main action, current state and next step found without scanning the whole sidebar |
| UX-09 | P1 | Background task lifecycle | Dedicated task cards or compact task list with state and timestamps | Queued/running/needs input/partial/failed/done are distinct and accessible |
| UX-10 | P1 | Cross-surface continuity | Sync overlay, conversation window, tray and browser handoff | Opening/closing UI doesn't duplicate speech, approvals, tasks or messages |
| UX-11 | P1 | Desktop positioning and focus | Monitor/edge preference, bounds safety, focus restoration, pass-through outside controls | Works with multiple displays, scaling, Chrome and screen readers; tray-only mode remains usable |
| UX-12 | P1 | Corrections and context | Edit a misheard utterance; keep referenced service/site and negation across follow-ups | A correction changes the task; previous unsafe or obsolete intent cannot execute |
| UX-13 | P1 | Task measurement | Privacy-safe UX telemetry + study protocol | Task completion, retries, errors and end-to-end latency are measurable by task type |
| UX-14 | P2 | Motion/perceived speed | Motion hierarchy, reduced-motion parity, bounded render cost | No decorative effect delays or obscures a consequential action; idle avatar is inexpensive |
| UX-15 | P2 | Visual system | Reusable tokens, typography, buttons, spacing, alerts and empty states | Screens feel consistent at 100–200% scaling and in high-contrast themes |
| UX-16 | P2 | Productized onboarding | Evaluate managed key provisioning and clear usage/cost/privacy communication | First-time users understand costs and permissions without developer knowledge |

### Phase gates

- **Gate A (P0):** safe, accessible core workflow plus verified stop/approval behavior and localization coverage.
- **Gate B (P1):** reliable end-to-end operation across desktop surfaces, measured error recovery, actionable status.
- **Gate C (P2):** polish and optimization measured *after* task-completion issues are resolved.

Do not begin a wholesale reskin before Gate A.

---

## 4. UX interaction contract

### 4.1 Present a single, comprehensible task state

Use one backend-derived task status model, exposed consistently to the web screen, desktop avatar and assistive technologies. Do **not** implement a second independent task state machine in the avatar.

Proposed conceptual states (map to existing domain states rather than duplicating them):

```text
IDLE
  ├─ user deliberately starts microphone → LISTENING
  ├─ user types a request             → UNDERSTANDING
  └─ restored task                    → REVIEWING / WORKING

LISTENING → TRANSCRIBING* → UNDERSTANDING → WORKING
        ↘ NO_SPEECH / MIC_FAILURE

WORKING → NEEDS_CHOICE / NEEDS_APPROVAL / AUTH_HANDOFF
        → ANSWERING / PARTIAL / FAILED

ANSWERING → SPEAKING → COMPLETED → IDLE
         ↘ INTERRUPTED / STOPPED

AUTH_HANDOFF → VERIFIED_RETURN → WORKING
             ↘ CANCELLED / EXPIRED / WRONG_PAGE

ANY ACTIVE STATE → STOP_REQUESTED → STOPPED (only after confirmation)
```

`TRANSCRIBING` is optional for the real-time conversation pipeline: display only actual states, not fabricated phases. Speech/audio state may be **orthogonal** to browser-task state: e.g., the agent may be working while TTS is idle. Avoid reducing a concurrent system to one misleading indicator.

Each user-visible state must declare:

| Property | Requirement |
|---|---|
| Human-readable status | Specific, concise: e.g., “Checking application requirements on Bokjiro.” |
| Spoken status | Announce changes selectively; avoid speaking every low-level tool step. |
| Primary action | What the user can do **now**: Stop, Retry, Confirm, Open official page, or Speak again. |
| Mic truth | Distinguish actual capture from permission granted, and from available-but-off. |
| Result certainty | Attempted / observed / verified / not completed. |
| Accessible event | Announce meaningful state changes once; avoid competing live regions. |
| Cross-surface identity | Same task, turn and approval identifiers across main window and overlay. |

### 4.2 Voice controls: strict behavior

- **Talk:** clearly signifies when capture starts and stops; show privacy-safe input feedback, not fake equalizer movement.
- **Stop:** highest-priority intent; interrupts local playback immediately, cancels in-flight work where supported and invalidates pending decisions. Confirm once a stop is established; do not claim the browser stopped until the controller verifies it.
- **Barge-in:** if permitted and technically available, distinguish interrupting TTS from cancelling the task; provide separate **Stop speaking** vs **Stop task** actions where needed.
- **Silence/no speech:** present a short recovery path, never an infinite “listening...” state. E.g., “I didn't hear anything. Try again or type.”
- **Misrecognition:** allow correction before consequential execution: “I heard ‘장애수당’. Did you mean ‘장애인연금’?” for material ambiguity.
- **Language switch:** current utterance can switch to a supported language; response/controls should use the chosen language consistently without losing the task's website and service reference.
- **Speech speed:** user choice persists when appropriate; a one-time “read that number slowly” must not silently change the saved global rate.
- **Fallback:** typing, keyboard shortcuts and/or tray actions remain possible without a microphone. Essential actions must not require voice.

**Suggested Korean microcopy** (localize all languages and verify with native speakers):

| Event | Recommended short copy |
|---|---|
| Ready | `준비됐어요. 말하기를 눌러 시작하세요.` |
| Mic actively capturing | `듣는 중 · 마이크 켜짐` |
| Mic not capturing | `마이크 꺼짐` |
| Working | `복지로에서 신청 방법을 확인하고 있어요.` |
| Unsupported site | `이 사이트는 자동으로 조작할 수 없어요. 공식 안내를 열어드릴게요.` |
| Need browser handoff | `이제 브라우저에서 직접 인증해 주세요. 마이크는 꺼져 있어요.` |
| Auth return | `인증이 끝났다면 '확인했어요'를 눌러 주세요. 화면을 다시 확인할게요.` |
| Stop verified | `작업을 멈췄어요. 아직 제출한 내용은 없어요.` **only when verified true** |
| Uncertain eligibility | `이 조건만으로는 대상 여부를 확정할 수 없어요.` |
| Practice result | `연습 접수 완료 · 실제 기관에 제출되지 않았어요.` |

Do not render a reassuring assertion (“nothing submitted,” “your data is safe,” “you're eligible”) unless the application can substantiate it.

### 4.3 Confirmation contract

For anything with real-world consequences, the review must show:

1. **Action:** what the assistant is about to do, in ordinary language.
2. **Destination:** verified domain/service and, for file transfers, the recipient.
3. **Data category:** a privacy-preserving description of data involved; do not print secrets in an overlay.
4. **Consequence:** reading, typing, opening, sending, or an irreversible action.
5. **Three actions:** appropriate Approve, Edit/Review, and Cancel alternatives.
6. **Outcome:** action attempted vs verified result, without stale-card reuse.

Use stable, descriptive button labels such as “Approve entering this address” rather than generic “OK.” Bind the approval to the current task, observed page and payload fingerprint server-side. Reject duplicate clicks and obsolete approvals.

---

## 5. First-run experience: from technical setup to first value

The current first-run components should be **refined and validated**, not replaced without evidence. Recommended sequence:

| Stage | User question answered | Design rule |
|---|---|---|
| 1. Welcome | “What does Cheongeum do?” | One short value proposition; optional listening introduction and skip. |
| 2. Language | “Can it speak my language?” | Korean/English/Chinese/Japanese labels readable in their own scripts; change immediately. |
| 3. Provisioning | “How do I start?” | Explain API key if BYOK; offer administrator/helper pathway; never make an ordinary user guess where keys come from. |
| 4. Consent | “What will it hear/read/send?” | Explain mic, external model, screen capture conditions, stored data and withdrawal; user gives their own consent. |
| 5. Sound & mic test | “Can I hear and be heard?” | Optional sample playback, input test, device choice and direct error recovery. |
| 6. User control practice | “How do I stop it?” | Practice Talk and Stop before web automation. |
| 7. First useful task | “Did it help me?” | Run a safe public-service lookup, show official source and next step. |
| 8. Optional preferences | “Can I customize it?” | Speech speed, avatar motion, tray, browser choice, region. Advanced settings remain optional. |

**Important constraint:** No microphone recording or transmission before consent. If an audio introduction uses pre-generated clips, distinguish them from voice capture. A helper may configure software but must not give consent on behalf of the eventual user.

**Potential product decision:** A consumer-oriented product should preferably provide managed provisioning (or organizational access) instead of requiring every resident to create and fund an API account. Treat this as a separate pricing, identity and regulatory decision; don't rush into storing shared API keys on clients.

**Acceptance tests:** first run with keyboard only; first run with NVDA; sighted older user with no API familiarity; helper-to-user handover; mic denied; invalid API key; offline setup; restart midway; personal/shared PC; no external audio before consent; user declines consent.

---

## 6. Main window information architecture

Keep the conversation as the central work surface. Make the sidebar secondary.

### Recommended hierarchy

```text
┌──────────────────────────────────────────────────────────────┐
│ Cheongeum     [Mic: OFF]           [Settings] [STOP] [End]   │
├──────────────────────────────────────────────────────────────┤
│ Current task: Check basic pension application requirements  │
│ Checking official information on Bokjiro…       [Stop]      │
├───────────────────────────────────┬──────────────────────────┤
│ CONVERSATION                      │ TASK DETAILS (optional)  │
│                                   │ Current site             │
│ User question                     │ Verified actions         │
│ Assistant answer + next step      │ Sources / dates          │
│ [View source] [Read again]         │ Permissions              │
│                                   │                          │
│ [Speak / Type question      Send] │ Advanced: audio, notes   │
└───────────────────────────────────┴──────────────────────────┘
```

This is a **wireframe of hierarchy**, not a demand to discard the current two-column implementation.

- On smaller windows or at 200% zoom, move task details into a drawer/disclosure **after** the conversation in reading order; keep the composer and Stop reachable.
- Show **one** primary action per stage; do not display competing primary buttons for different meanings of Start, Talk, Send, Stop speaking and End session.
- “Stop speaking,” “Stop current task,” and “End session” must have distinct labels and distinct effects. Avoid relying on color alone to communicate the difference.
- Preserve the current answer’s source, reference date, check date and next step; prioritize the *next step* in the summary and expose provenance without making people read a long audit panel.
- Long chat history should not automatically steal scroll from someone reading prior messages. The current code has some follow-scroll safeguards; test them.
- Empty states should be useful: show 2–3 example tasks relevant to the product, not a wall of features.

### Task result template

```text
[Result] Basic pension application information
Answer: [one or two plain-language sentences]
Source: [Verified public service or government page]
Checked: [actual local date/time]; Reference: [published data date, if known]
What Cheongeum verified: [specific facts]
What remains uncertain: [missing eligibility, latest notices, etc.]
Next step: [Open official information]  [Read aloud]  [Ask a follow-up]
```

Never automatically transform generic public data into a categorical eligibility decision. Keep resident-provided facts distinct from validated institutional criteria.

---

## 7. Desktop avatar and overlay

The avatar is a **task companion**, not a substitute for usable application controls.

- **Resting:** quiet, low distraction. Show a persistent mic state, and a predictable Talk affordance. Do not imply listening when capture is off.
- **Working:** short informative task label; do not endlessly animate as if progress is guaranteed. If no progress can be measured, use an indeterminate indicator with text.
- **Need user:** display one question and ideally 2–3 choices, with voice and keyboard equivalents; keep the same choice IDs in the full conversation.
- **Offscreen/hidden:** tray and keyboard access continue to work; hiding avatar does not itself cancel a task.
- **Focus:** automatic cards must not steal Chrome input focus. Deliberate opening may focus controls. Return focus appropriately when closed.
- **Display behavior:** handle screen resolution, display scaling, changed primary monitor, dock/taskbar work areas and positioning at each edge. Since current positioning uses the primary display, decide whether a user-selected or active-browser display should be supported.
- **Mouse pass-through:** the overlay's transparent space must not obstruct Chrome; real physical click tests are necessary.
- **Reduced motion:** respect OS setting and the existing still-avatar preference. Provide identical information without animation.
- **Performance:** pause 3D rendering when covered, hidden, idle or displaying only a still pose; keep WebGL fallback. Measure memory/GPU impact on modest machines.
- **Trust:** never show sensitive form values or credentials on the floating card; use the main review surface.

**Preserve existing components:** `web/src/avatar/overlay.ts`, `overlay.css`, `web/avatar/index.html`, `apps/desktop/src/main.ts` and `apps/desktop/test/native-a11y.cjs` already implement relevant mechanics. Confirm behavior before rewriting.

---

## 8. Visual design system and motion rules

A consistent visual system can be built with existing CSS tokens; no framework migration is necessary.

### Typography and layout

- Base body text: approximately **16–18 px**, or larger when selected; adapt to user font scaling. Long Korean reading text benefits from generous line height (typically **1.5–1.7**).
- Control labels: use meaningful words, not icon-only controls where discoverability is critical.
- Spacing: choose a small consistent scale such as **4, 8, 12, 16, 24, 32 px**; maintain stable placement of consequential actions.
- Breakpoints must also respond to **desktop window resizing and 200% browser zoom**, not only device width.
- Keep visible keyboard focus and logical heading order. Do not communicate state through color alone.
- Keep target sizes generously large for motor accessibility; aim for **44 × 44 CSS px** where feasible (a design target, not a blanket WCAG 2.2 AA minimum).
- Aim for **WCAG 2.2 AA** as a product accessibility target, including **4.5:1 contrast for normal text** and appropriate non-text contrast. Use real contrast testing.

### Motion

| Motion type | Recommendation |
|---|---|
| Button press | Immediate feedback; generally <150 ms; don't delay the action. |
| Panel reveal | Brief 150–250 ms transition if it improves context. |
| Layout reflow | Avoid decorative long-distance motion; respect reduced-motion settings. |
| Agent thinking | A subtle, nonessential activity cue; keep text status authoritative. |
| Avatar speech | Sync to actual playback state, never predicted speech timing. |
| Stop / approval | Response should be immediate; no waiting for a character animation. |

These durations are **design heuristics for experiments**, not mandatory platform specifications. The repo's existing long spring animation may be visually appealing; keep it only where it measurably improves understanding.

### Standard component states

For every button, input, task card, microphone control, dialog and system alert, design **default, hover (where relevant), focus-visible, pressed, disabled with explanation, loading, success, error, and reduced-motion** states. Avoid inert controls and misleading spinners.

---

## 9. Accessibility and inclusive-use verification

Automated axe runs are helpful, but **not sufficient** for a voice-first desktop app used by blind and older residents.

**Keyboard-only:** reach consent, Talk, Stop, choice cards, site handoff, sources, Retry and End. No focus trap in dialogs. Preserve focus during added messages and task-card transitions. Check that global shortcuts do not block OS or screen-reader shortcuts and provide discoverable alternatives.

**Screen readers:** test Windows + NVDA (primary), Windows + the locally relevant Korean screen reader if available, and macOS + VoiceOver if macOS is supported. Verify live announcements announce each consequential change once and do not talk over TTS. Test language tagging and pronunciation of Korean public-service terms in foreign-language responses.

**Low vision:** test 200% zoom, 125–200% OS scale, high contrast, forced colors, varying window sizes, line wrapping, focus not obscured, text spacing, and screen magnification.

**Motor and speech differences:** targets should be forgiving; do not enforce timed speech-only decisions; provide touch/mouse, keyboard, text and voice alternatives. Test a slower speech rate, background noise, interruptions and varied microphones.

**Plain language:** avoid unexplained technical terms (API, WebRTC, LLM, 인증서). Replace with brief, task-oriented explanations when users are performing welfare tasks. Provide optional “More technical details” for administrators.

**Consent:** read full information on request; support refusal, withdrawal, and revisiting settings. A screen reader should be able to review what is going to happen before the consequential action.

### Known historical accessibility regression themes to revalidate

The 2026-11-19 QA follow-up explicitly called out: focus following consent/mic transitions, a microphone error overwriting a Stop announcement, an axe region issue, and duplicate authentication cues. **Do not mark these as open bugs without reproducing on current `main`; do include tests for each.**

---

## 10. Background research and persistent work

`web/src/workflows.tsx` already supports research jobs, notes, cancellation/deletion and follow-up questions. Improve the lifecycle:

| State | User-facing label | Required action / detail |
|---|---|---|
| Queued | “Waiting to start” | Reason, created time, Cancel |
| Running | “Checking sources” | Last verified step, updated time, Stop |
| Needs input | “One answer needed” | Single clear question, Reply, Cancel |
| Partial | “Part of the answer is ready” | What is done, what is missing, Continue or Finish |
| Failed | “Could not complete this search” | Cause if known, Retry and alternative |
| Completed | “Ready for review” | Summary, sources, checked dates, Read aloud |
| Cancelled | “Stopped” | What completed before cancellation; no false rollback claim |

Use backend events if they exist and are safe to reuse; otherwise polling can remain. The UX requirement is **immediate action acknowledgement** and correct, eventually consistent state, not a particular transport mechanism.

**Avoid hidden completion:** if a task finishes while the panel is collapsed, show a nonintrusive status in the main task area or a user-consented notification. Make it safe for shared PCs and avoid sensitive notification text.

**Accessibility:** add semantic task headings, state text and a carefully paced status announcement when a job completes or requires input. Use real buttons with unique accessible names, e.g. “Cancel research: basic pension requirements.”

---

## 11. Privacy, reliability and trust rules

1. **Consent-before-capture:** verify at the server boundary and browser/desktop UI; prohibit mic or screen transmission prior to the relevant user permission.
2. **Real versus mock:** use an unmistakable simulation indicator that persists into the receipt. Never imply actual filing occurred.
3. **Source provenance:** distinguish official current page, downloaded public snapshot and private/third-party program data. Show dates and incomplete conditions.
4. **Auth handoff:** release capture as designed, avoid collecting passwords/OTP, and verify the page on return. Never bypass CAPTCHA or automated-access barriers.
5. **Non-destructive recovery:** retain a task safely when a UI panel is hidden; invalidate approvals after task/page/payload changes; never retry an external write without idempotency safeguards.
6. **Least-disclosure UI:** use redacted summaries in overlay, notifications and telemetry; don't surface resident data on a locked/shared desktop.
7. **Error truthfulness:** distinguish “No source found,” “Could not access the site,” “The source is out of date,” and “You may not be eligible.” These are not interchangeable.
8. **Costs:** if an external LLM or paid SMS service is involved, explain the pricing model and obtain appropriate authorization before use.
9. **Connection loss:** preserve drafts where permitted and display an accurate reconnect/retry option; avoid claiming an action succeeded because a request was sent.
10. **Secure UX review:** never use actual residents' personal records in E2E fixtures; test with synthetic names, addresses and application IDs.

---

## 12. UX metrics, baselines and research plan

**Do not present these targets as achieved outcomes.** Establish actual baselines first and revise based on participant needs.

| Metric | Suggested initial target / measure |
|---|---|
| First useful task completion | ≥85% without facilitator intervention in representative pilot tasks; stratify by user cohort |
| Critical Stop success | 100% on a defined interruption test matrix; independently verify browser, audio, queue effects |
| Unauthorized real submissions | 0 observed, with defense-in-depth tests |
| Approval integrity | 100% of consequential simulated actions bound to the reviewed action and site |
| Voice-command recovery | ≥90% of scripted misunderstood-command cases recover within two corrective turns |
| Time to first value | Report p50/p95 from first launch to first useful sourced result, excluding voluntary setup pauses separately |
| Perceived responsiveness | Measure click-to-visual-feedback and utterance-end-to-first-meaningful-status (p50/p95) |
| End-to-end answer latency | Separate STT, orchestration, browser/tool, TTS and playback latency; record p50/p95 per task type |
| Task source/provenance | ≥95% of testable public policy answers cite usable evidence; critical numerical eligibility claims require exact verification |
| Accessibility | Zero known critical keyboard/assistive-technology blockers at release; record tested OS, reader and version |
| Usability | SUS and 1–7 confidence/trust ratings, plus qualitative confusion points; do not optimize the score alone |

**Study design:** Start with 3–5 blind/low-vision participants as already proposed in `docs/user-test/plan.md`, then include older adults, low-digital-literacy users and foreign-language users. This is a *formative pilot*, not statistical proof of universal usability. Counterbalance tasks and compare assisted versus unassisted completion. Synthetic data only. Review research-ethics and consent needs before recruitment.

**Priority participant scenarios:** T1 start a public-site lookup; T2 ask a follow-up with contextual reference (“that one”); T3 mishear and correct a benefit name; T4 handle an authentication handoff; T5 cancel while a page is loading; T6 resume a task after closing/reopening the conversation; T7 change languages midway; T8 complete a sample form without accidental submission; T9 use screen reader with avatar visible/hidden; T10 recover from mic denied/offline/expired job.

**Event instrument (privacy-safe):** `task_started`, `consent_shown`, `consent_granted`, `mic_capture_started`, `mic_capture_ended`, `turn_started`, `turn_status_changed`, `action_approval_shown`, `action_approval_resolved`, `external_action_verified`, `handoff_started`, `handoff_returned`, `stop_requested`, `stop_confirmed`, `task_completed`, `task_failed`, `retry_requested`. Attach only pseudonymous task ID, type, state, elapsed time, standardized error code, and coarse accessibility mode **if user consent permits**. Avoid raw utterances, filenames, addresses, page text, tokens and passwords.

---

## 13. Implementation sequence and repository map

### Sprint 0 — Grounded audit before changes

- [ ] Check out exact current `main` and record commit hash; use a feature branch for all changes.
- [ ] Run unit, e2e and desktop tests; separately log tests not run due to OS, microphone or credentials.
- [ ] Record baseline screenshots for consent, first run, ready, listening, working, approval, handoff, error, mock receipt, notes and overlay.
- [ ] Run a code audit of user-visible literal strings; build a locale coverage report.
- [ ] Exercise current UX flows with synthetic data on a real Windows desktop and Chrome.
- [ ] Reconcile previous QA reports with current TypeScript code before adding fixes.

### Sprint 1 — Accessibility and truth (P0)

- [ ] UX-01: centralized locale catalogs and dynamic component copy (`web/src/App.tsx`, `web/src/view.ts`, `web/src/workspace-language.ts`, `web/src/SettingsDialog.tsx`, `web/src/FirstRun.tsx`, `web/src/avatar/overlay.ts`, `web/src/workflows-text.ts`).
- [ ] UX-02: canonical audio/task state contract across backend, `conversation.ts`, App and overlay.
- [ ] UX-03: Stop and interruption test matrix, including in-flight navigation, page mutation, TTS and approval invalidation.
- [ ] UX-04: approvals, mock/real boundaries, login handoff and validated completion.
- [ ] UX-05: keyboard-first onboarding, mic denial, refusal/withdrawal and helper-handover states.
- [ ] UX-06/07: sourced answer uncertainty and error/recovery microcopy.

### Sprint 2 — Task completion and cross-surface coherence (P1)

- [ ] UX-08: simplify status presentation, responsive reading order and sidebar progressive disclosure.
- [ ] UX-09: background-work lifecycle, better errors and notifications where consented.
- [ ] UX-10/11: overlay focus, monitor positioning, hide/restore, native shortcuts and one-session ownership.
- [ ] UX-12: edit/clarify misrecognized utterances and retain follow-up context.
- [ ] UX-13: add consent-aware, privacy-safe UX instrumentation and participant test protocol.

### Sprint 3 — Product polish (P2)

- [ ] UX-14/15: tune animation, rendering cost, contrast, component tokens and responsive layout.
- [ ] UX-16: implement a **separately approved** product choice for managed versus BYOK provisioning, with transparent costs.
- [ ] Repeat usability sessions; compare real task-success and error-recovery results against baseline.

### Existing commands to use

From `package.json`:

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm run lint
npm run test:unit
npm run test:e2e
npm run build:web
npm run eval
npm run test:desktop
npm run test:desktop-avatar
npm run test:desktop-native
```

Some desktop tests require Windows, physical desktop access or hardware and may not run in headless CI. Record the environment and results; never report a test as passed when it was only reviewed or was skipped. Validate official-site integration only through permitted read-only operations; use synthetic endpoints for write-path coverage.

---

## 14. Acceptance-test scenarios (add or extend existing tests)

| Scenario | Assertion | Likely suite |
|---|---|---|
| Language selected as English | Core confirmation, status, error, result and overlay labels are English; no Korean-only hard-coded chrome | React/Vitest + E2E |
| Consent declined | No microphone capture, recording, screen transmission or backend session action requiring consent | E2E/API |
| Mic permission denied | Accessible explanation + Retry + Type instead; no stuck listening indicator | E2E/native |
| TTS interrupted | Playback stops immediately; task remains or is cancelled according to the chosen action | Unit/E2E/native |
| Stop during slow navigation | Agent indicates stop truthfully; no delayed unauthorized new page/action; pending approval invalidated | E2E/browser |
| Repeated approval clicks | Only one consequential action occurs; stale card rejected | Unit/E2E |
| Approval target changes | Changed page/payload requires new confirmation; prior confirmation rejected | E2E/browser |
| Simulated submission | Explicitly shown and spoken as simulation before and after result | E2E |
| Login handoff | Capture off, manual return available, unexpected page cannot be treated as completion | E2E/native |
| Assistant answers from stored data | Source type and data reference date distinguish stored snapshot from live page | Unit/E2E |
| Wrong district eligibility | Other-district benefit does not appear as a verified local entitlement | Unit/eval |
| Browser result unavailable | “Could not verify” with official alternative; no invented result | E2E |
| Language changes mid-task | Site, service and safe negative constraints preserved; next reply in new language | E2E/multilingual |
| Overlay shows passive card | Browser focus and transparent-region clicks are preserved | Native desktop |
| Avatar hidden and restored | Same conversation/task and approvals; no duplicate mic controller or duplicate assistant output | Native desktop |
| Two monitors and high DPI | Overlay visible, in work area, usable after display switch; tray/keyboard fallback | Manual/native |
| Reduced motion and no WebGL | Same controls and state explanations available without animated character | E2E/native |
| Screen reader active | No repeated competing announcements; focus moves only on user action or required dialog | NVDA/VoiceOver manual |
| Background task expires or fails | User sees reason, partial result if any, Retry/Cancel; no indefinite running state | Unit/E2E |
| App restarts during task | Recovery honestly distinguishes restored context from actions needing fresh approval | E2E/native |

### Definition of Done — every UX ticket

- [ ] A reproducible initial state and measurable user problem are documented.
- [ ] Existing API contracts, safety boundaries, and current UI behavior were inspected first.
- [ ] Responsive states, failure states, locale strings and keyboard focus are specified.
- [ ] Implementation uses existing TypeScript/React/Electron architecture unless change is justified.
- [ ] Relevant tests are added or updated; passes/skips and test environment are reported.
- [ ] No private data is added to event logging, overlays or screenshots.
- [ ] Desktop screen-reader behavior is manually validated for changes that affect it.
- [ ] Screenshots and a short before/after walkthrough demonstrate the actual change.
- [ ] No unintended change to login, official submission, authentication or consent behavior.
- [ ] The resulting workflow has a clearly observable success or failure state.

---

## 15. Prompt for a coding agent (Codex / Claude Code)

Copy this instruction when assigning implementation:

```text
You are improving the UX of the existing Cheongeum (voice-welfare)
TypeScript + React + Electron application, not building a new product.

Read VOICE_WELFARE_UX_IMPROVEMENT_PLAN.md and inspect the actual
current repository before editing. Start with Sprint 0 to establish the
baseline. Preserve existing behavior, user data, safety invariants,
and uncommitted changes. Use a separate feature branch.

Implement P0 improvements first, in small reviewable slices. For each:
1. Reproduce the actual UX problem; distinguish confirmed findings from
   old documentation, design hypotheses, and already implemented behavior.
2. Write explicit user, voice, keyboard, screen-reader, loading, error,
   recovery, and localization acceptance criteria.
3. Reuse existing React/Electron components and typed backend contracts.
4. Add focused regression tests for the user journey, especially consent,
   Stop, approval fingerprints, authentication handoff, and state sync.
5. Run relevant checks and document exact results, skipped checks, and
   any need for native hardware/manual testing.
6. Provide before/after screenshots or a short walkthrough.

Do not rewrite the entire UI, change backend providers without approval,
weaken safety checks, automate real submissions, capture voice before
consent, or invent verified task outcomes. Do not mark real-user tests as
passed unless they were actually conducted.

Prioritize an accessible, predictable, low-friction experience over visual
novelty. Treat English/Chinese/Japanese/Korean string coverage and accurate
microphone/agent state as release requirements.
```

---

## 16. References and source-of-truth hierarchy

**Project source of truth (inspect current implementation first):**

- [Project README](https://github.com/davemaxuell/voice-welfare/blob/main/README.md)
- [Main React UI](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/App.tsx)
- [Primary CSS](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/styles.css)
- [Desktop Electron shell](https://github.com/davemaxuell/voice-welfare/blob/main/apps/desktop/src/main.ts)
- [Avatar overlay](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/avatar/overlay.ts)
- [First-run UI](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/FirstRun.tsx) and [design](https://github.com/davemaxuell/voice-welfare/blob/main/docs/superpowers/specs/2026-11-19-first-run-setup-design.md)
- [Background research panel](https://github.com/davemaxuell/voice-welfare/blob/main/web/src/workflows.tsx)
- [Avatar experience spec](https://github.com/davemaxuell/voice-welfare/blob/main/docs/superpowers/specs/2026-11-19-avatar-assistant-ui.md)
- [Desktop UI handoff](https://github.com/davemaxuell/voice-welfare/blob/main/docs/desktop-ui-handoff.md) (historic implementation notes; some file paths refer to the prior Python tree)
- [Historical QA report](https://github.com/davemaxuell/voice-welfare/blob/main/docs/2026-11-19-0700-welfare-agent-qa.md) and [follow-up fixes](https://github.com/davemaxuell/voice-welfare/blob/main/docs/report-fixes-2026-11-19.md) (do not assume old findings reflect current `main`)
- [Participant-test plan](https://github.com/davemaxuell/voice-welfare/blob/main/docs/user-test/plan.md) and [task cards](https://github.com/davemaxuell/voice-welfare/blob/main/docs/user-test/tasks.md)

**External design and accessibility references:**

- [Nielsen Norman Group — 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C — ARIA live regions](https://www.w3.org/WAI/ARIA/apg/practices/live-regions/)
- [Microsoft Fluent 2](https://fluent2.microsoft.design/)
- [Google Material Design](https://m3.material.io/)
- [Microsoft Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/)
- [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)
- [Electron global shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut)

**Final principle:** Cheongeum should not merely *look* alive. It should continuously communicate **what it knows, what it is doing, what it has actually finished, what it cannot verify, and when the user—not the agent—must act**.
