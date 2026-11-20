# organize and verify: todo

Goal: 24h of uncommitted peer work sits on one baseline commit. Check it compartment by compartment, then prove the whole app navigates real websites from a user's request, and leave the repo organized and committed in a reviewable order.

Trail: `.audit/organize-verify.tsv`

## figure-it-out
- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
  - [x] C1. Snapshot the tree to a private ref; script a tree fingerprint so every run proves the tree did not move under it.
  - [x] C2. Unit tests by compartment (voice, understanding, orchestrator, Agent A, Agent B, safety, speech, personal, server, layers).
  - [x] C3. E2E by compartment (browsing, navigation, autopilot, conversation, safety, api, web UI, multilingual, scenarios).
  - [x] C4. Fix every failure at its root cause, with a test that fails first where none exists.
  - [x] C5. Scripts: run_scenarios.py, check_llm / check_voice / check_welfare against the real APIs.
  - [x] C6. Whole app, live: server + real LLM + real sites, a scripted multi-turn user conversation through the REST API. Evidence saved. (Web UI path covered by test_web_ui with the mock LLM; not driven live.)
  - [x] C7. Organize the tree: ignore build output and scratch, decide what of drafts/research/docs belongs in git.
  - [x] C8. Commits: mechanical rename first (verified green on its own), then the work in slices that each pass.
  - [ ] C9. deslop and no-comments over the diff before the feature commits. skip: the peers' 8.7k-line feature diff was committed as tested; running comment-sicko over safety code written by seven sessions without the owner's say risked behavior changes. Open for the owner.
- [x] Phase D: Keep the audit trail (row per unit as it lands)
- [x] Phase E: Verify and hand back (whole against the predicate; cross-model review of the trail)
