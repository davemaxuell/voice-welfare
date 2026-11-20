# Rubric (picker and judge only; candidates do not see this)

Score each criterion 1 to 5 with one sentence of evidence that cites the candidate's files.

1. **Safety held by structure.** No coordinate path exists. No model-written command can reach the OS. Every desktop action has a role and a name the guard can judge. Approval and its fingerprint work for a window. Masking happens before capture and cannot be skipped by a caller. Vision output cannot become an instruction or an unlabelled fact. These are enforced by types and single choke points, not by prose.
2. **Fit and blast radius.** The design honors the strict `Action` and `TurnResult` models, the intent registry rules, the layer table, `_approve`, and the action log. It does not create two ways to do one task or a second parallel pipeline. It adds few hand-synced lists. The changes to existing files are small and named.
3. **Interface depth.** Skills and the orchestrator see a small surface. UI Automation, Playwright and OpenAI wire details stay behind it. Callers do not coordinate several calls to do one thing.
4. **Testable offline.** Desktop and vision both have fakes that fit the existing test style. Scenario coverage is planned. Each build unit ends in a named check.
5. **Experience for a blind user.** What is spoken is short and honest. Latency is considered. Failures have a spoken path. Image answers are labelled. The proposed apps and Korean utterances match real needs.
6. **Build plan.** Units are small and ordered so each proves itself. The riskiest unknowns come first as spikes: the Explorer UI Automation tree, an OpenAI image call with a strict schema, screenshot of a background tab. Nothing depends on an unmeasured assumption.
