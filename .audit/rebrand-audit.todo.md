# 정보취약계층 리브랜딩: 바꿔야 할 곳 전수 조사 (2026-11-18)

Goal: owner asked "find which parts need changes, do not miss any". Read-only.

## Investigation playbook steps

- [ ] 1. Route through the **how** skill. For motivation questions, also route through the **why** skill.
  - skip how fan-out: the question is an inventory over every file, not how one subsystem works. A swarm over a file manifest with a coverage check answers it.
- [x] 2. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
- [ ] 3. Produce the `how`-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
- [ ] 4. Apply the **unslop** skill to the reply.

## Swarm phases

- [x] Frame: manifest.py (677 files: 449 excluded by rule, 228 in 10 slices), BRIEF.md, coverage.py (seeded control caught 3/3)
- [x] Fan out: 10 workers, opus (launched 20:5x)
- [x] Ignored files checked by hand: .env TTS_SPEED=1.1 (GAP, local only), reports/evaluation-report.md (generated, regenerate), reports/피클…검토.md (dated research, 9 hits), .superpowers (session logs), apps/desktop/dist installer (rebuild only if metadata changes)
- [x] Aggregate: coverage.py exit 0 (228/228, 412 findings); verified 12 key claims in code; fixed my own 3 lines (CLAUDE.md:58, autopilot.py:44, picture.py:91), unit 858 passed
- [x] Report: .audit/rebrand-audit/README.md (summary, numbered items), findings.md/.tsv (all rows), tools/, run/

Scratch: C:\Users\user\AppData\Local\Temp\claude\57b4d719c7c95e20\645788fd-3c1c-42bd-b46a-ceed5c1bd820\scratchpad\rebrand-audit
