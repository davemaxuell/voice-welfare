# Sound Cues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Twelve short sound cues that tell a blind user what 청음 is doing — SND01 for seven moments the user chose by ear, synthesized for the other five.

**Architecture:** `speaker.js` cue engine (`renderCue` / `earcon` / `transitionCue`) plays either a cached `/cues/*.ogg` buffer or a synth voicing. `app.js` calls one gate, `cue(kind)`, at each moment. An e2e test renders every cue offline and enforces mic-detector limits.

**Tech Stack:** Vanilla JS + Web Audio; OGG clips under `web/static/cues/`; pytest + Playwright.

**Spec:** `docs/superpowers/specs/2026-11-18-sound-cues-design.md`. Synth voicings: `drafts/sound-cues/synth.js`. Source SND clips: `drafts/sound-cues/snd/`. Audition: `drafts/sound-cues/audition.html`.

## Global Constraints

- No build step, no new npm/Python dependencies. Ship only the processed OGG clips we use (not the full SND pack).
- Comments and UI copy in Korean. `speaker.js` 4-space + semicolons; `app.js` 2-space.
- Every cue: sharpness (largest peak ÷ RMS over 512-sample windows with peak ≥ 25% of cue peak) **< 4**.
- Mic-open cues (`done`, `thinking`, `working`, `stopped`): loud (50 ms frames within 30 dB of loudest) **< 200 ms**.
- `thinking` **1000 ms** after `done`; `working` every **2500 ms** from **3000 ms**.
- Mic cues always play. Result cues + `reminder` follow `ui.tts`.
- Credit SND01 in `cues/NOTICE.txt`. Do not redistribute the unprocessed pack alone.
- **Do not commit.** Working tree has unrelated uncommitted rename; each task ends with a checkpoint.

## Review Focus

1. Cue recorded into the user's own mic clip — push-to-talk / browser STT must finish `listen` before recording starts. (Manual, Task 3.)
2. `working` outliving the request — timers clear on settle including errors. (Manual, Task 3.)
3. Locked audio must never stall a turn. (`test_earcon_always_resolves`, Task 1.)
4. Persistent states must not re-fire cues. (`test_transition_cue_only_on_state_change`, Task 1; stop-once test, Task 2.)
5. Stop during conversation → `stopped` only, not also `end`. (Manual, Task 3.)

---

### Task 1: Cue assets + engine in `speaker.js`

**Files:**
- Create: `src/cheongeum/web/static/cues/` — processed OGGs + `NOTICE.txt`
- Modify: `src/cheongeum/web/static/speaker.js:115-138` (replace today's `earcon`)
- Test: `tests/e2e/test_web_ui.py`

**Interfaces:**
- Produces:
  - `CUE_KINDS`, `MIC_OPEN_CUES` as in the design table
  - `preloadCues(): Promise<void>` — fetch/decode all file-backed cues into a module cache (idempotent)
  - `renderCue(kind, ctx, dest, t): number` — end time; uses cache for file kinds, synth for the rest
  - `earcon(kind): Promise<void>`
  - `transitionCue(prev, next): string | undefined`

**File map (after ffmpeg processing):**

| kind | file | processing |
|---|---|---|
| `start` | `cues/start.ogg` | from `drafts/sound-cues/snd/toggle_on.ogg` + 20 ms linear fade-in |
| `listen` | `cues/listen.ogg` | copy `transition_up.ogg` |
| `done` | `cues/done.ogg` | from `select.ogg` + 20 ms linear fade-in |
| `working` | `cues/working.ogg` | first ~100 ms of `progress_loop.ogg` |
| `approve` / `reminder` | `cues/notification.ogg` | copy `notification.ogg` (both kinds point at same file) |
| `stopped` | `cues/stopped.ogg` | copy `transition_down.ogg` |

Synth kinds (`thinking`, `handoff`, `success`, `problem`, `end`): port from `drafts/sound-cues/synth.js` (`heard`→ unused; keep `thinking`/`handoff`/`success`/`problem`/`end` only).

- [ ] **Step 1: Write the failing tests** (append to `tests/e2e/test_web_ui.py`)

```python
# 신호음 한도(mic.js): 박수 감지기는 봉우리/RMS > 4를 박수로, 듣기는 200ms(VoiceLoop.MIN_SPEECH_MS) 넘게 큰 소리를 말로 본다.
CUE_LIMITS_JS = """
async () => {
  const m = await import('/speaker.js');
  await m.preloadCues();
  const sr = 48000;
  const cues = {};
  for (const kind of m.CUE_KINDS) {
    const ctx = new OfflineAudioContext(1, sr * 3, sr);
    m.renderCue(kind, ctx, ctx.destination, 0);
    const x = (await ctx.startRendering()).getChannelData(0);
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    let crest = 0;
    for (let i = 0; i + 512 <= x.length; i += 256) {
      let p = 0, s = 0;
      for (let j = i; j < i + 512; j++) { p = Math.max(p, Math.abs(x[j])); s += x[j] * x[j]; }
      if (p >= peak * 0.25) crest = Math.max(crest, p / Math.sqrt(s / 512));
    }
    const frame = sr / 20;
    const rms = [];
    for (let i = 0; i < x.length; i += frame) {
      let s = 0;
      for (let j = i; j < i + frame; j++) s += x[j] * x[j];
      rms.push(Math.sqrt(s / frame));
    }
    const top = Math.max(...rms);
    cues[kind] = { peak, crest, loudMs: rms.filter((r) => r > top * 10 ** (-30 / 20)).length * 50 };
  }
  return { cues, micOpen: m.MIC_OPEN_CUES };
}
"""


async def test_sound_cues_stay_under_mic_detector_limits(ui_url, page):
    await page.goto(ui_url)
    r = await page.evaluate(CUE_LIMITS_JS)
    assert len(r["cues"]) == 12
    for kind, m in r["cues"].items():
        assert m["peak"] > 0.05, kind
        assert m["crest"] < 4, (kind, m)
    assert sorted(r["micOpen"]) == ["done", "stopped", "thinking", "working"]
    for kind in r["micOpen"]:
        assert r["cues"][kind]["loudMs"] < 200, (kind, r["cues"][kind])


async def test_transition_cue_only_on_state_change(ui_url, page):
    await page.goto(ui_url)
    got = await page.evaluate("""async () => {
      const { transitionCue: t } = await import('/speaker.js');
      return [
        t('APPLICATION_OPEN', 'WAITING_FOR_USER_CONFIRMATION'), t('BROWSING', 'AUTH_HANDOFF'),
        t('APPLICATION_OPEN', 'MOCK_SUBMITTED'), t('APPLICATION_OPEN', 'RECOVERING'),
        t('APPLICATION_OPEN', 'VALIDATION_ERROR'), t('APPLICATION_OPEN', 'STOPPED'),
        t('MOCK_SUBMITTED', 'MOCK_SUBMITTED'), t('STOPPED', 'STOPPED'),
        t('WAITING_FOR_USER_CONFIRMATION', 'WAITING_FOR_USER_CONFIRMATION'),
        t('IDLE', 'APPLICATION_OPEN'), t('APPLICATION_OPEN', 'DONE'),
      ];
    }""")
    assert got == ["approve", "handoff", "success", "problem", "problem", "stopped", None, None, None, None, None]


async def test_earcon_always_resolves(ui_url, page):
    await page.goto(ui_url)
    hung = await page.evaluate("""async () => {
      const m = await import('/speaker.js');
      await m.preloadCues();
      const out = [];
      for (const k of m.CUE_KINDS) {
        const r = await Promise.race([m.earcon(k).then(() => 'ok'), new Promise((res) => setTimeout(() => res('hung'), 2500))]);
        if (r !== 'ok') out.push(k);
      }
      return out;
    }""")
    assert hung == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/e2e/test_web_ui.py -k "cue or earcon" -v`
Expected: FAIL (`CUE_KINDS` / `preloadCues` / `transitionCue` missing).

- [ ] **Step 3: Build processed clips + NOTICE**

```bash
mkdir -p src/cheongeum/web/static/cues
# fade-in 20ms for sharp clips
ffmpeg -y -i drafts/sound-cues/snd/toggle_on.ogg -af "afade=t=in:st=0:d=0.02" -c:a libvorbis -q:a 5 src/cheongeum/web/static/cues/start.ogg
ffmpeg -y -i drafts/sound-cues/snd/select.ogg -af "afade=t=in:st=0:d=0.02" -c:a libvorbis -q:a 5 src/cheongeum/web/static/cues/done.ogg
# short working tick
ffmpeg -y -i drafts/sound-cues/snd/progress_loop.ogg -t 0.1 -c:a libvorbis -q:a 5 src/cheongeum/web/static/cues/working.ogg
# straight copies
cp drafts/sound-cues/snd/transition_up.ogg src/cheongeum/web/static/cues/listen.ogg
cp drafts/sound-cues/snd/notification.ogg src/cheongeum/web/static/cues/notification.ogg
cp drafts/sound-cues/snd/transition_down.ogg src/cheongeum/web/static/cues/stopped.ogg
```

`NOTICE.txt` (Korean/English one-liner): SND01 "sine" by Yasuhiro Tsuchiya — https://snd.dev/ — used under snd.dev terms; credit requested.

- [ ] **Step 4: Implement the engine in `speaker.js`**

- Port synth `tone` / `echo` / voicings for `thinking`, `handoff`, `success`, `problem`, `end` only.
- File kinds: map `start`→`/cues/start.ogg`, `listen`→`/cues/listen.ogg`, `done`→`/cues/done.ogg`, `working`→`/cues/working.ogg`, `approve` and `reminder`→`/cues/notification.ogg`, `stopped`→`/cues/stopped.ogg`.
- `preloadCues` fetches unique URLs, `decodeAudioData`, stores in a `Map`. Safe to call more than once.
- `renderCue` for file kinds: `BufferSource` from cache (throw or no-op if missing — tests always preload first). For synth: call voicing. Return end time.
- `earcon`: if context not `running`, resolve immediately; else `await preloadCues()`, schedule at `currentTime + 0.01`, resolve after duration.
- `transitionCue` as in the design (unchanged mapping).
- Doc comment lists all 12 kinds in Korean.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/e2e/test_web_ui.py -v`
Expected: all PASS. If crest still ≥ 4 on `start`/`done`, lengthen fade to 30–40 ms and re-encode.

- [ ] **Step 6: Checkpoint.** Don't commit. Report diff + test results.

---

### Task 2: Result cues and the stop cue in `app.js`

**Files:**
- Modify: `src/cheongeum/web/static/app.js` (import; `applyResult` + callers; `stopAll`)
- Test: `tests/e2e/test_web_ui.py`

**Interfaces:**
- Consumes: `earcon`, `transitionCue`, `preloadCues` from Task 1.
- Produces: `MIC_CUES`, `cue(kind)`, `cueStopped()`, `STOP_CUE_WINDOW_MS = 5000`, async `applyResult`.

- [ ] **Step 1: Write the failing tests** (same as prior plan: `test_approval_plays_its_cue_once`, `test_stop_plays_stopped_once_even_with_voice_guidance_off` with `RECORD_CUES` wrapper). Call `preloadCues` is not required in these tests — `earcon` preloads itself.

- [ ] **Step 2: Run to verify fail**

Run: `uv run pytest tests/e2e/test_web_ui.py -k "approval_plays or stop_plays" -v`

- [ ] **Step 3: Implement**

- Import `transitionCue`. Add `MIC_CUES`, `cue`, `stopCuedAt`, `cueStopped`.
- Optional: `void preloadCues()` after `unlockAudio()` / conversation start so first cue isn't delayed.
- `applyResult` async: announce first, then transition cue (skip duplicate `stopped` inside window), then speak.
- `await` every `applyResult(...)`. `stopAll()` calls `cueStopped()` first.

- [ ] **Step 4: Run tests**

Run: `uv run pytest tests/e2e/test_web_ui.py -v` — all PASS.

- [ ] **Step 5: Checkpoint.** Don't commit.

---

### Task 3: Mic-path cues (hands-free, push-to-talk, browser recognition, reminder)

**Files:**
- Modify: `src/cheongeum/web/static/app.js` (conversation loop, stop paths, mics, reminders)

**Interfaces:**
- Consumes: `cue`, `cueStopped`.
- Produces: `progressCues()`, `endConversation(withCue = true)`.

- [ ] **Step 1: Wire call sites** (same table as before: `start`/`end`/`listen`/`done`/`thinking`/`working`/`problem`/`stopped`/`reminder` at the listed places; `listen` before recording starts).

- [ ] **Step 2: Regression**

Run: `uv run pytest tests/e2e/test_web_ui.py -v`, then `uv run pytest` — all PASS.

- [ ] **Step 3: Manual check** (laptop, speakers loud) — same checklist as before; especially confirm SND `listen` still feels like "띵" and `working` ticks don't trip clap/speech.

- [ ] **Step 4: Checkpoint.** Don't commit. Report diff, tests, manual notes.
