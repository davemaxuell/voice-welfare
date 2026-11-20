# Build plan

Spikes come first. Each one answers one unknown that could change the shape, and each ends in a number or a yes/no. Spike scripts live in `scripts/spikes/` and are deleted once their result is written into the unit that uses it. A spike that touches windows opens its own test window under a temp folder. It never touches the user's windows.

After U0 and U1, two tracks run in parallel: vision (V1 to V4) and desktop (D1 to D7). They join in J1 and J2. Every unit ends with `uv run pytest` green.

## Spikes

| ID | Unknown | Probe | Pass and decision |
|---|---|---|---|
| S1 | Does strict `json_schema` work with an image part on the owner's model, and how slow is it? | Send 3 fixture screenshots (image-only notice, chart, masked form) from the mock site, 5 times each, with `PICTURE_SCHEMA`. The owner runs it, because it needs the `.env` key. | 15 of 15 valid JSON. Record p50 and p95 latency and input tokens for `detail=high` and `auto`. Numbers on the notice read correctly 5 of 5. Decides `detail`, the vision timeout, and whether auto-picture is affordable. |
| S2 | Does `page.screenshot(mask=…, style=…)` work on a background tab of headed shared Chrome? | Headless Chromium and headed `BROWSER_MODE=chrome` with another window in front. Capture with masks over filled inputs. Decode the PNG with a 30-line zlib reader. | Masked rect centers are `#000000`. The cursor overlay is absent. Capture under 1 s. No hang within 5 s. Decides whether `capture_page` calls `bring_to_front` first. |
| S3 | Can a Python STA thread map Explorer HWND to folder, navigate and select through `Shell.Application`, including Windows 11 tabs? | `comtypes` on one thread. Open a temp-folder Explorer window, add a second tab by hand, then read `Windows()`, `LocationURL`, `HWND`; call `Navigate2` and `SelectItem`. Launch `explorer.exe <temp>` from a background process. | Location is right for the active tab 10 of 10. Each call under 150 ms. Decides the active-tab rule (title match or UIA tab state) and whether a launched window reaches the foreground. If it does not, record which fallback works (AllowSetForegroundWindow, a restore-then-activate sequence) or keep the spoken fallback. |
| S4 | Where do known folders really live on this PC, and is the zone mark readable? | `SHGetKnownFolderPath` for six ids. Check OneDrive redirection. Read `:Zone.Identifier` on a browser-downloaded file. Time `os.scandir` on a 2,000-file folder. | Six real paths. Zone mark read. Listing under 100 ms. |
| S5 | Do UIA rectangles line up with `PrintWindow` pixels under DPI scaling, and how long is a UIA walk? | Notepad with typed text at 100% and 150% scale. `PrintWindow(PW_RENDERFULLCONTENT)`, paint the Document rect, sample pixels. Walk Notepad, Explorer on 500 files, and a Chrome window with a 300-node cap. | No unmasked text pixel inside the rect at either scale. Walk p95 under 1.5 s for the cap. Decides the DPI awareness call and the node budget. |
| S6 | Is the Playwright browser a descendant of the server and the Electron shell an ancestor? | Toolhelp32 snapshot in both browser modes, under `npm --prefix apps/desktop start`. | Both hold. Classification under 10 ms. If Chrome mode re-parents, fall back to the profile path in the command line. |

## Units

### U0. Move shared pieces down a layer, with no behavior change

- Files: `core/context.py` (new, `ExecContext` and `OutcomeStatus` from `agents/web/agent.py:37-63`); `core/documents.py` (moved from `agents/web/docs.py`); `safety/shot_policy.py` (new, holds `BLOCKED` from `agents/web/digest.py:17`); `core/turn.py` (`SemanticAction = Literal[SEMANTIC_ACTIONS]`); `agents/web/auth_page.py:36` (read `outline.mainText`). Importers migrate in the same unit: `autopilot.py`, `skills/browse.py`, `skills/form.py`, `skills/guided.py`, `speech/screen.py`, `orchestrator/session.py`, `downloads.py`, `tests/unit/test_docs.py`.
- Data shape: unchanged.
- Check: full suite green. New `tests/unit/test_auth_page.py::test_app_named_only_in_body_is_verification`.
- Must not break: `test_layers` (no new layer yet), `test_registry`, every importer.

### U1. One approval gate with surface owners (web only)

- Files: `orchestrator/approvals.py` (new `ApprovalOwner`, `WebApprovals`), `orchestrator/session.py` (`_approve`), `core/context.py` (`Rechecked`).
- Data shape: an approval dict without `surface` is web.
- Check: `tests/unit/test_approval.py`, the approval and TTL cases in `tests/e2e/test_safety.py`, unchanged. Spoken sentences byte-identical.
- Must not break: `click`, `assist` and submit approvals, `guided.after_assist`.

### V1. Image transport and the vision role

- Files: `core/llm.py` (`ImagePart`, `user_content`, `generate(images=())`, `create_vision_llm`), `server/runtime.py` (`LLM_VISION_*`, `VISION`, `llm_roles()['vision']`).
- Data shape: `content: [{"type":"text"}, {"type":"image_url","image_url":{"url":"data:image/png;base64,…","detail":"high"}}]`.
- Check: `tests/unit/test_llm_vision.py::test_body_without_images_is_unchanged` (http_mock, byte comparison), `::test_image_becomes_content_list`, `::test_vision_llm_only_for_openai`, `::test_vision_off_builds_nothing`.
- Must not break: every text caller and `FakeLlm`.

### V2. Shot contracts and the capture refusal rules

- Files: `core/shot.py`, `safety/shot_policy.py` (`refuse_capture`, `credential_window`).
- Check: `tests/unit/test_shot_policy.py`, a table over CAPTCHA flag, BLOCKED title, login, verification, password field, `AUTH_HANDOFF`, credential window, shell, minimized, and a plain page that returns `None`. `::test_masked_shot_requires_complete_report`.
- Must not break: `digest_page` blocked detection, now importing `BLOCKED`.

### V3. Masked web capture

- Files: `agents/web/browser/observe.js` and `core/actions.py` (`outline.media`), `agents/web/browser/capture.py` (`MASK_SCRIPT`, `plan_masks`, `capture_page`), `agents/web/browser/__init__.py` (`probe_masks`, `capture`), `agents/web/agent.py` (`shot_source`). Practice site gets `notice-image.html` (an image-only notice with known numbers) and `captcha.html` (a local fake reCAPTCHA frame, no network). `tests/helpers/png.py` reads pixels with `zlib` only (no new dependency).
- Data shape: `MaskPlan(marks, inputs, personal, frames, captcha)`.
- Check: `tests/unit/test_mask_plan.py` (pure). `tests/e2e/test_capture.py::test_filled_inputs_are_black`, `::test_resident_number_paragraph_is_black`, `::test_cross_origin_frame_is_black`, `::test_cursor_is_not_in_the_picture`, `::test_media_counts_on_image_notice`, `::test_captcha_frame_sets_subject_captcha`. Measure capture time on the mock form: under 500 ms headless.
- Must not break: observe output for existing tests (media is additive). Coordinate with the uncommitted peer work in `cursor.js` and `browser/__init__.py`. Only add two methods there.

### V4. ScreenPicture and the browser screen description

- Files: `vision/picture.py`, `vision/__init__.py`, `understanding/filters.py` (`picture_request`), `understanding/rules.py` (DESCRIBE_SCREEN branches), `core/intents.py` (third DESCRIBE_SCREEN example), `core/turn.py` (`Flags.picture`, `AGENT_IDS.picture`), `agents/web/skills/browse.py` (`screen`, `picture` argument), `tests/unit/test_layers.py` (`vision`), `tests/fakes/vision.py`.
- Check: `tests/unit/test_picture.py` covers the label, unconfirmed numbers named, offered names as an exact intersection, a `blocked` reading discarded, a personal detail dropped, the injection caution, the mask note once, `unavailable` falling back, and `signal` passed. `tests/e2e/test_screen_picture.py` covers the notice page (1 call, labelled speech, `flags.picture`), the CAPTCHA page (0 calls), the login page (0 calls), and a text-rich page saying "화면 설명해줘" (0 calls in auto mode).
- Must not break: `test_registry`, `brief_screen` tests, `scripts/run_scenarios.py` 35 of 35. The test runtime has no vision LLM, so the picture path falls back silently unless asked.
- This is the first felt vision slice: "화면 사진으로 설명해줘".

### D1. Desktop action contract

- Files: `core/desktop.py`, `core/turn.py` (`AnyAction` union, new semantic values, `AGENT_IDS.desktop`).
- Check: `tests/unit/test_desktop_contract.py`. A `..` part, a separator, a `coords` key or a missing place returns `None`. A web and a desktop action both parse inside `parse_turn_result`.
- Must not break: `tests/unit/test_policy.py` (web `coords` still denied).

### D2. Words for the desktop

- Files: `understanding/apps.py`, `understanding/rules.py` (`desktop_intent` after `CLEAR_LOGIN`), `core/intents.py` (four rows, help group 컴퓨터), `understanding/llm_planner.py` (`flat_to_intent` branches), `agents/desktop/skill.py` (a shell with `available = False` whose methods return the `UNAVAILABLE` sentence until D4 to D7 fill them; it takes no `picture` yet, so the desktop track does not wait for V4), `orchestrator/session.py` (`self.desktop` and the four `ROUTES` rows in their final form, so `READ_ITEM` already falls back to `read_download`), `tests/unit/test_layers.py` (`agents.desktop`), `tests/unit/test_registry.py` (count 41).
- Check: `test_registry` (examples on three states, planner round trip, routes). `tests/unit/test_desktop_rules.py::test_rules_do_not_steal_existing_examples` with the eleven pairs in `sketch/tests/unit/test_desktop_usage.py`, including "다운로드 폴더에 뭐 있어?" with `more` false (the 더 inside 폴더) and "이 파일 읽어줘" as `READ_ITEM`. `tests/e2e/test_desktop.py::test_deictic_read_falls_back_to_download_when_desktop_off`. `tests/unit/test_docs.py:61` still gives `READ_DOWNLOAD`.
- Must not break: every existing example, help pagination tests.

### D3. Places and the desktop guard

- Files: `agents/desktop/model.py`, `places.py`, `registry.py`, `safety/desktop_guard.py`.
- Check: `tests/unit/test_places.py` covers a junction pointing outside (Windows only, `mklink /J` needs no admin) returning `None`, hidden and system files skipped, recent-first order for downloads, and `match_entry` ambiguity returning candidates. `tests/unit/test_desktop_guard.py` covers `.exe` and `.lnk` denied, `.xlsm` asking, `requiresConfirmation` asking, `read_file` on `.pdf` allowed and on `.hwp` denied, an unknown app denied, the rate limit counted with web actions, and stop.
- Must not break: `PolicyGuard`, which is untouched.

### D4. Read-only folder slice, wired end to end

- Files: `agents/desktop/agent.py` (`_run`, `observe_folder`, `stat`, `read_file`), `skill.py` (`list_items`, `read_item`, `pick_numbered`), `speech.py`, `port.py`, `windows.py` (only `known_folder`, `foreground_hwnd`, `family`; ctypes, no COM), `orchestrator/session.py` (`OrchestratorDeps.desktop`, `_unknown` numbered owner, `list_just_read`, `_finish` desktop report and `history`), `server/runtime.py` (`DESKTOP_APPS`, `desktop_port`), `tests/fakes/desktop.py`, `tests/conftest.py` (`with_desktop`).
- Data shape: draft extras `desktop=DesktopView`, `history="다운로드 폴더 목록 5개를 읽어 드렸어요."`.
- Check: `tests/e2e/test_desktop.py::test_list_downloads_reads_recent_first`, `::test_numbered_read_after_desktop_list_reads_text`, `::test_web_list_after_desktop_list_takes_numbers_back`, `::test_history_has_no_file_names`, `::test_desktop_off_says_one_sentence`. An owner probe on this PC: `DESKTOP_APPS=true`, "다운로드 폴더에 뭐 있어?" through `/api/turn`. Measure turn latency on the real Downloads folder: under 300 ms.
- Must not break: web numbered picks ("2번 눌러줘" in `test_browsing`), welfare "1번" picks, scenarios 35 of 35.
- This is the first felt desktop slice.

### D5. Focus and the Explorer window

- Files: `windows.py` (`foreground`, `windows`, `explorer_location`, `explorer_selection` on the STA thread, per S3), `agents/desktop/focus.py`, `orchestrator/session.py` (`Turn.focus`, `_turn_focus`, surface routes for DESCRIBE_SCREEN and PREV, `_understand` page label, help lead), `skill.py` (`describe` for explorer and shell, `up`).
- Check: `tests/unit/test_focus.py`, a table of user switch, unchanged foreground, own window, browser window and disabled desktop. `tests/e2e/test_desktop.py::test_explorer_in_front_describes_its_folder`, `::test_browser_in_front_keeps_web_description`, `::test_disabled_desktop_makes_no_os_calls` (FakeDesktop call count 0). Measure focus resolution p95 under 30 ms on this PC.
- Must not break: every web test with `DESKTOP_APPS` off.

### D6. Named window actions

- Files: `windows.py` (`execute` for `launch_app`, `show_folder`, `select_item`, `focus_window`), `agent.py` (`launch`, `show_folder`, `bring_forward`), `skill.py` (`open`, `open_item` for folders, FOLLOW_LINK on the desktop surface).
- Check: e2e with FakeDesktop. "파일 탐색기 열어줘" gives one `launch_app` and the new window observed. "다운로드 폴더 열어줘" with Explorer in front navigates that window and opens no new one. "회의자료 폴더로 들어가줘" goes in. "뒤로 가줘" goes up, and at the root says "맨 위예요". Action log rows have host "파일 탐색기" and no path. An owner probe on a temp folder measures launch to observed window: under 2 s.
- Must not break: OPEN_SITE and OPEN_BROWSER parses, and the web FOLLOW_LINK path.

### D7. Open a file after confirming aloud

- Files: `agents/desktop/approval.py`, `agent.py` (`point_at`, `open_file`), `skill.py` (`ask_open`, `recheck`, `run_approved`, `not_done`), `orchestrator/session.py` (owner dispatch by `surface`).
- Check: `tests/e2e/test_desktop.py::test_internet_file_open_asks_then_opens_once`, `::test_changed_file_after_ask_is_not_opened`, `::test_executable_is_refused_with_spoken_reason`, `::test_open_unconfirmed_keeps_approval`, `::test_stop_clears_desktop_approval`, and `::test_two_minutes_later_asks_again` (with `deps.clock`).
- Must not break: the U1 web approval tests.

### J1. Pictures of desktop windows

- Files: `windows.py` (`window_texts`, `capture_window`), `agents/desktop/mask.py`, `agent.py` (`shot_source`), `skill.py` (the `picture` constructor argument, `describe` for foreign and credential windows, picture path), `tests/unit/test_layers.py` (`agents.desktop` may import `vision`). Needs V4 and D5.
- Check: `tests/unit/test_mask.py`. e2e with FakeDesktop: a foreign window gives a UIA summary; "그림으로" gives 1 FakeVision call with a `MaskReport`; a credential window gives 0 calls and a refusal; a minimized window asks to bring it forward. An owner probe repeats S5 inside the product: Notepad text area black in the PNG.
- Must not break: the web picture path.

### J2. Documentation and dependency

- Files: `CLAUDE.md` (desktop and vision sections), the consent text (screenshots go to OpenAI with masks), `pyproject.toml` (`uiautomation; sys_platform == 'win32'`).
- Check: `uv sync` on Windows. Full suite green. Scenarios 35 of 35. `test_layers` green.
- Must not break: `demo_scenarios.json`, which no unit touches.
