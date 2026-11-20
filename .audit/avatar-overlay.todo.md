# Avatar overlay (docs/desktop-ui-handoff.md) todo

Playbook: Feature (poteto-mode), steps verbatim.

1. [x] `how` over the affected subsystem. skip: read the shell, controller, API, turn contract, orchestrator queue and handoff paths directly; the handoff plan already maps them.
2. [x] `architect` for parallel design exploration. skip: the approved integration plan fixes the window split, snapshot message and choice contract.
3. Throughput checkpoint
   - [x] Blocking first steps. Snapshot/action contract and choice contract before code.
   - [x] Independent workstreams. n/a: one code-coupled feature; a worktree would drop the user's uncommitted changes they asked to preserve.
   - [x] Shared mutable state. Main checkout shared with two idle peers; Edit only, no stash, no commits.
   - [x] Smallest safe decomposition. One owner (root), slices 1-4 in order, each verified before the next.
4. [x] Delegate code-writing. skip: user asked for the work in this checkout with uncommitted changes preserved; independent review subagent keeps review separation.
5. [x] Verify on the matching surface (Electron via Playwright _electron + native UIA/Win32 checks; web controller and backend via pytest).
6. [ ] Rebase into small, ordered commits. skip: repo rule, commit only when asked.
7. [ ] If the design is contested, `interrogate` before shipping. skip: design came approved in the handoff.
8. [ ] Run **Opening a PR**. skip: not asked.

## Slices
- [x] S1 still overlay + bridge + Talk/Stop/open; 3x open/close = 1 session, 1 heartbeat, 1 copy (avatar.e2e one-session)
- [x] S2 approvals bound to displayed actionId; double click + window click + voice = 1 write; stale card / stale action = 0 (approvals)
- [x] S3 offeredChoices + /choice + login return (test_choices.py, login-handoff)
- [x] S4 mascot GLB motion from playback, still fallback, reduced motion, packaging (motion, still-pref, packaged exe)
- [x] Native a11y: UIA tree, focus stays in Chrome, real mouse click, real Ctrl+Shift+K (native-a11y, pre-mascot build; post-mascot rerun stopped by keystroke guard when the user switched windows)
- [x] Independent review: 3 medium + 9 low + 4 weak tests; all fixed except click-then-voice reply order (server stays correct) and Korean-only overlay text
- [x] Final full pytest: 1341 passed; Electron 5/5; T4 mutation check fails as predicted
