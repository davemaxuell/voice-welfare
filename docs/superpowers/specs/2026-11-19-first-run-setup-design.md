# 첫 실행 설정과 청음 소개 — design

Status: draft, waiting for the owner's approval. No code changed yet.

## Why

The first launch after installation is the moment 청음 either becomes usable or gets abandoned. Today it opens a sighted form (language, API key, 시·도, speed, PC type) and then the consent screen. A blind or elderly user alone cannot finish that form by voice, and nothing tells the user what 청음 can actually do. The owner wants a first-run setup that works whether a family member or 복지관 staff sets it up, or the user does it alone, and that ends with a short, cute introduction of 청음 using the avatar's animations.

## Goals

- One setup that works for both cases: a helper sets it up and hands over, or the user sets it up alone.
- A working OpenAI API key before setup can finish (owner decision: the key is required).
- The user, not the helper, hears and gives consent, does the sound check, and chooses the speech speed.
- The user leaves setup knowing three things: how to start talking, how to say "멈춰", and what 청음 can do.
- A short introduction (about 40 seconds) where each capability is shown with the matching avatar animation.

## Non-goals

- Asking who the user is (age, disability, income, household, 시·군·구). Owner decision: these are asked later, in the first 맞춤 찾기 conversation, and saved only with consent on a personal PC. That is a separate spec.
- Local speech models so 청음 works without a key.
- Changing how consent works on later launches (it is still asked every launch).

## Anti-goals

- Setup that a voice-only user cannot finish without seeing the screen.
- A helper agreeing to consent on the user's behalf, or hearing the user's 민감정보.
- Sending the user's voice anywhere before consent.
- A long questionnaire. Every step beyond language, key, and consent can be skipped.
- An introduction that cannot be skipped or that plays animation for users who asked for reduced motion.

## Constraints found in the code

- **No microphone before consent.** The audio endpoints refuse when `consent_status != "granted"` (`server/app.py`). So any step that listens must come after consent.
- **No voice without a key.** Speech is server TTS only; the web UI has no `speechSynthesis` fallback. Before the key works, 청음 cannot speak.
- **Voice works before consent once the key is saved.** `POST /api/audio/speak` needs no session or consent (the consent introduction already uses it), so Stage 2 can speak before a session exists.
- **Settings come before a session.** `POST /api/session` returns 409 `SETUP_REQUIRED` until `SettingsStore.completed`. Consent belongs to a session (`/api/session/{sid}/consent`).
- **First-launch guide is claimed once** per settings folder (`SettingsStore.claim_startup_guide`, file `startup-guide-seen`).
- **Shared profile wins.** When the runtime runs with `pilotProfile == "shared"`, the server forces `deviceUse = "shared"` and `rememberService = False`.
- **Browser choice is read at startup** from `BROWSER_MODE` (`server/runtime.py`), and `chrome` is allowed only on the personal profile. Changing it needs a restart.
- **The corner avatar only displays.** The overlay window is `focusable: false`, gets display snapshots from the conversation window (`companion.js` `desktopView`), and sends back only `{choiceSetId, key}`.
- **Avatar animations that exist** (`avatar/character.js` `HOLD` and the glb): `ready`, `listening`, `thinking`, `confirmation`, `screen-reading`, `try-again`, `auth-handoff`, `stopped`, looping `speaking` and `sleeping`. Still images for each live in `avatar/poses/*.webp`, plus `complete.webp`.
- **Two speed settings exist**: `Preferences.speed` (settings file, default 1.35) and `PersonalStore` `speech.rate` (vault, default 1.25), combined in `app.js`. Setup writes only `Preferences.speed`.
- **The settings file is plain JSON** except the sealed key. Personal values (the name to call the user, the guardian) belong in `PersonalStore`, which is sealed when a Seal exists.

## Approaches

**A. One client-side wizard for everything.** The conversation window runs every step, including the voice steps, and parses spoken answers in browser JS.
Simplest wiring, but it copies Korean answer parsing (네/아니요, names, 조사) out of the Python rules, and saving the name would bypass the vault's readback-and-confirm flow.

**B. Split at consent (picked).** A screen wizard in the conversation window runs everything up to and including consent. After consent, the session runs a scripted setup conversation for the voice steps and the introduction.
The split follows the real boundary in the code: no listening before consent. The pre-consent part reuses the existing settings form and store. The post-consent part reuses the session's short-answer rules, the vault confirm flow, stop handling, TTS, and avatar snapshots. Cost: a new collaborator for the orchestrator and one new dialogue slot.

**C. A separate Electron onboarding window with a large 3D avatar.** Biggest and cutest visuals, but it adds a new window, preload, and CSP surface, works only in the desktop app (the web run gets nothing), duplicates the settings form, and the character the user meets is not the one that lives in the corner.

We go with **B**: the consent boundary is real, and B reuses the most existing behavior.

## The flow

Each step lists who answers, how, and where the answer goes.

### Stage 1 — before the key works (screen, recorded voice, keyboard)

청음 cannot speak through TTS yet, so each fixed sentence in this stage plays from a **recorded clip** (see "Recorded clips"). Answers are single keys (1, 2, 3, 4, Enter, Esc) and also clickable buttons. Screen-reader users get the same text as live regions.

1. **Language.** Each option is spoken in its own language: "한국어는 1번", "English, press 2", "中文请按3", "日本語は4番". Saved: `Preferences.language`. Every later screen and clip uses this language.
2. **Who is setting up?** "지금 누가 설정하고 계세요? 사용하실 분 본인이면 1번, 가족이나 복지관 직원이면 2번." Not saved; it only picks the path for this setup run.

**Helper path (2).** A normal form; the helper can see the screen.

3. **OpenAI API key** (required). Paste field, a "키 받는 방법" link to the OpenAI account page, and a note to set a spending limit. On "다음", the server makes one cheap test call with the key (for example `GET /v1/models`). Failure keeps the user on this step with a plain reason: "키가 맞지 않아요", "사용 한도를 넘었어요", "인터넷 연결을 확인해 주세요". Saved: sealed key, as today.
4. **Personal or shared PC.** Saved: `Preferences.deviceUse`. Locked to shared when the runtime profile is shared.
5. **Browser** (personal PC only): the user's usual Chrome, which keeps their logins, or a separate browser. Saved: a new setting read at startup instead of only `BROWSER_MODE`. Applies on next launch; say so.
6. **Start 청음 with Windows** (desktop app only). Saved: Electron login item.
7. **Guardian contact** (optional, personal PC only): name and mobile number. Saved: `PersonalStore.set_guardian`.

Then the **handover screen**: "이제 사용하실 분께 넘겨 주세요. 준비되면 Enter를 눌러 주세요." Played as a clip, because the user may not be looking.

**User-alone path (1).** Recorded voice guides each step.

3. **API key.** "API 키를 복사해 두셨으면 Ctrl과 V를 함께 누르고 Enter를 눌러 주세요. 키가 없으면 가족이나 복지관에 키 등록을 부탁해 주세요." Same test call. On failure, the reason plays as a clip and the step repeats. If there is no key, setup waits here; nothing else is possible.
4. **Personal or shared PC.** "이 컴퓨터를 혼자 쓰시면 1번, 여러 사람이 쓰면 2번."
5–7. Defaults, no questions: separate browser, no auto-start, no guardian. All can be changed later in settings.

**Both paths end Stage 1 by saving settings** through today's `POST /api/settings`. That sets today's `SettingsStore.completed`, which loads the key into the voice services and later lets the session be created.

### Stage 2 — key works, before consent (real voice, keyboard)

From here 청음 speaks with its real TTS voice. Still no microphone.

8. **Sound check.** "제 목소리가 들리시면 Enter를 눌러 주세요." Space replays. After three replays with no Enter, the screen shows how to check speakers (existing **소리 확인**).
9. **Speed.** The same sample sentence plays at the current speed. "더 천천히는 1번, 그대로는 2번, 더 빠르게는 3번." Repeats until 2. Saved: `Preferences.speed`.
10. **Consent.** The existing consent introduction and guide, answered by the user (Enter to agree, Esc to decline). If the user declines, setup ends in the existing declined mode, which offers questions without the browser.

### Stage 3 — after consent (voice, in the session)

The session runs these as a scripted conversation. All sentences are fixed text in code, never model output.

11. **Microphone check.** "이제 제가 들어 볼게요. 말하기 단축키 Ctrl, Shift, 스페이스를 누르고 '안녕 청음아'라고 말해 보세요." 청음 repeats what it heard. If nothing comes through, it says how to check the microphone and offers to skip.
12. **What to call you.** "어떻게 불러 드릴까요? 이름을 말씀해 주시거나 '건너뛰기'라고 해 주세요." It reads the name back with `josa()`: "홍길동님이라고 부를게요. 맞으면 '네'." On a personal PC this is saved in `PersonalStore` (new key `callName`, separate from the vault's legal `name`). On a shared PC it is used for this session only and 청음 says so.
13. **How to stop.** "제가 말하는 도중에도 '멈춰'라고 하면 바로 멈춰요. 지금 한번 '멈춰'라고 해 보세요." The avatar plays `stopped`, then 청음 wakes and praises: "잘하셨어요!"
14. **Introduction of 청음** (below). Skippable.
15. **Practice offer.** "연습용 신청서로 한 번 해 볼까요? 진짜로 제출되지는 않아요." Yes opens the practice site (`practice_site/`) and starts the normal form flow. No: "언제든 '청음아'하고 불러 주세요."

A new settings field `firstRun` records how far the user got after Stage 1 (`stage2`, then the Stage 3 step reached, then `done`). If the app closes midway, the next launch continues from that step once instead of starting over. Stages 1 and 2 are never repeated after consent was given.

## Introduction of 청음

About 40 seconds at the chosen speed. One sentence per capability. During each sentence the corner avatar plays the matching animation, and the conversation window shows a card with the same sentence and the matching still pose image. The web run without the avatar window shows the cards only. With reduced motion or the still-avatar setting, the cards show still images and the corner avatar does not move.

| # | 청음 says | Avatar | Card image |
| --- | --- | --- | --- |
| 1 | "{호칭}, 반가워요! 저는 청음이에요." (no name: "반가워요! 저는 청음이에요.") | `speaking`, then `confirmation` | `ready.webp` |
| 2 | "복지, 민원, 장학금처럼 궁금한 걸 말로 물어보세요." | `listening` | `listening.webp` |
| 3 | "복지로나 정부24 같은 사이트를 열어서 읽어 드려요." | `screen-reading` | `screen-reading.webp` |
| 4 | "신청서 입력도 도와드려요. 누르기 전에는 꼭 여쭤볼게요." | `confirmation` | `confirmation.webp` |
| 5 | "본인인증과 진짜 제출은 직접 하시도록 넘겨 드려요." | `auth-handoff` | `auth-handoff.webp` |
| 6 | "언제든 '멈춰'라고 하면 멈춰요." | `stopped` | `stopped.webp` |
| 7 | "그럼 같이 시작해 볼까요?" | `complete` if the glb has that clip, else `confirmation` | `complete.webp` |

Esc, the "건너뛰기" button, or saying "건너뛰기" jumps to step 15. "청음 소개 다시 해줘" replays it at any time. Sentences 3–5 match what 청음 really does today (CLAUDE.md conventions: approval before risky clicks, the user does identity verification and real submission).

## Recorded clips

Stage 1 sentences are fixed, so they are recorded once per language with the same TTS voice 청음 uses, by a script run by a developer with a key. The clips ship with the app (for example `web/static/setup-audio/<lang>/<id>.mp3`) with a manifest of id → text. A unit test checks that every Stage 1 sentence on screen has a clip in every language and that the clip text matches the screen text.

## What is saved where

| Value | Store | Shared PC |
| --- | --- | --- |
| Language, PC type, speed | `SettingsStore.preferences` (as today) | saved |
| API key | `SettingsStore`, sealed (as today) | saved |
| Browser choice | `SettingsStore.preferences` (new field) | not offered; separate browser |
| Start with Windows | Electron login item | not offered |
| Guardian | `PersonalStore` (as today) | not offered |
| What to call you | `PersonalStore` `callName` (new) | session only |
| Setup progress (`firstRun`) | `SettingsStore` (new field) | saved |

Today's 시·도 dropdown leaves the setup form, to match "ask later". It stays in the settings dialog for people who want to set it.

## Later

- "설정 다시 해줘" reopens setup from step 1, keeping current values as the defaults.
- The settings dialog (opened from the tray or the button) keeps every field editable outside setup.
- The profile questions belong to the 맞춤 찾기 spec (next).

## Testing

- Unit: the Stage 3 conversation (each step, skip, "네/아니요", name readback, shared versus personal saving), clip manifest coverage, the key test call with `http_mock`, settings migration from today's file (existing installs must not see setup again; they continue to Stage 3 only if they never finished it — builder decides, see below).
- E2E (web UI, Playwright): both paths keyboard-only, with a screen-reader-style check that every step has a live-region announcement and a focused control.
- Desktop (`test:avatar`): the introduction drives the avatar through each animation in order, and reduced motion keeps it still.
- Manual: a helper hands the PC to a user; a user alone with a pasted key; a declined consent.

## Calls made in this doc (for the owner to check)

- Consent moved before the microphone check. Earlier drafts listened before consent, but the audio endpoints forbid that.
- Recorded clips, not the Windows built-in voice, for Stage 1: one voice throughout, offline, all four languages, no dependency on installed Windows voices.
- The user-alone path asks the PC type too (one key press) and uses safe defaults for browser, auto-start, and guardian.
- The name to call the user is stored separately from the vault's legal name.
- Settings are saved at the end of Stage 1 (needed for the voice and the session); a separate `firstRun` field makes Stages 2–3 resumable.
- The 시·도 dropdown is removed from setup.

## Left to the builder

- Where the Stage 3 conversation lives: a new collaborator next to the orchestrator (for example `orchestrator/first_run.py`) plus a `DialogueState` slot, following the "named actions only" rule and `tests/unit/test_layers.py`.
- How the introduction forces avatar modes through `desktopView` snapshots.
- Existing installs: whether a user who already finished today's setup gets offered Stage 3 once.
- Exact wording polish of every sentence, kept short and plain.
