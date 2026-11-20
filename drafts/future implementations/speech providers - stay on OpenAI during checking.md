# Speech providers: stay on OpenAI while the system is being checked

Status: verified on 2026-11-18 against the active checkout. Both provider settings resolve to OpenAI. The local STT and TTS changes below remain deferred during system checking.

## Decision

While the whole system is under checking, speech recognition (STT) and spoken replies (TTS) both stay on the OpenAI API. No code or `.env` change is needed today.

The local Korean STT model is installed but not switched on. Moving to local STT, or to a local TTS, is a future change. The sections below record what that change involves and when to do it.

Scope note: this decision does not touch the browser voice (`speechSynthesis`). It stays as the free fallback for when TTS is unset, the key is missing, or there is no internet.

## Current state (checked 2026-11-18)

| Part | Setting in `.env` | What runs |
|---|---|---|
| STT | `STT_PROVIDER=openai`, `STT_MODEL=gpt-4o-mini-transcribe` | OpenAI transcribes all spoken audio |
| TTS | `TTS_PROVIDER=openai`, `TTS_MODEL=gpt-4o-mini-tts`, `TTS_VOICE=coral`, `TTS_SPEED=1.1`, Korean style instruction | OpenAI speaks every reply |

- If `STT_PROVIDER` / `TTS_PROVIDER` are unset, the code falls back to `mock` (browser voice, no server STT). The code has no OpenAI default of its own; OpenAI is on because of this `.env`.
- Local STT is available but off. `models/whisper-small-komixv2-ct2` (komixv2 converted to CTranslate2 int8) and `models/koelectra-ko-pii-ner` are on disk. It would be used only with `STT_PROVIDER=local` and `STT_LOCAL_MODEL=<model folder>`.
- With local STT selected and the model missing, `voice/config.py` turns server STT off instead of falling back to OpenAI.
- There is no local TTS model. The only local speech output is the browser voice.

## Why stay on OpenAI for now

- The system is still being checked. Changing the speech path mid-check would mix a provider change into every result.
- The only local-vs-OpenAI measurement is synthetic: local matched 79% of commands vs 89% for OpenAI (Windows voices, 2026-11-17). Real recordings have not been run.
- Voice quality matters for TTS. Users listen to it all day, and the OS voice is flat at a fast rate.

## Future change 1: local STT for Korean

Goal: Korean speech stays on the PC. This matters most for spoken passwords and ID numbers. Other languages continue to go to OpenAI.

Entry criteria, as agreed on 2026-11-17:
1. Record real sentences and put them in `recordings/<id>.*`. Sentence list: `docs/stt-eval/sentences.csv`.
2. Run `uv run python scripts/eval_stt.py` and read `reports/stt-eval.md`.
3. Switch only if the local-vs-OpenAI gap in command understanding is small enough to accept.

To switch, once the criteria pass:
- `.env`: `STT_PROVIDER=local` and `STT_LOCAL_MODEL=models/whisper-small-komixv2-ct2`.
- Keep `STT_MODEL` and the API key set so non-Korean speech still routes to OpenAI.
- Restart the server. `.env` changes are not picked up live.
- Re-run `scripts/run_scenarios.py` to confirm nothing regressed.

## Future change 2: local TTS

Goal: replies stop going to OpenAI as text. The app reads input values back aloud during form filling, such as names and phone numbers. Those read-backs are sent to OpenAI as TTS text today.

- Status: deferred on 2026-11-17 as a follow-up. No candidate model is chosen.
- The browser voice is not a good substitute for the shipped product. Quality depends on which Korean voices the OS has.
- Open question: which local Korean TTS gives acceptable quality and speed on a normal PC.

## Related changes, not decided

- Hiding names and phone numbers from the OpenAI LLM with placeholders (deferred on 2026-11-17).
- A voice picker in the UI. Today the voice is set by `TTS_VOICE` in `.env` or by the browser voice name in the user's speech settings.
- Cost: TTS is about 85% of the roughly $0.006 per turn (README §7). Local TTS would remove most of it.
