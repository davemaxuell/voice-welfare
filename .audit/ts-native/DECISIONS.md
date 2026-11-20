# Owner decisions

Given by the owner on 2026-11-20 while the migration was running. They answer the four product calls the plan left open, and they replace the older note of 2026-11-17 that Korean speech recognition would run locally.

| Topic | Decision | What it changes |
| --- | --- | --- |
| Model providers | Remove the dedicated Ollama option. Keep support for OpenAI-compatible servers. | The provider list is `openai` and `openai-compatible`, and the `qwen` alias stays. The rule that lets a localhost server work without a key stays, because it looks at the URL. An unknown provider value, including `ollama`, means no LLM and the rules are used. Python tests that only use `ollama` as an example value are ported with `openai-compatible`. The settings and first-run screens drop the Ollama option. |
| Speech recognition | Keep it online for all languages, including Korean. | Local Whisper is removed. That means `src/voice/stt_local.ts`, the Python sidecar, the model download and conversion scripts, and the `local` branch of the voice config. A legacy `STT_PROVIDER=local` setting uses only the authenticated API, as committed Python does. Six Python tests are excepted in `parity-exceptions.tsv`. `eval-stt` evaluates the API only. |
| Personal information redaction model | Keep it. | It ships in the installer, about 15 MB, run in Node through `onnxruntime-node` loaded lazily. Without the model files the rules still run, as in Python. |
| Artwork | Keep the six mascot pictures. | Nothing under `graphics/` is deleted. |
| Clean Windows tests | The owner will arrange a clean Windows setup later for the install, a real microphone and a screen reader. | Checks on this machine are a proxy until then. A runbook for that session is written near the end. |
