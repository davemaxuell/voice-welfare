# Cheongeum desktop UI handoff

**19 November 2026 · Ready for implementation.** Cheongeum helps people use Korean public-service websites by voice. When enabled, a small 3D avatar sits beside the user’s work. Speaking starts with **말하기** or the existing shortcut. Short decisions appear beside the character. Clicking the character opens the current conversation for typing, transcript review and sources.

## Start here

| Read in this order | What it gives you |
| --- | --- |
| 1. [Approved avatar and quick-choice design](superpowers/specs/2026-11-19-avatar-assistant-ui.md) | The product behavior, Korean UI examples, accessible input paths and first user study. |
| 2. [Desktop concept image](ui-concepts/cheongeum-avatar-and-quick-choices.png) | The quick-choice card over a fictional welfare page and the expanded conversation shown side by side as two states. The ivory-and-indigo character is a visual direction. Use a smaller resting avatar and add a persistent microphone-state label in the implementation. |
| 3. [Implementation and backend integration](superpowers/plans/2026-11-19-avatar-backend-integration.md) | Architecture diagram, ownership, a worked voice turn, proposed IPC message, current HTTP routes, proposed contextual choices, delivery order and tests. |

**Workspace baseline.** The source reviewed was the working tree at `C:\Users\user\Desktop\voice-welfare`, on `feat/local-stt-privacy` with HEAD `9842310`. The checkout included uncommitted and untracked changes to the UI, session recovery, backend and tests. Give the receiving agent the current working tree or a matching source snapshot. The ZIP contains the UI documentation and images. Links into `src/`, `apps/` and `tests/` resolve in the source checkout.

## Product decisions to carry forward

- **Clicking the avatar opens the conversation.** The separate **말하기** control and `Ctrl/Cmd+Shift+Space` handle voice. An ordinary welfare question can be completed with the conversation window closed.
- **One question and up to three choices.** Use the same labels on screen and in spoken guidance. A passive card leaves keyboard focus in Chrome. A deliberate keyboard action brings focus to the choices. Keep the selected task when the user opens or closes the full window.
- **Show who can act.** Represent actual mic capture, audio playback and task progress independently. During login, release capture, announce the handoff once, and offer **로그인했어요** and **인증 취소** by keyboard or click. The backend checks the expected browser page before continuing.
- **Keep the user in control.** Hide affects visibility, Stop interrupts active work, and End closes the session. Bind approvals to the decision the user reviewed. Keep sensitive values in the deliberate review surface. Use real HTML controls, visible focus, a still-avatar option, and keyboard and screen-reader access to each essential action.

## Engineering starting point

Today one Electron conversation window owns the mic, playback, session credentials, request numbering, progress polling and transcript. The tray, Talk shortcut, backend approval and browser handoff paths already exist. At handoff, the avatar overlay, cross-window bridge, scoped contextual-choice endpoint and production character model are pending.

1. **Connect a still avatar first.** Add a dedicated overlay page and preload. Keep the current conversation renderer loaded as the single controller. Forward its display snapshot to the overlay through Electron main. Verify that opening and closing the conversation three times yields one session, one heartbeat and one copy of each user message and reply.
2. **Share approvals.** Route actions from both surfaces to the controller using the displayed approval ID. Exercise a double-click, a simultaneous voice confirmation and a changed field on the practice site. Count actual writes.
3. **Add contextual choices and login return.** The plan proposes optional `TurnResult.offeredChoices` and `POST /api/session/{sid}/choice`. Validate the originating turn, handoff and page before executing the chosen action. Keep the existing approval endpoint for consequential actions.
4. **Add speech-driven motion and verify the desktop experience.** Drive a local GLB from real playback events. Check interruption, motion preferences, WebGL fallback, keyboard focus, multiple displays and packaging. Windows/Chrome with NVDA is the proposed first native target. Check macOS with VoiceOver separately.

**Source entry points.** Start with the [Electron shell](../apps/desktop/main.cjs), [preload](../apps/desktop/preload.cjs), [full-window markup](../src/cheongeum/web/static/index.html), [frontend controller](../src/cheongeum/web/static/app.js), [API client](../src/cheongeum/web/static/api.js), [FastAPI routes](../src/cheongeum/server/app.py) and [turn contract](../src/cheongeum/core/turn.py). The integration plan links the microphone, speaker, session recovery, approval recheck and browser handoff code at the decisions they govern.

## Supporting documentation in the ZIP

| Topic | Documents |
| --- | --- |
| Voice cues, interruptions and clap detection | [Sound design](superpowers/specs/2026-11-18-sound-cues-design.md) · [Sound implementation plan](superpowers/plans/2026-11-18-sound-cues.md) · [Double-clap implementation and replay findings](<../drafts/future implementations/double-clap detector - test and tune.md>) |
| Accessibility and participant testing | [Pilot plan](user-test/plan.md) · [Task cards](user-test/tasks.md) · [Consent template](user-test/consent-template.md) · [Recording sheet](user-test/record-sheet.csv) |
| Existing behaviors and reported fixes | [Pilot engineering results](pilot-engineering-results.md) · [Welfare agent QA](2026-11-19-0700-welfare-agent-qa.md) · [Follow-up fixes](report-fixes-2026-11-19.md) |
| Product, setup and architecture | [Project README](../README.md) · [Korean product brief](기획요약.md) · [Desktop setup](install.md) · [Architecture diagram](architecture.png) · [Architecture cross-check](architecture-check.md) |
| Prior design research | [OpenBot review and accessible workflows](openbot/README.md) · [Pickle UX research](<../research_notes/피클 AI 에이전트 청음 적용 검토/pickle_features_ux.md>). The approved avatar design and integration plan carry the selected direction and external component references. |

## Verification and open decisions

The integration review ran **20 existing tests** against local synthetic fixtures on 19 November 2026. They covered approval fingerprints and stale IDs, recovery and retry, Stop during navigation, public pages with login controls, and handoff completion, cancellation and expiry. The integration plan records the baseline. Native overlay focus, cross-window IPC, avatar animation and participant usability still need direct verification.

The final rigged avatar, its resting size at different display scales, and key bindings for focusing choices and global Stop remain open. Use a still or placeholder character for the first integration check. The visual mockup is a single raster image and the approved design links a CC0 model suitable for prototyping.

## Prompt for the receiving agent

> Implement the approved Cheongeum desktop avatar UI in the current voice-welfare checkout. Read docs/desktop-ui-handoff.md, the linked avatar design and the backend integration plan first. Preserve existing working-tree changes. Start with a still overlay, quick controls and an expandable conversation sharing one session. Work through approvals, contextual choices, login handoff and speech-driven motion in the documented order. Verify each slice with synthetic tasks, including stale choices, Stop, microphone state and keyboard focus. Report which automated and native accessibility checks you actually ran.
