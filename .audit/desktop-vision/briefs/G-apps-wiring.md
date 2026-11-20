# Brief G: wire the next apps (Milestone 4: sound and status, open windows, notes, settings) plus follow-ups

Worktree: `C:\Users\user\Desktop\voice-welfare-desktop` (branch feat/desktop-vision), uncommitted. It holds everything built so far:
the shared executor and approvals table, the app table and guard branch, File Explorer by voice end to end (`agents/desktop/agent.py` DesktopAgent, `agents/desktop/skill.py` DesktopSkill, session routing by surface in `orchestrator/session.py`: `_on_desktop`, `_surface`, `_web_meaning`, `_desktop_route`, `_with_desktop`), and the OS capabilities for the next apps in the port: `volume`, `set_volume` (floor 10, never mutes), `power`, `network`, `windows`, `focus_window`, `open_settings`, plus `core/settings_pages.py`, `personal/notes.py`, `speech/system.py` (golden sentences), `agents/desktop/status.py`.
Read the plan section "Apps, in proposed order" (`drafts/research results/screen pictures and desktop apps - plan.md`) and the docstrings of the modules above first. Unit suite at start: 1360 passed, 11 skipped. Parity baseline: `tests/fixtures/rule-readings-072710a.tsv` and `tests/unit/test_app_rules.py` (built by the previous unit; extend, do not weaken).

## What a user can say after this unit
```
"소리 키워줘" / "소리 줄여줘" / "소리 50으로 해줘"   → changes the master volume in fixed steps (10) or to a level; never below 10; unmutes; says the new level
"소리 크기 얼마야?" "배터리 얼마나 남았어?" "와이파이 연결됐어?" "지금 몇 시야?" "오늘 며칠이야?"   → one short sentence each, read by code
"지금 열린 창 뭐 있어?"                              → numbered list of open windows (app name and title), 청음's own windows excluded
"2번 창으로 가줘" / "메모장 창으로 가줘"            → brings that window to the front (titles never sent to any model)
"메모해줘 내일 10시 주민센터"                        → saves a note file in Documents\청음 메모; refuses a secret value with note_refusal's sentence
"메모 읽어줘" / "메모 목록"                          → numbered notes, newest first; "1번 읽어줘" reads one
"소리 설정 열어줘" / "글자 크기 설정 열어줘"          → opens that fixed Windows settings page
"음악 폴더 열어줘" then "1번 틀어줘"                  → already works through OPEN_ITEM (check it does, add a test)
```

## Design decisions (made; follow them)
- Every effect goes through the guard, the executor and the action log, like folder actions. Add app rows to `core/apps.py`: `sound` (소리, 볼륨; control; verb `set_volume`), `windows` (열린 창; control; verb `focus_window`), `notes` (메모; control; verbs `save_note`); move `settings` from not-yet to control with verb `open_settings`. Keep 메모장 (Notepad) a separate not-yet row; longest alias wins, so "메모장" never means notes.
- `AppAction` gains closed fields only, never free strings that reach the OS: `page: SettingsPageId | None` (Literal from `core/settings_pages.py`), `level: int | None` (0 to 100), `pick: int | None` (1-based index into the list 청음 last spoke; the agent resolves it to a window handle and the port re-checks the pid). Validate per verb (a set_volume needs level; focus_window needs pick; open_settings needs page; save_note needs nothing else: the note text is NOT in the action, the agent holds it and the action log label is a code sentence without the text). Guard: these verbs are low risk; `set_volume` below the floor is clamped by the port, not denied.
- Reads (volume, power, network, time, window list, note list) are observations, not guarded effects, like folder listing.
- Intents (new rows, help group "컴퓨터"): `SET_VOLUME {direction: up|down|set, level?}`, `SYSTEM_STATUS {target: volume|battery|network|time|date}`, `LIST_WINDOWS`, `FOCUS_WINDOW {name}` ("2번", or an app or title word), `TAKE_NOTE {text}`, `READ_NOTES`, `OPEN_SETTINGS {target}`. Reuse existing flat LLM slots where the planner already has them; `TAKE_NOTE` text comes only from rules (the LLM must not invent note text: `llm=False` or map only from the user's words; decide and say).
- Rules: placed with the other desktop rules (`desktop_intent()` in `understanding/rules.py`), words-based, never state-based. Run the parity harness (`.audit\desktop-vision\codemods\s4_parity.py`, add your new sentences to its NEW list in a copy under `.audit/runs/` if you need) and list every changed old reading in your report; only UNKNOWN → new meaning changes are allowed, plus any you justify one by one.
- "N번" after a list: `DesktopAgent` keeps one "last numbered list" (folder entries, name candidates, windows, notes). A bare or verbed "N번" picks from whichever list was spoken last, with the verb deciding (가/전환 → focus, 읽어 → read note or file, 열어/틀어 → open). Model this as one tagged value, not parallel fields.
- Surface: window list and notes are desktop surface (state APP_OPEN), like folders. Status sentences and volume do not change the surface (return the current state).
- Window titles and note texts never reach model history: `historySpeech` code sentences only.

## Follow-ups from earlier units (fix in this unit)
1. `safety/executor.py`: the LOG_FAILED result lacks `actionId` and `verified`, and `LOG_FAILED` is not in the execution error codes (`core/actions.py`), so a turn carrying it fails TurnResult validation and ends in RECOVERING. Fix both and add a test that a LOG_FAILED turn validates (web and desktop).
2. `agents/web/skills/browse.py` `read_download` crashes on `browse_state(None)` when no web page was observed yet. Fix and test.
3. "다시 시작" after "멈춰" in a folder resumes the web (`browse.resume`) because STOPPED loses the surface. Remember the surface at stop and resume the folder listing where it was. Test.
4. `web/static/app.js` labels accessMode "full" as "지원 사이트(연습 신청 가능)", wrong for `page` starting with `app:`; show "폴더·앱" there. Keep the change minimal.
5. `agents/desktop/port.py` `zone_marked` docstring: an unreadable mark counts as marked (True), matching `Win32Port`.
6. Help: the 컴퓨터 group is read even when the desktop is off. Hide it then (help pages get the desktop flag from the session).
7. Make `core/apps.py` `_index`/`_find` and `speech/apps.py` `_when` public (the capabilities unit imported them privately); migrate the callers.

## Tests
`tests/unit/test_app_rules.py` extended (every new sentence in every state; parity diff list updated);
`tests/unit/test_desktop_skill.py` extended or a new `tests/unit/test_system_skill.py` with FakeDesktopPort (each sentence above, floor at 10, unmute, "2번 창으로 가줘" after a list, focus refused for a window not in the last list, note saved to a tmp Documents folder, secret note refused, notes read newest first, settings page opened by id only, history has no titles or note text);
`tests/e2e/test_desktop_session.py` extended with one end-to-end path per app through `handle_turn`;
guard table cases for the new verbs and fields (unknown page id, level out of range, pick missing → DENIED_SCHEMA).
E2E runs with the reuse_mock plugin: `PYTHONPATH=C:\Users\user\Desktop\voice-welfare\.audit\desktop-vision\codemods MOCK_SITE_WAIT_S=5 uv run pytest -p reuse_mock tests/e2e/<file>`. Run the desktop session file and the approval-related files (`test_safety.py`, `test_conversation.py`, `test_autopilot.py`) at the end.

## Files you may touch
`core/apps.py`, `core/desktop.py`, `core/actions.py` (error codes only), `core/intents.py`, `understanding/rules.py`, `understanding/llm_planner.py`, `safety/guard.py` (app branch only), `safety/executor.py` (follow-up 1 only), `agents/desktop/*`, `speech/system.py`, `speech/apps.py`, `personal/notes.py`, `orchestrator/session.py`, `orchestrator/approvals.py`, `agents/web/skills/browse.py` (follow-up 2 only), `web/static/app.js` (follow-up 4 only), `server/runtime.py`, tests.
No real desktop effects (no volume change, no window focus, no settings page) in any test or manual run.

## Done when
Unit suite green; parity diff reported and justified; e2e desktop session and approval files green; report lists each follow-up as fixed with its test.
