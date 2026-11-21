# ux-upgrade-plan (Multi-phase or multi-PR plan playbook)

- [x] 1. When the change is one or two files with an obvious approach, skip the plan. Say so and stop. — skip: three docs, ~40 work items, many files
- [x] 2. Settle open questions by prototype before you write. — skip: no prototype ran; every shaping question was settled by reading origin/main or a read-only scan. Unproven items listed in plan Appendix A, each is the first Build box of its PR.
- [x] 3. Explore in subagents (guard-the-context-window). — 4 read-only explorers reported (l10n inventory, state+a11y map, test coverage map, motion/tokens/overlay/perf map)
- [x] 4. Copy the skeleton into the plan file and fill every placeholder. One section per PR. — 12 PR sections, CU-1..CU-12
- [x] 5. Write under /technical-writing in full, then /unslop.
- [x] 6. Run check-plan.mjs on the plan and fix every line it prints. — "12 PR sections, 0 problems", exit 0
- [x] 7. Hand back. Post the plan path and the script's output, then stop.

Plan: C:\Users\user\.claude-kr\orchestrate\cheongeum-ux-upgrade\docs\plan.md
Scan scripts: C:\Users\user\.claude-kr\orchestrate\cheongeum-ux-upgrade\tools\
State: waiting for the operator's go. Nothing in the repository was changed except this todo file.
