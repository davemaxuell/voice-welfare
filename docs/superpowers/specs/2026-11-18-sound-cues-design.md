# Sound cues (신호음) — design

## Intent

A user who listens instead of watching the screen should know what 청음 is doing without waiting for speech: the mic turned on or off, it's your turn, it heard you, it's thinking, it's still working, it needs your OK, you have to do something yourself, it succeeded, something went wrong, it stopped. Short, friendly, modern sounds, one per moment.

## Goals, non-goals, anti-goals

- Goals: every moment in the table below has a distinct cue that can be heard on laptop speakers. Cues cover hands-free conversation, push-to-talk, browser speech recognition, and (for result cues only) typed commands.
- Non-goals: a sound settings screen or volume control; server changes.
- Anti-goals:
  - a cue the mic takes for a double clap (that cancels the running task or cuts off the answer) or for speech;
  - a cue that talks over the spoken answer;
  - a cue that repeats on every turn while a state persists (for example `MOCK_SUBMITTED` stays set on later turns);
  - cue fatigue: no cue for per-field questions, browsing, or `DONE`.

## Approaches

| Approach | Trade-off |
|---|---|
| Synthesized in code | No files, no license, all safe with mic detectors. Less polished. |
| SND01 "sine" (snd.dev) | Most polished. Some clips are too sharp or too long as shipped; need soft fade / short slice. Free use; credit requested; don't redistribute the raw pack alone. |
| Kenney Interface Sounds (CC0) | Playful; less coherent family. |
| **Mix (picked)** | SND01 for the seven moments the user liked after listening; synthesized for the other five. |

Heard on `drafts/sound-cues/audition.html`. User chose SND01 for start / listen / done / working / approve / stopped / reminder, and 합성안 for thinking / handoff / success / problem / end.

## Design

### Moments and source

| Kind | Source | Clip / voicing | Plays when | Mic open? |
|---|---|---|---|---|
| `start` | SND01 | `toggle_on` (20 ms linear fade-in baked in) | conversation starts, mic confirmed, before greeting | no |
| `listen` | SND01 | `transition_up` | right before listening, every turn | no |
| `done` | SND01 | `select` (20 ms linear fade-in baked in) | listening ends | yes |
| `thinking` | synth | bloop from `drafts/sound-cues/synth.js` | no answer 1 s after `done` | yes |
| `working` | SND01 | short slice (~100 ms) of `progress_loop` | every 2.5 s from 3 s until request settles | yes |
| `approve` | SND01 | `notification` | state → `WAITING_FOR_USER_CONFIRMATION` | no |
| `handoff` | synth | doorbell from synth.js | state → `AUTH_HANDOFF` | no |
| `success` | synth | celebration arpeggio from synth.js | state → `MOCK_SUBMITTED` | no |
| `problem` | synth | soft falling tones from synth.js | `RECOVERING` / `VALIDATION_ERROR`; didn't catch that; mic trouble | no |
| `stopped` | SND01 | `transition_down` | stop accepted (shortcut / spoken 멈춰 / stop button) | yes |
| `end` | synth | mirror of start from synth.js | conversation ends | no |
| `reminder` | SND01 | `notification` (same clip as `approve`) | before "알림이에요" in desktop app | no |

`listen` need not stay a two-note rising oscillator: the greeting's "띵" means "the cue that means your turn," not a specific waveform. Update greeting/hint copy only if the new cue no longer reads as a short chime. *(our call: keep the existing Korean copy unless listening shows it's misleading.)*

### Assets

- Ship only the processed clips we use under `src/cheongeum/web/static/cues/` (ogg), not the full SND pack.
- Soften `toggle_on` and `select` with a 20 ms linear fade-in so sharpness stays under 4 (clap detector).
- For `working`, cut ~100 ms from the start of `progress_loop` so loud duration stays under 200 ms (speech detector while mic is open for "멈춰").
- Credit: one-line note in `src/cheongeum/web/static/cues/NOTICE.txt` — SND01 "sine" by Yasuhiro Tsuchiya, https://snd.dev/. Synth cues need no credit.

### Code

- `speaker.js`
  - `renderCue(kind, ctx, dest, t)` schedules one cue on any AudioContext (live or offline) and returns end time. File-backed kinds decode from `/cues/*.ogg` (cached after first load); synth kinds use the ported voicings. Offline rendering must still work for the limit test (preload buffers before measuring, or have `renderCue` accept an optional buffer map).
  - `earcon(kind)` — play on shared AudioContext; resolve when finished; resolve immediately if audio isn't `running`.
  - `transitionCue(prev, next)` — map state change → kind, or `undefined` if unchanged.
- `app.js` — same wiring as before: async `applyResult` with transition cues; hands-free / push-to-talk / browser STT / stop / reminder call sites; mic cues always play; result cues + `reminder` follow `ui.tts`.

### Limits (enforced by a test)

- Sharpness — largest peak ÷ RMS over 512-sample windows (windows whose peak ≥ 25% of cue peak) **< 4**.
- Mic-open cues (`done`, `thinking`, `working`, `stopped`): loud (50 ms frames within 30 dB of loudest) **< 200 ms**.

## Testing

- `tests/e2e/test_web_ui.py`: import `/speaker.js`, render every cue with `OfflineAudioContext`, assert both limits; assert `transitionCue` mapping.
- Existing web UI tests keep passing.
- Manual: hands-free on laptop speakers, loud — no cue cuts speech or cancels a task.

## Left to the builder

- How double `stopped` is suppressed (flag or short time window) — plan uses a 5 s window.
- Whether `drafts/sound-cues/` stays after landing.
- Exact ffmpeg commands to bake fade / slice into the shipped oggs.
