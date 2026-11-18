# STT pre-commit check: todo

Playbook: Investigation (read-only verdict), plus the poteto-mode "before commit" (deslop) and "before review" (no-comments) triggers.

- [ ] 1. Route through the **how** skill. For motivation questions, also route through the **why** skill.
  - skip how fan-out: the subject is a known diff, not an unknown subsystem; I read the diff myself and use one independent reviewer.
  - skip why: no motivation question was asked.
- [x] 2. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
- [ ] 3. Produce the `how`-shaped output, or a recommendation with a tradeoffs table if the request is a decision between alternatives.
  - Output is a commit verdict: blockers, fixes applied, what to leave out of the commit.
- [ ] 4. Apply the **unslop** skill to the reply.

Task todos:

- [x] Full pytest (baseline 286 passed). Run 1: 340 passed, 3 failed (S4, S5, web_ui consent; all open the practice application, adjacent in time); the 3 pass alone. A peer session's probe (drafts/research results/probes/gate_checks.py) starts the practice site on 5174 too. Run 2 on a quiet machine: 343 passed.
- [x] run_scenarios.py, compare with .audit/runs/U10-gatefix. Rules only: 35/35, identical apart from timing. With PII_MODEL: the run crashed (peer rename removed src/cheongeum mid-run) and port 5174 was held by a peer's pytest. Instead I swept 72 scenario utterances and 82 eval sentences through the real model on the snapshot: no new secret flags.
- [x] Independent review: verified #1 (strict-rule false positives plus stop regression) and #4 (onnxruntime 1.32.0 has no Intel-Mac wheel) myself. #2, #3, #5 and #6 were reproduced by the reviewer only.
- [x] 3. Verdict: not ready as-is; see reply.
- [x] 4. unslop on the reply.
- [x] Read the full diff and the new files myself.
- [ ] Independent bug review (subagent, not anchored on my read).
- [x] deslop pass on the changed code. No edits: no slop worth churn; unused `AgentRuntime.pii_model` attribute noted.
- [x] no-comments pass. skip: no review or PR requested, only a commit; deslop covers comment slop, and CLAUDE.md asks for Korean why-comments. Avoids an agent deleting comments in uncommitted work.
- [x] Commit hygiene: backup ref refs/backup/stt-precheck; uv lock --check ok; models/ and recordings/ ignored; .env ignored; .audit/ and drafts/ untracked (leave out).
- [x] Real-artifact check: real model on synthesized Korean WAV and WebM/Opus ok, silence empty, truncated WebM ok; English with no OpenAI STT comes back as Korean ("Open Naver please" → "네이버에 입력해주세요."). Server boots with both models; /api/health and /api/audio/transcribe ok.
