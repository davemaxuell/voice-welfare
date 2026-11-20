# Double-clap detector: test it, tune it, fix the sampling gap

Status: implemented and checked in Chromium. Hardware validation remains open. The original design notes follow the replay results.

## Implementation and replay results

The raw microphone feeds an AudioWorklet that inspects consecutive 20 ms frames at the device sample rate. The detector keeps the original amplitude, crest and timing thresholds. A threshold on the RMS of adjacent-sample differences rejects some low-frequency impacts. Conversation shutdown also releases a microphone granted after the user has stopped.

To repeat the recording check, run `node scripts/eval_claps.mjs <ESC-50/audio>` with ffmpeg on PATH. The script lists the exact crops from [ESC-50 revision 33c8ce9](https://github.com/karolpiczak/ESC-50/tree/33c8ce9eb2cf0b1c2f8bcf322eb349b6be34dbb6). The eight pairs come from three source recordings. The six offsets per pair measure sensitivity to frame alignment.

| Replay at 44.1 kHz | Pairs firing once (48 replays) | Fold 1 noise clips firing (24 clips) |
|---|---:|---:|
| Previous 512-sample frame, 20 ms hop | 22 | 5 |
| Continuous 20 ms frames | 44 | 8 |
| Continuous frames with the frequency filter | 44 | 4 |

On the separate fold 2 noise set, 6 of 24 clips triggered, all keyboard recordings. The isolated first clap of each pair produced zero false triggers at all six offsets.

Chromium also replayed the first recorded pair from `2-76408-A-22.wav` through its fake microphone at 48 kHz. Starting the production voice loop's clap detector fired the callback once.

The first four WAV files in the [Korean FLEURS development archive](https://huggingface.co/datasets/google/fleurs/tree/main/data/ko_kr/audio) and this checkout's existing Korean TTS sample, `reports/voice-check.mp3`, produced zero triggers at their recorded levels and with peaks normalized to full scale. Pass additional recording paths after the ESC-50 directory to repeat this check. Laptop microphone gain and the app's voice played back through speakers still need room recordings. The replay figures describe these clips only.

## Original implementation

- Code: `src/cheongeum/web/static/mic.js:308-351` (`startClapDetector`), started at `app.js:481` when a conversation starts.
- It opens a second mic stream with echo cancellation, noise suppression and auto-gain off, because noise suppression would erase a clap.
- Every 20 ms it reads the latest 512 raw samples (`getFloatTimeDomainData`) and computes `peak` (largest absolute sample) and `rms` (average loudness of the slice).
- A tick counts as a clap only if all three hold:
  - `peak > max(0.3, avg * 8)`: loud, and well above the recent background level. `avg` is a running average, `avg = avg*0.95 + rms*0.05`.
  - `peak / rms > 4`: sudden, not sustained.
  - more than 120 ms since the previous clap, so ringing is not counted.
- Two claps 150–800 ms apart call `talkNow()` (`app.js:647`), the same action as the button and spacebar:
  - while the app speaks: cut the guidance off and listen;
  - while the user speaks: end the utterance and send it;
  - while the app works: cancel the running task.
- If the second mic stream can't open, the conversation continues without clap detection.

## The detector does not look at frequency

It reads the waveform, not a spectrum. It checks only loudness and suddenness.

- A steady loud high tone does not pass: a pure tone's peak is only about 1.4× its average level.
- Any sharp, loud, broadband burst can pass, whatever its pitch: clap, finger snap, door slam, dropped object, hard key slam. A loud sharp consonant such as "ㅍ" or "ㅌ" might pass. Not tested.
- A tone that starts abruptly can pass. The slice that catches the onset is mostly silence plus a short tone, so its peak-to-average ratio can briefly exceed 4. This is why the sound-cue design softens beeps with a 20 ms fade-in (`docs/superpowers/specs/2026-11-18-sound-cues-design.md`).

## Problems found

1. **No test of the detector.** The only test that mentions claps (`tests/e2e/test_web_ui.py:87`) checks that the app's own beeps stay under the threshold. Nothing checks that a real clap is detected or that other sounds are rejected.
2. **Thresholds are untuned.** 0.3, 8×, 4, 120 ms and 150–800 ms are guesses. No real mic data has been used.
3. **Sampling gap.** A 512-sample window is about 10.7 ms at 48 kHz, polled every 20 ms, so roughly half the audio is never inspected. A real clap's burst probably lasts longer than that, so it likely still registers. Not tested. The sample rate is an assumption.

## Plan

Do the steps in this order, because step 3 shifts the other numbers and needs the tests from step 1 to catch regressions.

1. **Test with real audio.**
   - Move the clap logic into a pure function that takes samples and a timestamp.
   - Record clap and non-clap clips: single and double claps, keyboard, door, cough, loud speech, the app's own voice from the speakers.
   - Feed the clips to the function.
   - Possible end-to-end route: Chromium can play a WAV file as the fake mic (`--use-file-for-fake-audio-capture`). This flag has not been tried in this repo.
2. **Tune the thresholds from that data.** Same approach as `scripts/eval_stt.py`: measure missed claps and false triggers, then pick the numbers.
3. **Fix the sampling gap.** Poll every 10 ms, or use a larger analyser window. Either change shifts the peak-to-average ratio, so re-tune after.
4. **Optional: add a frequency check**, such as requiring broadband energy, if step 2 shows false triggers from non-clap sounds. Decide only after measuring.

## Leave as is

- **Clap while working cancels the task.** A false trigger costs the most in this phase, but it is recoverable: the app says "멈출게요" and the user can ask again.
- **Background timers in the desktop app.** `apps/desktop/main.cjs:124` sets `backgroundThrottling: false`. In a plain browser tab that goes to the background, timers would be throttled and claps missed. The web UI is meant to stay in the foreground.

## Open questions

- How many real recordings are enough for tuning, and who records them?
- Are claps reliable enough on laptop built-in mics, or only on headsets and external mics?
- Should the user be able to switch clap detection off in the settings, in case it triggers by accident?
