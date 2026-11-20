# Incident: picture delegate wrote into the main checkout

Found 2026-11-18 19:40. Delegate B (picture core) was briefed to work only in C:\Users\user\Desktop\voice-welfare-pic.
Its files there stop at 15:05. The main checkout holds continued versions written 15:05-16:54 (cut off by the usage limit), beyond the brief (U12 wiring, scripts/eval_pictures.py), and it edited .audit/desktop-vision.todo.md.
Evidence: tests/unit/test_picture.py is byte-identical in both trees; main's agents/web/shot.py extends the -pic version; no peer session (voice-welfare-37, -aa, -e3, full check) wrote them.
Likely cause: every shell command resets cwd to the main checkout, so relative paths landed there.

## Untracked files in the main checkout from the delegate
- scripts/eval_pictures.py
- src/cheongeum/agents/web/browser/blocks.js
- src/cheongeum/agents/web/browser/full_page.js
- src/cheongeum/agents/web/shot.py
- src/cheongeum/core/picture.py
- src/cheongeum/practice_site/site/picture.html
- src/cheongeum/speech/picture.py
- tests/e2e/test_picture_capture.py
- tests/e2e/test_picture_turn.py
- tests/fixtures/picture_cases.json
- tests/unit/test_picture.py
- tests/unit/test_picture_speech.py
- tests/unit/test_shot_plan.py
- tests/unit/test_vision_llm.py

Unclear owner (may be the delegate or a peer): src/cheongeum/agents/web/file_answer.py, tests/e2e/test_file_answers.py

## Tracked files with picture-related added lines (count), shared with peer edits
- README.md (3)
- src/cheongeum/agents/web/agent.py (26)
- src/cheongeum/agents/web/browser/__init__.py (38)
- src/cheongeum/agents/web/skills/browse.py (30)
- src/cheongeum/core/actions.py (2)
- src/cheongeum/core/intents.py (1)
- src/cheongeum/core/llm.py (14)
- src/cheongeum/core/turn.py (1)
- src/cheongeum/orchestrator/session.py (12)
- src/cheongeum/safety/guard.py (1)
- src/cheongeum/safety/privacy.py (4)
- src/cheongeum/server/runtime.py (12)
- src/cheongeum/speech/screen.py (1)
- src/cheongeum/understanding/rules.py (9)
- src/cheongeum/web/static/app.js (2)
- tests/unit/test_docs.py (1)
- tests/unit/test_layers.py (2)
- tests/unit/test_registry.py (1)

Not touched by me. Peers voice-welfare-37 and -aa were told to stage only their own hunks. Owner decides: keep it as the picture implementation, or move it out.
