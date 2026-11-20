# report-fixes-2026-11-19 (07:00 QA report → fixes)

Playbook: Autonomous run (steps verbatim)
- [x] 1. State the exit condition as a checkable predicate before the first iteration (tests green, repro fixed, all N PRs merged, pixel-diff zero).
- [x] 2. Pick the wake mechanism using Claude Code's `loop` skill (a built-in, not a pstack skill). — skip: no external event; subagent completions notify this session directly.
- [x] 3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help. — commit part skip: user said do not commit.
- [x] 4. Mid-run discoveries that support the goal are yours.
- [x] 5. Checkpoint every iteration via the **show-me-your-work** skill (.audit/report-fixes-2026-11-19.tsv).
- [x] 6. Stop when the predicate is met.

Bug fix playbook per defect: reproduce → root cause → test first → fix → verify on same surface. PR step skip: no commits/PRs requested.

## Defects (my ranking, blind/voice-only users first)
- [x] D1 High. Discovery ignores district (사상구 → 기장군 program first); precheck omits residence gate. welfare/discovery.py, welfare/agent.py
- [x] D2 High. "정부24 … 로그인하거나 신청하지 말고" → LOGIN → mock login page. understanding/rules.py, skills/browse.py login
- [x] D3 High. Stop during in-flight navigation: late document commits; Stop says no pending browser work. browser/__init__.py, session._stop
- [x] D4 High. Bokjiro public pages misread as auth gate (금융인증서 label). agents/web/auth_page.py, session auth dispatch
- [x] D5 Med-high. NPS national hotline → FIND_PLACE; "그 번호를 다시 천천히" → global rate change; "그 결과의 제목" → READ_FIELD. rules.py, places.py
- [x] D6 Med-high. "공식 안내 열어줘" after preparation doesn't open the selected program's source. rules.py, session B→A
- [x] D7 (partial: date exceptions and disclaimer open) Medium. Browser answers: no structured source, date exceptions. autopilot/verify
- [x] D8 Medium. Loop guard treats distinct read_more offsets as same; splitter loses site. autopilot.py, session splitter
- [x] D9 Small. today_iso() uses UTC → wrong check date in KST morning. core/jsutil.py
- [x] D10 English request on auth page answered with Korean secret-handling guidance (L6.3). session._maybe_spoken_secret
- [x] D11 Server TTS ignores speech rate. web/static/speaker.js, api.js, voice/tts.py
- [x] Full pytest green; docs/report-fixes-2026-11-19.md written; log audited; cross-model review of trail

- [x] Independent review x2 + trail review; fixes applied; final suite 1298 passed; docs/report-fixes-2026-11-19.md written
