# PLAN: build order for picture explanations and desktop apps

Order rules. Riskiest unknowns first, as spikes. Mechanical refactors before features. Pure code before code that touches the OS or the network. The slice a blind user feels first is Explorer by voice (M1), because it needs no network, no consent and no cost. Vision is de-risked in parallel by S1 and S2, and lands as M2.

Every unit ends green on `uv run pytest`. A unit that adds a package updates `tests/unit/test_layers.py` in the same change. No unit edits `demo_scenarios.json`. No test calls the real OpenAI or touches a real desktop.

## Spikes (run first, in parallel, each at most half a day)

**S1. Image plus strict `json_schema` on the owner's OpenAI model.** Not measured yet (`probe-facts.md`). Script `scripts/check_vision.py`, modeled on `scripts/check_llm.py`. Send 3 synthetic PNGs (big image with text, a popup over text, an empty chart) with `SHOT_SCHEMA`. Pass: strict schema accepted, p50 at most 8 s at 1568 px, cost per call recorded. Fail: drop `strict`, validate in code, or pick another OpenAI model. U8 and U10 wait for this.

**S2. `page.screenshot(mask=..., style=...)` in shared headed Chrome.** `no_viewport`, a background tab with Electron in front, and 125% DPI. Pass: returns within 1.5 s, the mask rect lands on the input (pixel sample), the cursor overlay is absent. Fail: refuse with reason `minimized` and allow pictures in chromium mode only. Never call `bring_to_front` to make it work.

**S3. Explorer through Shell COM.** On a temp folder: `Shell.Application().Windows()` from a dedicated COM thread, `Navigate2` on a normal and a minimized window, warm and cold timings, listing parity of `os.scandir` against Explorer on Downloads and Desktop (hidden and system rules). Pass: `Windows()` at most 300 ms warm, `Navigate2` works on normal windows, names match modulo hidden and system. Fail: `show_folder` becomes `open_default(folder)` on an explicit "창으로 보여줘" only. Listing is unchanged either way.

**S4. Rule parity.** Run the real rule parser (no server) over the `UNCHANGED` and `NEW` tables in `sketch/.../understanding/rules.py` and every `INTENTS` example in three states. Pass: no old utterance changes, all new ones read correctly. This is the first thing U4 does.

**S5. Listening test.** The owner hears 20 real file names through `speak_entry`. Pass: at least 18 are understood. Fail: change how extensions and underscores are spoken before U6 ships.

## Milestone M1: Explorer by voice

**U0. Move `ExecContext` and `OutcomeStatus` to `core/execctx.py`.** Files: new `core/execctx.py`, ten importers (`agents/web/{__init__,agent,autopilot}.py`, `skills/{browse,form,guided}.py`, `orchestrator/session.py`, `speech/screen.py`, `tests/unit/test_action_log_guard.py`). Done by a rerunnable codemod, not by hand. Data: `ExecContext` gains `grants: set[str]`, default empty. Proof: the whole suite is green with no behavior change. Must not break: `WebOutcome.status` values, `ctx.granted`.

**U1. Extract `GuardedExecutor` from `_run`.** Files: `safety/executor.py`, `agents/web/agent.py` (`_run` delegates). Data: `Subject(current_url, host, page_kind)`. Proof: `tests/unit/test_executor.py` with a parity table: a low unapproved TIMEOUT retries once, an approved TIMEOUT never retries, LOG_FAILED when the before-row fails on an approved action, ABORTED, counter, before and after rows. Existing `test_action_log_guard.py`, `test_safety.py`, `test_policy.py` pass untouched. Must not break: `_acted_since_observe` (passed as `before_effect`). Fallback if parity takes over a day: keep `_run`, copy it for apps, and share the test table.

**U2. Contracts.** Files: `core/actions.py` (`AccessTier` moves in, guard imports it), `core/turn.py` (`SessionState` and `SemanticAction` derived from their tuples, `APP_OPEN`, five semantic actions, `ExecutedAction.action: Action | AppAction`, `SeenInfo`, `AGENT_IDS.desktop`). Proof: `test_registry` equality checks, new `test_turn_contract.py` (an app turn round-trips `parse_turn_result`, `STATE_LABELS_KO` keys equal `SESSION_STATES`). Must not break: the JSON the web UI reads. Only optional fields are added.

**U3. App table, app contract, guard branch.** Files: `core/apps.py`, `core/desktop.py`, `safety/guard.py` (`_check_app`, `PolicyConfig.apps` and `roots`). Proof: `test_apps_registry.py`; `test_guard_apps.py` table: coordinates give DENIED_SCHEMA, a name with `..`, `\` or `:` gives DENIED_SCHEMA, a root escape through a symlink gives DENIED_PATH, `.exe` and `.lnk` open gives DENIED_EXECUTABLE, tier `none` gives DENIED_APP, stopped and the 12-per-turn limit behave as on the web. Must not break: `test_policy.py:50` (coordinates denied), `tier_of`.

**U4. Utterances.** Files: `core/intents.py` (four rows, help group, `topic_param`), `understanding/rules.py` (one block), `understanding/llm_planner.py` (derive from `topic_param`, delete the old branches), `orchestrator/session.py` (`_what_can_i_say` lead). Proof: S4 first. Then `test_registry.py` (37 becomes 41, `TOPIC_PARAMS` derived), new `test_app_rules.py`. Must not break: every existing example in its own state (`test_registry.py:35`) and on three screens (`:41`).

**U5. Pure Explorer and narration.** Files: `agents/desktop/explorer.py`, `speech/apps.py`. Data: `Entry`, `Listing`, `Located`. Proof: `test_explorer.py` on `tmp_path`: hidden, system and `desktop.ini` skipped, folders first, recent sort, NFD and NFC names, 1500 entries truncate at 1000, unreadable folder maps to an error, `locate` handles exact, stem, ambiguous extension and the 2-character minimum. Golden-text tests for `speak_window` (home, folder, empty, truncated, paging by 8). S5 sign-off.

**U6. Port, adapter, agent, skill, wiring (with the fake).** Files: `agents/desktop/{port,adapter,agent,skill,__init__}.py`, `tests/fakes/desktop_port.py`, `orchestrator/approvals.py` (table with the three existing kinds only), `orchestrator/session.py` (`_finish` surface and `historySpeech`, ROUTES, `_open_browser` returns `browse_state`, `_stop`), `agents/web/skills/form.py` (`reject` reads the table), `server/runtime.py` (`DESKTOP_APPS`, `PolicyConfig.apps`). Proof: `tests/e2e/test_desktop_session.py` runs the Usage transcript with `FakeDesktopPort`. It asserts: state `APP_OPEN`, `page == "app:explorer"`, `accessMode == "full"`, one `launch` call after two "열어줘", no file name in `export_history()`, STOP mid-list aborts, no action before consent, fixed sentence when `desktop` is `None`. Also `test_approvals_table.py`. Must not break: `test_approval.py`, form flows, `NOT_DONE` texts word for word.

**U7. `Win32Port`, minimal.** Files: `agents/desktop/win32.py` (`resolve_place`, `find_window`, `launch`, `show_folder`, `focus`), `scripts/probe_desktop.py`. Proof: marker `desktop`, skipped unless `DESKTOP_TESTS=1`. A manual smoke on a temp folder writes `reports/desktop-probe.md`. A default test imports `server.runtime` with `comtypes` missing and still passes. M1 is done here.

## Milestone M2: picture explanations

**U8. Vision core.** Files: `core/vision.py`, `core/llm.py` (`chat_request` extracted, `generate` unchanged in signature), `server/runtime.py` (`LLM_VISION_*`), `scripts/check_vision.py`. Proof: `test_vision_llm.py` with `http_mock`: body has an `image_url` data URL and `detail`, the schema is strict, a non-openai provider gives `None`, an incomplete `MaskReport` raises. `test_shot_boundary.py` (AST: `MaskedShot(` outside two adapters fails). Waits for S1.

**U9. Web capture.** Files: `agents/web/shot.py`, adapter `capture`, `agents/web/agent.py` (`capture`), `observe.js` and `ScreenOutline.media`, `auth_page.py` (fix `view.get("mainText")` to read `view["outline"]`, `auth_page.py:36`), guard `capture` rule. Proof: e2e `test_shot_mask.py` on the practice site with a stub vision that stores what it received: a typed name is the mask color at its rect, the cursor overlay is absent, the mock login page is refused, a fixture page with a `captcha` class is refused, a sensitive line the page cannot place is refused, an iframe is black, and a page with no capture grant never calls the adapter. Must not break: `observe.js` consumers (new key is optional), the cursor refactor now uncommitted in `cursor.js` (selector uses a prefix).

**U10. Sight.** Files: `sight/{__init__,policy,answer,sight}.py`. Proof: `test_sight_policy.py` (advise table: ask words, little text with media, refuse reasons, no model, granted or not) and `test_sight_answer.py` (unsupported number drops the summary, quote with foreign URL dropped, AI-addressed text gets the caution, pressable intersection, first-time label, `unclear`). No network.

**U11. Consent, approvals table, wiring.** Files: `orchestrator/{approvals,session}.py` (`shot` kind, `_grants`, STOP clears, `reject` rows), `agents/web/skills/browse.py` (`screen`, `ask_shot`), `understanding/rules.py` (`PICTURE_ASK` strand). Proof: `test_shot_flow.py` e2e with a fake vision: first request asks, "응" yields a labelled answer, the second request does not ask, STOP then request asks again, "거절" yields text only and the right words (not the mock-submit words, `form.py:421`), URL change before "응" drops the approval.

**U12. Vision QA.** `scripts/eval_vision.py`, opt-in, real OpenAI, 10 saved pages. Reports refusal correctness, summary-drop rate, image-only number cases reviewed by hand, p50 latency, cost, to `reports/vision-qa.md`. Gate for turning pictures on in the desktop app.

## Stage 2: files

**U13.** `APP_READ_ITEM` (reads PDF and HWPX with `docs.read_document`, `agents/web/docs.py:11`), `open` on a file with kind `app` approval, `agents/desktop/approval.py`, `reject` row. Proof: fingerprint changes when the file vanishes, the extension allow-list holds, the TTL re-asks.

## Stage 3: apps and windows

**U14.** Generic UIA driver (`uiautomation`), then Notepad per `APPS.md`. **U15.** `capture_window` for `picture_ok` apps (spike S6: PrintWindow of an occluded window at 125% DPI), Pillow for UIA-box masks.

## Appendix: verified anchors

| Claim | Where |
| --- | --- |
| `generate` takes `user: str`, builds messages | `core/llm.py:98`, `:105` |
| `StructuredLlm` protocol | `core/turn.py:373` |
| `Observation.url` required, no coordinates in `ActionTarget` | `core/actions.py:189`, `:55` |
| coordinates denied | `tests/unit/test_policy.py:50` |
| guard tier from URL, dispatch, read-only deny | `safety/guard.py:93`, `:103`, `:116`, `:169` |
| origin `"null"` for non-http | `core/jsutil.py:108-111` |
| run path to extract | `agents/web/agent.py:499-559` |
| name matching to mirror | `agents/web/agent.py:210` (`_locate`), `:190` (`follow_link`) |
| fingerprint and recheck | `agents/web/approval.py:47`, `:84`, `_page` at `:17` |
| `_approve`, `NOT_DONE`, TTL | `orchestrator/session.py:1117`, `:73`, `:71` |
| `_finish` reads web view, commits state, history | `session.py:597`, `:593`, `:601` |
| ROUTES, DESCRIBE_SCREEN, PREV | `session.py:1210`, `:1233`, `:1220` |
| `form.reject` falls to mock-submit text | `agents/web/skills/form.py:411-421` |
| deps dataclass, `_begin_turn`, `_stop` | `session.py:43`, `:328`, `:275` |
| `BrowseSkill.screen`, `ask_click` | `agents/web/skills/browse.py:484`, `:212` |
| injection caution to share | `speech/screen.py:123-127` |
| number check | `safety/verify.py:169` |
| `redact_text` truncates welfare pages | `safety/privacy.py:114-117`, `:165` |
| blocked, auth kind, auth bug | `agents/web/digest.py:17`, `auth_page.py:55`, `:36` |
| outline builder, cursor id | `agents/web/browser/observe.js:219`, `cursor.js:18` |
| adapter `page`, `observe` | `agents/web/browser/__init__.py:128`, `:566` |
| intent table, example counts | `core/intents.py:76`, `tests/unit/test_registry.py:28`, `:41` |
| old rules that would swallow app words | `understanding/rules.py:176`, `:197`, `:230`, `:278` |
| `READ_DOWNLOAD` example "다운로드 읽어줘" | `core/intents.py:167` |
| `flat_to_intent` hand branches | `understanding/llm_planner.py:54`, `:72-89` |
| `resolve_site` model for `resolve_app` | `understanding/sites.py:152` |
| LLM role overlay | `server/runtime.py:96`, `:109`, `:250` |
| layer table | `tests/unit/test_layers.py:12`, `:44` |
| `FakeLlm`, `scripted`, `http_mock` | `tests/conftest.py:98`, `:121`, `:164` |
| action log row shape | `personal/action_log.py:69` |
