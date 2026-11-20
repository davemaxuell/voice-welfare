# Design task: screen explanation from a screenshot, and desktop app control

## The owner's goal

청음 is a Korean voice agent for blind users. Today it only works inside a browser, and it only reads page text. The owner wants two things, and said both are essential:

1. **Screenshots to explain the screen.** When the user asks what is on the screen, 청음 takes a picture of it, sends it to OpenAI, and explains it. This covers what page text cannot reach: photos, notices posted as images, charts, layout, a popup covering the page.
2. **Reach beyond the browser.** 청음 opens and controls basic desktop apps. File Explorer is first. The owner asked us to propose the other first apps.

## Decisions already made (do not reopen)

- Screenshots go to **OpenAI** (hosted). Owner decision, 2026-11-18.
- **Clicks stay by name.** `ActionTarget` has no coordinates and must not gain them. A vision answer never becomes a click position.
- **No command written by the model.** Desktop control is a fixed set of named actions. Code builds any OS call. The model may only choose among named actions and named targets.
- **Confirm aloud, then act.** A consequential action is never silently blocked. 청음 moves focus to the target, says what it will do and why in a sentence built by code, and acts once after the user says a go word. If the screen changed, it asks again.
- **Screenshots are on demand,** or when a page has little text. Never on every step.
- **Only the window being explained** is captured, never the whole desktop.
- **Personal details are masked before capture:** input fields, and any element where personal info is detected.
- **An answer read from an image is labelled as such** when spoken, because `verify.py` checks numbers against text.
- **CAPTCHA and bot blocks are never read or bypassed.** Passwords are never heard or typed. Real submission and identity verification stay with the user.
- **Screen text and vision output are untrusted data.** They never become instructions.
- **Windows first.** On other platforms the desktop feature is simply off. Tests must run offline with no real desktop and no real OpenAI call.
- User-facing strings, code comments and UI text are **Korean**.
- `src/cheongeum/evaluation/data/demo_scenarios.json` is never modified.

## What you produce

Write everything under your own output folder. Do not edit, create or delete anything in the repo. Do not run tests or start servers. Never read `.env`.

1. `DESIGN.md`: the rationale, shaped per the architect skill's `references/rationale-template.md`. Usage first.
2. `sketch/`: Python stubs. Types, signatures, module boundaries, `raise NotImplementedError` bodies, docstrings in Korean that state intent and invariants. Mirror the repo paths you propose, for example `sketch/src/cheongeum/...`. For an existing file, show only what changes.
3. `PLAN.md`: the build plan. Ordered small units. Each unit names its files, its data shape, the check that proves it (a test name, a probe, a measured number), and what it must not break. Put the riskiest unknowns first as spikes.
4. `APPS.md`: the first desktop apps you propose beyond File Explorer, in order, each with the user's need in one sentence, example utterances in Korean, the named actions it needs, and its risk.

## Questions your design must answer

**Vision**
- How does an image reach the model? `OpenAIStructuredLlm.generate` takes `user: str` today. The WEB role may point at a text-only local model.
- Who takes the screenshot, who decides what to mask, and how is the mask derived from what 청음 already knows about the page?
- When does 청음 use the picture instead of, or beside, the page text? How does a spoken answer say which it used?
- How are CAPTCHA, login and identity-verification screens kept out of the picture path?
- What happens to number verification and prompt-injection defense for an image answer?
- Does the user get to act on what the picture described? If so, how does the action stay name-addressed?

**Desktop**
- Where does the desktop capability live, and how does it relate to `WebExecutionAgent`, `PolicyGuard`, the `Action` and `Observation` contracts, the approval fingerprint and `_approve`, the action log, and `TurnResult`? Reuse, extend, or a sibling?
- How does the guard give an app a tier, when today the tier comes only from a URL origin?
- How is an app named, found and allowed? What is the analogue of `understanding/sites.py`?
- How is File Explorer driven: its window through UI Automation, the filesystem directly, or both? What does the user hear?
- How do new utterances become intents without breaking the registry rules and the rule-parser order?
- How is all of this tested with no real desktop?

**Together**
- How does "explain this window" work for a desktop app window?
- What is the smallest first slice a blind user can feel?

## Grounding (read all of it first)

- `../grounding/explanation.md`: the unified explanation of today's system and the constraints a design must honor.
- `../grounding/explorer-perception-llm.md`, `../grounding/explorer-actions-safety.md`, `../grounding/explorer-intents-runtime-shell.md`: the detailed traces.
- `../grounding/probe-facts.md`: facts measured on this PC.
- The repo, read-only: `C:\Users\user\Desktop\voice-welfare`. Start at `CLAUDE.md`.
