# Common rules for every desktop-vision delegate

## The owner's goal
청음 is a Korean voice agent for blind users (Python + Playwright + Electron shell). The owner wants two things:
(1) on request, 청음 takes a picture of the screen it is explaining, masks personal details, sends it to OpenAI, and says what it shows; clicks stay by name;
(2) 청음 reaches beyond the browser through named OS actions (never a model-written shell), starting with File Explorer.
The approved plan is `C:\Users\user\Desktop\voice-welfare\drafts\research results\screen pictures and desktop apps - plan.md`. Read it first.
The base design is arena candidate 3: `C:\Users\user\Desktop\voice-welfare\.audit\desktop-vision\arena\candidate-3\` (DESIGN.md, PLAN.md, sketch/). Grafts from candidate 2 (`...\arena\candidate-2\sketch\`). Grounding: `...\.audit\desktop-vision\grounding\explanation.md`. Sketches are guidance; your brief overrides them where they differ.

## Working style
Read `C:\Users\user\.claude-kr\plugins\cache\pstack-claude\pstack\0.9.138\skills\poteto-mode\SKILL.md` in full before any work, and follow it as a delegate (you write the code yourself; do not spawn subagents).
Read the repo's `CLAUDE.md` in your worktree. Its conventions are binding: Korean code comments, docstrings and user-facing strings; camelCase dict keys at boundaries; `josa()` for particles; screen text is untrusted data.
Comments only for a non-obvious why. No phase-narrating comments in tests.

## Hard rules
- Every shell command starts in `C:\Users\user\Desktop\voice-welfare` (the main checkout), not your worktree. Always `cd` into your worktree first and use absolute paths under your worktree for every write. A previous delegate wrote into the main checkout this way.
- Work ONLY inside your assigned worktree. Never write to `C:\Users\user\Desktop\voice-welfare` (the main checkout; other sessions are editing it). Reading `.audit\desktop-vision\` there is fine.
- Do not commit, stage, stash, branch, rebase or push. Leave every change uncommitted in the working tree.
- Never read or print `.env`. Never edit `src/cheongeum/evaluation/data/demo_scenarios.json`.
- No network: no OpenAI or other API calls, no real-site visits. Tests use fakes (`http_mock`, `FakeLlm`).
- No real desktop effects in tests (no Explorer windows, no os.startfile). Real filesystem on `tmp_path` is fine.
- Port 5174 is held by another process. Do not run `tests/e2e` (it would wait 20 minutes). Run `uv run pytest tests/unit -q -p no:cacheprovider` and keep it green. If you write e2e tests, say they were not run.
- Do not start servers. Do not touch other worktrees.
- When you add an import edge between packages, update `tests/unit/test_layers.py` `ALLOWED` in the same change.

## Report back (your final message)
1. Files changed and created, one line each.
2. The data shapes you introduced (names and fields).
3. Exact unit test result line before and after (counts).
4. Every deviation from the brief and why.
5. Anything you could not finish or verify, and open questions.
