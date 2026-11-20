# Build plan

Order: spikes, then the vision slice, then the shared-run refactor, then the desktop slice, then the second app. Each unit ends in a state that a test or a measured number proves. Paths are repo paths. No unit modifies `src/cheongeum/evaluation/data/demo_scenarios.json`.

Every unit must keep `uv run pytest` green. "Must not break" names what that unit is most likely to break.

## Spikes (riskiest unknowns first)

Spikes are throwaway scripts under `scripts/spike/`. The owner runs them, because they read `.env` or open windows on the PC. Each ends with a number or a yes/no written into `docs/desktop-vision-spikes.md`.

| Id | Question | Probe | Pass | If it fails |
|---|---|---|---|---|
| S1 | Does the owner's OpenAI model accept an image part with strict `json_schema`? How slow is it? | `scripts/spike/vision_call.py`: 5 fixture PNGs (a Korean notice posted as an image, a chart, a popup, a blank page, a fake CAPTCHA), 3 runs each, at 1100x860 PNG, JPEG q70, and 768 px wide. | Schema accepted. p50 under 5 s. Notice text correct in 4 of 5. `kind=captcha` on the CAPTCHA. | Pick the smallest size that reads Korean. If strict schema fails, use `json_object` for this role only and validate in code. |
| S2 | Does `page.screenshot` work on a background tab of shared Chrome (`BROWSER_MODE=chrome`), with the window covered or minimized? | `scripts/spike/bg_screenshot.py`: two tabs, shoot the back one, 10 tries, 5 s timeout. | 10 of 10 under 2 s, with no visible tab switch. | `capture` calls `bring_to_front` first and the plan says so aloud. Never fall back to a full-desktop grab. |
| S3 | Does DOM masking hold under real pages? | `scripts/spike/mask_fidelity.py` on the practice site: inputs, an iframe, a phone number in text, the visual cursor. Decode the PNG and count non-black pixels inside each masked box. | 0 leaked pixels. Marker attributes gone afterwards. | Paint overlays in the page instead of Playwright `mask=`. |
| S4 | Windows facts for Explorer. | `scripts/spike/desktop_facts.py`: (a) known folders through `SHGetKnownFolderPath`, with OneDrive redirection; (b) `os.startfile(folder)` gives a `CabinetWClass` window within N ms; (c) `Shell.Application.Windows()` through comtypes can `Navigate2` and `SelectItem`; (d) a window can be captured by handle while covered (`ImageGrab.grab(window=)` or `PrintWindow`); (e) UIA outline time for a large window, and whether `Edit` controls report password state and rectangles. | (a) and (b) are required. (c), (d), (e) each get a yes/no and a time. Outline under 300 ms at depth 8. | (c) no: each folder opens a new window and the old one is closed by handle. (d) no: `raise_window` then capture, and say so. (e) slow: lower the depth cap. |

S1 to S3 gate the vision slice. S4 gates the desktop slice. S4 (a) and (b) are enough for the first desktop slice.

## Vision slice

**V1. Picture type and the vision client.**
Files: `src/cheongeum/core/picture.py` (new), `core/llm.py`, `server/runtime.py` (`llmVision`, `_llm_role(env, "VISION", llm)`, `llm_roles()["vision"]`).
Data: `Picture`, `MaskPlan`, `MaskReport`, `Refused`, `VisionLlm`.
Check: `tests/unit/test_vision_llm.py::test_payload_has_one_image_part_and_strict_schema` (through the `http_mock` fixture), `::test_non_openai_provider_gives_no_vision`, `tests/unit/test_llm_roles.py::test_vision_role_overrides`.
Must not break: `OpenAIStructuredLlm.generate` signature and every `FakeLlm` caller.

**V2. Decide the mask and the refusal.**
Files: `safety/privacy.py` (`private_values`, and `redact_text` built on it), `agents/web/shot.py` (new).
Data: `mask_plan(view, known_private) -> MaskPlan`, `picture_refusal(view) -> Refused | None`.
Check: `tests/unit/test_shot.py`: every field id is an anchor; a resident number in `mainText` is in `private`; a vault name is in `private` only when on screen; login, verification, blocked and form views are refused. `tests/unit/test_llm_privacy.py` passes unchanged, which proves `redact_text` output did not move.
Must not break: `redact_text` results.

**V3. Capture in the adapter, behind the guard.**
Files: `agents/web/browser/mask.js` (new), `browser/__init__.py` (`capture`), `core/actions.py` (`"capture"`), `safety/guard.py` (`READ_ONLY_TYPES`), `server/runtime.py:264`, `agents/web/agent.py` (`capture`, `_run(perform=)`, `known_private`, `_typed`), `practice_site/site/` (one new page: a notice as an image, an input, an iframe, a phone number).
Data: `WebOutcome.shot`.
Check: `tests/e2e/test_picture.py::test_inputs_frames_and_private_text_are_black` (pixel count, as in S3), `::test_marker_attributes_are_removed_even_on_failure`, `::test_login_page_is_never_captured` (no `capture` action in `actions`, no screenshot call), `::test_capture_is_logged_and_counted`, `::test_unlocated_private_text_refuses`. `tests/unit/test_structure.py::test_picture_is_only_sealed_by_the_two_capture_functions`.
Must not break: `tests/unit/test_policy.py:50` (coords denied), `tests/unit/test_action_log_guard.py`, the peer session's uncommitted cursor work in `browser/__init__.py` and `cursor.js`. Rebase on it before touching the file.

**V4. Eyes, the LOOK intent, and the first thing a user can feel.**
Files: `speech/picture.py` (new), `agents/web/skills/browse.py` (`look`), `core/intents.py` (LOOK row), `understanding/rules.py` (LOOK rule), `core/turn.py` (`"look"`, `Flags.fromImage`), `orchestrator/session.py` (`OrchestratorDeps.vision`, `Eyes`, ROUTES `LOOK`, history marking), `tests/fakes.py` (`FakeVision`), `web/static/app.js` (show a "사진으로 본 내용" tag when `flags.fromImage`).
Data: `Seen`, `PICTURE_SCHEMA`.
Check: `tests/unit/test_eyes.py`: out-of-range label indexes are dropped; `kind=captcha` discards the text; a number missing from sources adds the caution; a resident number in the model text is redacted; `names` are redacted before sending. `tests/e2e/test_look.py::test_image_notice_is_described_and_labelled`, `::test_named_item_from_picture_is_pressed_by_number` (the click goes through `follow_link` with a `ref`, `role`, `name` target), `::test_picture_speech_is_hidden_from_the_planner`. `tests/unit/test_registry.py` with the count at 38.
Must not break: the 37 existing rows' examples, the help-page tests in `test_registry.py`, the DESCRIBE_SCREEN examples.

**V5. Picture beside text on thin pages.**
Files: `agents/web/browser/observe.js` (`outline.visual`), `core/actions.py` (`ScreenOutline.visual`, optional), `agents/web/shot.py` (`wants_picture`), `skills/browse.py` (`screen`).
Check: `tests/e2e/test_look.py::test_describe_screen_adds_picture_only_on_thin_pages`, `::test_page_intro_and_autopilot_never_capture` (FakeVision call count is 0 across a `run_goal`).
Must not break: `tests/e2e/test_browsing.py`, `test_scenarios.py`. Measure the `summarize_body` latency before and after. It must not move.

## Shared run (pure refactor)

**R1. Move `ExecContext`, extract `guarded_run`.**
Files: `core/exec.py` (new), `safety/run.py` (new), `agents/web/agent.py` (`_run` becomes a call), every importer of `ExecContext`.
Check: no test file changes. `tests/unit/test_action_log_guard.py`, `tests/e2e/test_safety.py` and `tests/unit/test_layers.py` pass as they are.
Must not break: the `LOG_FAILED` rule, the rule that only a low-risk unapproved `TIMEOUT` is retried, `_acted_since_observe`.

## Desktop slice

**D1. The tables and the contract.**
Files: `core/apps.py` (new), `core/desk.py` (new), `core/turn.py` (`ExecutedAction.action` union, `DESKTOP` state, four semantic actions), `understanding/apps.py` (new).
Check: `tests/unit/test_structure.py::test_every_app_row_is_complete`, `::test_web_and_desk_action_types_do_not_overlap`, `::test_no_coordinates_in_any_contract`. `tests/unit/test_desk_contract.py`: a path string, a key chord, `..`, and a separator in a name are all rejected by `parse_desk_action`; a `TurnResult` with one web and one desk action parses.
Must not break: `parse_turn_result` for every existing e2e result.

**D2. The gate.**
Files: `safety/guard.py` (`check_desk`, `app_tier`, `DeskContext`, `PolicyConfig.desktopApps`).
Check: `tests/unit/test_desk_policy.py`, table-driven: unknown app denied, app not enabled denied, program file denied even when approved, unknown file kind asks then is approved by id, a low `risk` on a risky act is raised, a secret value in `value` is denied, stop and rate limit behave as in `check`.
Must not break: `tests/unit/test_policy.py`.

**D3. Folders and the agent, against a fake desktop.**
Files: `agents/desktop/folders.py`, `agent.py`, `approval.py`, `shot.py` (new), `tests/fakes.py` (`FakeDesktop`), `tests/unit/test_layers.py` (two rows, generalized `layer()`).
Check: `tests/unit/test_folders.py` on `tmp_path`: hidden entries are skipped, a symlink out of the root raises `Escaped`, files sort newest first, `find_entry("진단서")` finds `진단서.pdf` and two matches return candidates. `tests/unit/test_desk_agent.py`: no new window after `open_file` gives `unconfirmed` and no second call; a failing action log blocks an approved open with `LOG_FAILED`; `test_desk_approval.py`: a changed file stamp and a closed window are both reported.
Must not break: the layer table's no-cycle test.

**D4. The front surface, and the first desktop thing a user can feel.**
Files: `agents/desktop/skills/desk.py` (new), `agents/desktop/windows.py` (only `windows`, `launch`, `show_folder`, `open_file`, `known_folders`), `orchestrator/session.py` (`_front`, `Front`, ROUTES, `_approve`, `_finish`, `NOT_DONE`, `_unknown`), `core/intents.py` (OPEN_FOLDER, OPEN_APP), `understanding/rules.py`, `understanding/llm_planner.py`, `server/runtime.py`, `pyproject.toml` (`uiautomation; sys_platform == 'win32'`).
Check: `tests/e2e/test_desktop.py` with `desktop_runtime(tmp_path, FakeDesktop())`: `::test_open_documents_list_and_open_first`, `::test_same_words_work_in_a_folder` (목록, 뒤로, 화면 설명), `::test_value_wait_is_dropped_when_leaving_the_form`, `::test_unknown_file_kind_asks_then_opens_once`, `::test_file_changed_after_the_question_is_not_opened`, `::test_stop_clears_a_desktop_approval`, `::test_returning_to_the_browser_resumes_the_form`, `::test_unknown_app_is_asked_back_not_searched`. `tests/unit/test_registry.py` at 40. `tests/unit/test_structure.py::test_every_approval_kind_has_a_not_done_sentence`. On the owner's PC: `scripts/check_desktop.py` opens the Documents folder and reads it back.
Must not break: every existing e2e file (they run with `DESKTOP=off`, so `front` stays `"pc"`), `scripts/run_scenarios.py` (35 of 35).

**D5. A desktop window in a picture.**
Files: `agents/desktop/windows.py` (`outline`, `raise_window`, `capture`), `agents/desktop/skills/desk.py` (`look`, approval kind `look`), `pyproject.toml` (`Pillow`).
Check: `tests/e2e/test_desktop.py::test_folder_window_is_described_from_a_picture`, `::test_editable_controls_are_in_the_mask_plan`, `::test_window_with_a_password_field_is_refused`, `::test_ask_policy_app_needs_a_go_word_before_capture`. On the owner's PC: capture a Notepad window with text typed in and confirm the text area is black.
Must not break: V3's pixel test.

## Second app and wrap-up

**A1. Named acts for the next app** (Notepad, see `APPS.md`).
Files: `core/apps.py` (one row), `understanding/rules.py` (`IntentContext.app`, `match_act`), `core/intents.py` (`APP_ACT`, 41 rows), `agents/desktop/windows.py` (`invoke`, `send_keys`, `type_text`, `read_text`).
Check: `tests/e2e/test_desktop.py::test_notepad_dictate_read_back_and_save_asks_first`. Adding the row must need no edit outside `core/apps.py` and the tests. If it does, the table is wrong and the design goes back to the sketch.

**W1. Words and evaluation.**
Files: `CLAUDE.md`, the consent text (it must say that screen pictures go to OpenAI and that input fields are masked), `src/cheongeum/evaluation/data/scenarios_30.json` (new steps only), `evaluation/__init__.py` (`check_expectations` key `fromImage`), `scripts/check_vision.py`.
Check: `uv run python scripts/run_scenarios.py` reports the new steps and the old 35.

## What each slice proves to a blind user

1. After V4: on a page whose notice is a picture, "화면 사진으로 설명해줘" reads the notice, and "1번 눌러줘" presses what it named.
2. After D4: "문서 폴더 열어줘", "1번 열어줘", "읽어줘" opens a PDF and reads it, with no screen reader skill.
