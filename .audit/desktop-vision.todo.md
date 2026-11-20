# desktop-vision: implement the plan (owner said "implement the plan", 2026-11-18 14:30)

Goal: 청음 explains the screen from a picture sent to OpenAI, and opens folders, files and basic apps by named actions (File Explorer first).
Plan: drafts/research results/screen pictures and desktop apps - plan.md (base = arena candidate 3 + grafts; packages in .audit/desktop-vision/).
Worktree: C:\Users\user\Desktop\voice-welfare-desktop, branch feat/desktop-vision from 072710a. Nothing is committed (owner approves commits).
Trail: .audit/desktop-vision.tsv (main checkout).

figure-it-out:
- [x] Read the Principles section of poteto-mode
- [x] A. Frame. Done = every unit below has its check green in the worktree (unit + e2e suite, no MISSING vs baseline), and the two felt slices run end to end with fakes ("다운로드 폴더에 뭐 있어?" → "1번 읽어줘"; "화면 사진으로 설명해줘" → "1번 눌러줘"). Paid S1/U13 scripted, not run.
- [x] B. Design workflow: serial units in one worktree (no commits allowed, so no delegate branches); one delegate per unit while I run spikes outside the worktree; I review every diff and run the suite myself.
- [x] C. Run the loop (units below)
- [x] D. Trail rows as each unit lands (.audit/desktop-vision.tsv)
- [x] E. Verify: full suite 2162 passed 0 failed; felt slice 1 (folders) VERIFIED e2e + real port pieces; felt slice 2 (pictures) NOT in this worktree (incident, owner decides)

Owner decisions not answered, defaults applied (plan's recommendations):
1. image-only numbers spoken with a label; 2. no question when the user asks for a picture; 3. "다운로드 폴더" = Windows Downloads;
4. reading a file never asks, opening asks for internet-marked or unknown kinds; 5. app order as proposed; S1 NOT run (paid, standing rule).

Units:
- [x] baseline at 072710a: 870 passed 10 skipped (voice-welfare-base, reuse_mock plugin)
- [x] S3 Shell COM: Navigate2 normal+minimized+worker thread, select ok (spikes/S3-result.md)
- [x] S2 background tab capture 160-172 ms, masks black, cursor hidden (spikes/S2-result.md). NOTE: another writer replaced this line once; unknown author.
- [ ] S5 skip: needs display-scaling change on the owner's PC; app-window pictures wait
- [x] S7 calculator UIA spike (spikes/s7_calc.py)
- [x] live read-only smoke through the real runtime (spikes/live_smoke.py)
- [ ] S6 skip: needs the owner's ears; rule-based speaking, flagged in report
- [x] U0 ExecContext → core/execctx.py
- [x] U1 shared executor (safety/executor.py) with parity table; full suite 930 passed
- [x] U2 approvals table (orchestrator/approvals.py) with three kinds
- [x] U3 app table, AppAction, guard branch, APP_OPEN + ExecutedAction union (merged)
- [x] U4 intents + rules (parity: only allowed changes)
- [x] U5 pure listing + narration (merged)
- [x] U6 desktop agent/skill/wiring (e2e desktop session 10 passed)
- [x] U7 Windows port (merged; opt-in real run passed)
- [x] U8 open a file after confirming aloud; full suite 1548 passed 0 failed
- [ ] U9-U12 pictures: a separate, unidentified writer built these in the main checkout; my picture delegate is paused in voice-welfare-pic; owner to decide
- [ ] U13 live QA awaits owner approval. The ten-page offline exercise and optional live runner are in scripts/eval_pictures.py.
- [x] M4 capabilities (port: volume, power, network, windows, focus, settings; notes; speech) merged
- [x] M4 wiring: 소리와 상태, 열린 창, 메모, 설정, 음악 틀기; full suite 1998 passed 0 failed
- [x] M4 계산기 by UIA ids (real opt-in run passed)
- [ ] M4 메모장 typing: deferred to owner (Win11 tabs could type into the owner's open documents)
- [ ] M4 문서·사진 설명: waits for the picture decision
