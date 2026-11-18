# agreed fixes: todo

Playbook: figure-it-out (bespoke). Session "skills and intents". Main checkout, package `cheongeum`.

- [x] Read the Principles section of poteto-mode (in context).
- [x] Phase A. Frame. Done predicate, scope, rigor (below).
- [x] Phase B. Design the workflow (units below).
- [x] Phase C. Run the loop, one unit at a time, each verified before the next.
  - [x] U1 (1a). Guard sets the risk floor for risky clicks on the full tier. Goal mode stops with "needs approval". The orchestrator speaks the confirmation. Failing tests first.
  - [x] U2 (S2). Stop while busy. Space and hotkey cancel during `thinking`. The mic listens during `thinking` for the stop word only (`stopOnly`).
  - [x] U3 (S5, S6). Vault, record, discovery, and guided answers behind both gates. `DialogueState.stop` clears all six waits and the reply says what was dropped.
  - [x] U4 (A1). Intent registry, planner produces all but APPROVE and STOP, help command "뭐라고 말하면 돼?".
  - [x] U5 (1b). Real-site login through focus, explain, go word, click. ID and password pages only. Update CLAUDE.md for the rule change.
  - [ ] U7 (pending the owner's answer). "Decline and offer a person" tier. Proposed: decline one request, short code list, speak the number first. A real call needs a phone service.
    - Owner answered 2026-11-18 (in the Pickle session): the proposed option. Say it can't, speak the matching official contact number first (that service's, else 129), then 2 to 3 things it can do instead. No calls. See `.audit/pickle-gaps.todo.md` "Owner decisions".
  - [x] U6. Navigation units 0 to 2. skip: the peer session in `voice-welfare-nav` (branch `feat/navigation`) already built them. Messaged it on 2026-11-18.
- [x] Phase D. Decision trail in `.audit/agreed-fixes.tsv`, one row per landed unit.
- [x] Phase E. Full suite, probes, report.

Done predicate:
- `probes/goal_submit_check.py`: no receipt, and the goal turn ends in `WAITING_FOR_USER_CONFIRMATION` with a spoken explanation. "승인" then gives the receipt.
- `probes/gate_checks.py`: the vault stays empty after "취소" then "응". While stopped and before consent, no vault value is spoken and nothing is saved.
- `probes/inventory.py`: "llm yes" for every intent except APPROVE and STOP.
- New tests fail before each change and pass after. `uv run pytest` passes, run while port 5174 is free.

Rigor: high for U1, U3, U5 (safety, failing test first). Medium for U4 (behavior-preserving refactor, full suite as the pin). U2's browser half has no automated test harness, so it gets code review plus a server-side test.
