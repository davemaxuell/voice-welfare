# 정보취약계층 리브랜딩 (2026-11-18)

Goal: 청음을 시각장애인 전용이 아닌 정보취약계층 음성 웹 에이전트로 소개. 기능·동작은 그대로.

## Refactoring playbook steps

- [ ] 1. Pin the behavior contract first. Run the **how** skill over the affected subsystem to learn the contract, then write a characterization test, snapshot, or equivalence harness that captures current behavior before any structure moves. If the area has no coverage, write the pin before touching structure. Type check and lint are not a pin.
  - skip how: no subsystem logic moves, only audience wording. Pin = unit suite before/after + grep proof that no test asserts the changed strings.
- [ ] 2. Name the structure the code is missing per **principle-model-the-domain**. Boring code stays when the shape is already clear and local. The reshape must delete branches or invalid states, not add indirection.
  - skip: no structure is missing. Wording only.
- [ ] 3. Name the target shape. State what the module layout, types, and call graph should be if built today (**principle-foundational-thinking**, **principle-redesign-from-first-principles**). If the target crosses a function boundary, run the **architect** skill for parallel design exploration of the shape before the move.
  - skip: target shape is unchanged code; target is the audience sentence in each doc and prompt.
- [ ] 4. Subtract before you add. Delete dead code, collapse one-caller wrappers, drop redundant validators, and remove orphan references before introducing the new shape (**principle-subtract-before-you-add**). The smallest change that reaches the target shape ships (**principle-laziness-protocol**). A speculative cleanup that "might help" gets reverted.
- [ ] 5. Move in small behavior-preserving steps, each keeping the pin green. For API reshapes, migrate every caller and delete the old API in the same wave (**principle-migrate-callers-then-delete-legacy-apis**). No compatibility shims, no parallel old-and-new paths. Spot-check every rename against the actual files. Renames silently miss usages in strings, prose, and back-references. Delegate the mechanical edits to a subagent using your configured refactoring model (default in poteto-mode's Models section) with a specific scope (file paths, the names being moved, the behavior to hold). Pick each subagent's reasoning level for the job, per the Subagents section.
  - no delegate: ~20 hand-worded edits, each needs judgment on whether the prompt relies on eyes-free.
- [ ] 6. Prove behavior is unchanged on the real artifact, not "it compiles" (**principle-prove-it-works**). For larger reshapes, run an equivalence check: a script that diffs old-vs-new outputs, a recorded baseline replayed against the new code, or a smoke run on the matching surface via the relevant driver skill.
- [ ] 7. Confirm the change is worth keeping. The success measure is reduced reader load (**principle-minimize-reader-load**). If the diff does not lower reader load somewhere, revert it.
- [ ] 8. Rebase into small ordered commits. A subtraction commit, then the reshape, then any follow-on cleanup. Shape them with the **sequence-verifiable-units** principle skill, so each behavior-preserving slice stays green before the next. Run **Opening a PR**.
  - skip: user did not ask to commit; 50+ files carry peers' uncommitted work. Leave in working tree.

## Status (20:45)

Steps 1, 4, 5, 6, 7 done. Pin: unit suite 858 passed before and after (`uv run --no-sync`). No test asserts a changed string. Step 4 had nothing to subtract.
BLOCKED: venv rebuild. pyproject edit triggered a uv rebuild; peer smoke server (PID 42696, :8787, since 14:12) locks cheongeum-server.exe, so `uv run` fails and cheongeum-mock.exe is deleted. Needs the server stopped, then `uv sync`.
Left as dated record: docs/superpowers/plans/2026-11-18-sound-cues.md "blind user" goal line.

## Task todos

- [ ] Identity docs: CLAUDE.md (L7, L58), README (L1, L3, L172), pyproject description, docs/기획요약.md
- [ ] LLM prompts naming the audience: chat.py, autopilot.py, welfare/agent.py x2, i18n.py x2, session.py, screen.py, core/picture.py (untracked, peer picture work; never stage)
- [ ] Comments: core/actions.py:171, apps/desktop/main.cjs:18
- [ ] Report text: scripts/run_scenarios.py:229; user-test plan framing; sound-cue spec/plan one-liners
- [ ] Leave: .audit, research_notes, drafts, fixtures/snapshots, practice_site article, demo_scenarios.json (CLAUDE.md: do not modify), screen-reader comments (still true for blind users)
- [ ] Flag: docs/architecture.png says "User (Visually Impaired)" (raster)
