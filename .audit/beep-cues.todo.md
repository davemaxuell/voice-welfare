# beep-cues (생각중·일하는중 신호음이 말 위로 계속 남)

Goal: thinking/working cues play only while 청음 waits silently, never over speech.

- [x] 1. Reproduce it yourself on the matching surface via the driver skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
  - real web UI in Chromium, mic module + audio endpoints stubbed (cannot speak into a mic from here)
- [x] 2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Claude Code's `loop` skill. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
  - skip how/why: focused-fix exception. Cause in app.js only: hands-free loop calls stopProgress() in finally after speakAndWait(answer); working setInterval ignores busyTalking (progress speech).
- [x] 3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default in poteto-mode's Models section) with a specific scope.
  - skip architect: focused-fix exception (internal app.js helper, no interface/state change). skip delegate: harness says no subagents unless user asks.
- [x] 4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
- [x] 5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
- [x] 6. Run **Opening a PR**.
  - skip PR: user asked to push straight to main (fast-forward 072710a..9842310).

## Evidence
- before fix: AssertionError ([('thinking', 4333), ('working', 11323)], talking [(463, 2964), (660, 3167), (3329, 5832), (9374, 11887)])
- after fix: tests/e2e/test_web_ui.py 8 passed; repro 3/3 passed
- full suite: e2e all passed; only failures were other sessions' in-flight work (test_layers mid-edit, now passes; untracked test_open_data.py)
- step 5: 47e7ab0 failing test, 9842310 fix; staged only own hunks (others left in tree)
