# Live delegation fixes (problems 1,3,4,5,6; leave 2)

Playbook: Bug fix (verbatim steps)
- [x] 1. Reproduce it yourself on the matching surface via the driver skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
- [x] 2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Claude Code's `loop` skill. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
- [x] 3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default in poteto-mode's Models section) with a specific scope.
- [x] 4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
- [ ] 5. skip: user did not ask to commit; shared dirty tree with other sessions. Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
- [ ] 6. skip: no commit/PR requested. Run **Opening a PR**.

Task todos
- [x] baseline: run voice-edge + api + layer tests before edits
- [x] P1 progress question answered while a task runs; spoken progress during long tasks
- [x] P3 stop heard while local TTS reads (mic stays open, only stop accepted while reading)
- [x] P4 pause > 1.2 s keeps the first half
- [x] P5 still-talking text not dropped; absorbed delegation stays quiet
- [x] P6 full queue no longer ends call; fallback wording
- [ ] full unit + e2e suite after edits

Notes
- 1: synthesized triggers with fake GPT-Live sideband events (scratchpad delegation_probe.py) against real Transcript/_monitor; all 4 server problems fired.
- 2: mechanisms read from code + probe output; causes in one subsystem (voice_edge._monitor/Transcript, voice-edge.js updateAudio).
- 3: skip architect/subagents: session rule forbids spawning subagents unless the user asks. BLOCKED: independent review (none ran).
- 4: same surface = _monitor with fake sideband (pytest) + Chromium page for voice-edge.js. Not verified against real GPT-Live (needs a key and a real call).
- baseline: 25/26 passed; test_same_tab_reload_offers_resume_with_microphone_off flaked, passed alone.
