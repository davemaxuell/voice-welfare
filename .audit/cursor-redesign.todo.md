# Cursor redesign todo

Goal: replace the orb with a real-looking mouse pointer that glides to targets, with a small friendly animation while 청음 waits for the user's "go" or input.

Feature playbook steps (verbatim), with skips:

- [x] `how` over the affected subsystem. skip: read `cursor.js`, `browser/__init__.py` and the `focus` callers directly; one caller path.
- [x] `architect` for parallel design exploration. skip: one data shape (cursor mode), one boundary (`cursor_script`), no competing shapes worth building.
- [x] Write the throughput checkpoint as four todo items.
  - [x] Blocking first steps. n/a: nothing gates the work.
  - [x] Independent workstreams. n/a: `cursor.js`, three call sites in `browser/__init__.py`, one test; they are coupled.
  - [x] Shared mutable state. Peer sessions share this checkout, so touch only the cursor files and the new test.
  - [x] Smallest safe decomposition. One owner, because the draw-screenshot-adjust loop does not split.
- [x] Delegate code-writing to a subagent. skip: owning the diff directly; the work is one visual iteration loop. Said so in the reply.
- [x] Verify on the matching surface: real Chromium, screenshots of each mode, e2e test.
- [x] Rebase into small, ordered commits. skip: user has not asked to commit.
- [x] If the design is contested, `interrogate` before shipping. skip: not contested.
- [x] Run Opening a PR. skip: user has not asked for a PR.

Data shape: cursor mode, one of `move`, `click`, `wait`, set per action kind by a table in `browser/__init__.py`. `focus` maps to `wait`, `click`/`check`/`press` to `click`, everything else to `move`.

Done 2026-11-18. Verified: screenshots of each mode in real Chromium (light and dark page, near-edge flip), two e2e tests that fail on a broken mode table and on a click-blocking overlay, and 697 passing in tests/unit plus the new e2e file.
