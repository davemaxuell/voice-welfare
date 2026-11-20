# Build plan: candidate 4

Order: spikes first (they can kill a unit), then vision slice, then Explorer slices, then apps. Each unit ends in a state its check proves. No unit changes `demo_scenarios.json`.

Slices a blind user can feel:
- Slice 1 (U0-U5): "화면 그림으로 설명해줘" on a web page.
- Slice 2 (U6-U7): "다운로드 폴더 열어줘", "그거 열어줘" in File Explorer, by filesystem.
- Slice 3 (U8): "지금 창 설명해줘" for a desktop window.
- Slice 4 (U9): "메모장 열어줘" with confirmation.

## Spikes (run before any unit depends on them)

### U0a. OpenAI image with strict json_schema
- Files: a throwaway script in the scratchpad, not the repo.
- Shape: one PNG (a test page screenshot) sent as `image_url` data URL, with `SIMPLE_TEXT_SCHEMA`-like strict schema `{summary, names}`.
- Check: 3 calls to the owner's vision model. Record HTTP status, latency p50, and whether the JSON parses under strict mode. Use `.env` only in the implementer's shell, never copy the key into any file.
- Kill condition: strict schema plus image is refused by the owner's model. Then the vision answer uses a plain text reply and a separate name check, and U3 changes.

### U0b. Background-tab screenshot in shared Chrome
- Check: `page.screenshot(mask=[...], style=..., scale="css")` on a claimed tab of `BROWSER_MODE=chrome` while another window is in front. Record time to return. A hang over 5 s is a failure.
- Kill condition: hang or blank image. Then picture is refused unless the tab is frontmost, and the speech says so.

### U0c. Explorer tree and PrintWindow
- Check on a test folder with 300 files: `uiautomation` walk of a restored window (control types, count, time). `PrintWindow` on the same window while another window covers it: fraction of non-black pixels.
- Record each number in `PLAN.md` follow-up notes or the implementer's report. A number is a fact, not a guess.
- Kill condition: PrintWindow returns black for Explorer. Then desktop picture is refused for that app and U8 explains only from UIA text.

### U0d. Launch paths for the first apps
- Check: `calc.exe`, `notepad.exe`, `mspaint.exe` argv launch on this PC, and the window class each one shows. Find Hangul's path through App Paths in the registry (read-only).

## Units

### U1. Image input on the LLM client
- Files: `core/llm.py` (`generate`, line 98), `tests/unit/test_llm_images.py` (new), `tests/conftest.py` (`FakeLlm.generate` line 108 gains `images=()`).
- Data shape: `images: tuple[bytes, ...]`. Body becomes `content` list only when non-empty.
- Check: `httpx.MockTransport` test asserts the body for text-only is byte-identical to the old body, and that an image call has `image_url` with `data:image/png;base64,` and `detail` from `LLM_VISION_DETAIL`.
- Must not break: every existing `generate` caller (`summarize_body`, `web_answer`, planners).

### U2. Pure picture gate and explainer types
- Files: `perception/screen.py` (types), `perception/gate.py` (`decide_picture`). The package imports only `core` and `safety`. `tests/unit/test_picture_gate.py`, `tests/unit/test_layers.py` (add `perception`: `{core, safety}`; `orchestrator` and `server` sets get `perception`).
- Data shape: `ScreenRead` (frozen), `PictureDecision(allowed, reason)`.
- Check: table test, one row per refusal reason (`auth`, `blocked`, `sensitive`, `iframe`, `login-title`, `not-requested`) plus `ok`. `source="auto"` with a thick page returns `not-requested`.
- Must not break: layer test passes with the new package listed.

### U3. ScreenExplainer.explain
- Files: `perception/screen.py` (`explain`). `tests/unit/test_explain_picture.py`.
- Check: fake `ScreenSource` and `FakeLlm` (records `images`). Cases: (a) number only in picture is removed and speech says so; (b) name not in `ScreenRead.names` is dropped; (c) speech starts with "화면 그림을 보고 설명할게요"; (d) refused picture gives reason speech and, for `auto`, falls back to text; (e) `vision=None` gives "그림으로 설명을 할 수 없어요" and never calls the source's `picture`.
- Must not break: `unsupported_numbers` (`safety/verify.py:169`) is called with `read.text_lines`, never with the model's own text.

### U4. Web picture source
- Files: `agents/web/browser/__init__.py` (`picture`, next to `observe` at line 566; Protocol unchanged), `tests/e2e/test_picture.py` (new).
- Check: unit-level spy on `page.screenshot` asserts `mask` contains `input, textarea, select, [type=password], iframe` and the cursor is hidden through `style`. E2E on the mock site (`practice_site`): the login page refuses the picture, a plain page returns a PNG.
- Must not break: `observe()` output and `_resolve_ref` (`browser/__init__.py:516`). The cursor overlay refactor (uncommitted, `__MODE__`) is coordinated with the peer session before this unit starts.

### U5. Route the picture into the browser skill
- Files: `agents/web/skills/browse.py` (`screen`, line 484), `understanding/rules.py` (a `그림|사진|이미지` clause on the `DESCRIBE_SCREEN` rule near line 198), `core/intents.py` (`DESCRIBE_SCREEN` gains `source`), `understanding/llm_planner.py` (`flat_to_intent` branch for `source`), `tests/unit/test_registry.py` (37 becomes 41).
- Check: the registry test passes with four new rows, each with two parsed examples on three states. Existing scenario expectations keep passing when run by the owner (not run by the implementer here).
- Must not break: `demo_scenarios.json` (never touched). `DESCRIBE_SCREEN` examples still give the text path.

### U6. Desktop contract and Explorer listing by filesystem
- Files: `core/desktop.py`, `agents/desktop/actions.py` (`parse_desktop_action`), `agents/desktop/apps.py` (`APPS`, `resolve_app`), `agents/desktop/port.py` (`DesktopPort`, `FakeDesktopPort` in `tests/fakes/desktop.py`), `safety/desktop_guard.py`, `agents/desktop/__init__.py` (`DesktopAgent.run` for `list`, `open_folder`, `go_up`). `tests/unit/test_desktop_guard.py`, `tests/unit/test_desktop_agent.py`. Add `agents.desktop` to `test_layers.ALLOWED` and to the `orchestrator` and `server` sets.
- Data shape: `DesktopAction` strict; `DesktopContext.user_folders` from the OS known folders at start.
- Check: a `.exe` target is denied with `DENIED_EXTENSION`; `..` and absolute paths in `name` are rejected at parse; a `name` matching two entries returns `ambiguous`; a `list` inside `tmp_path` returns names only. Extra key `path` gives `policy-denied` (schema).
- Must not break: `PolicyGuard` tests and `tests/unit/test_policy.py:50` (`coords` still denied).

### U7. Approval for desktop actions
- Files: `orchestrator/session.py` (`NOT_DONE` line 73, `_approve` line 1117), `agents/desktop/approval.py` (`desktop_fingerprint`, `desktop_recheck`). `tests/unit/test_desktop_approval.py`.
- Data shape: fingerprint = `{scope.id, op, targetName, folderPath, speech}`. No window title.
- Check: a fake listing change between ask and "눌러" drops the approval and names the change. 121 s later the approval is asked again. Opening a folder needs no approval; `open_item` always asks.
- Must not break: web `_approve` path (`tests/unit/test_approval.py`).

### U8. Windows port, window reading, explain-this-window
- Files: `agents/desktop/port.py` (`WindowsDesktopPort`: `list_folder` via `os.scandir`, `open_item` via `os.startfile`, `read_window` via `uiautomation`, `window_picture` via ctypes `PrintWindow`), `perception/screen.py` (desktop `ScreenSource` adapter). `pyproject.toml` gains `uiautomation` only if U0c passes.
- Check: `skipif(sys.platform != "win32")` tests on a temp folder; a fake port for the desktop explain path in `tests/unit/test_explain_picture.py` (no real desktop).
- Must not break: non-Windows import (`WindowsDesktopPort` is built only on win32, so `import` of the package never imports `uiautomation`).

### U9. Launching apps
- Files: `agents/desktop/apps.py` (add rows from APPS.md after U0d), `agents/desktop/__init__.py` (`open_app` op), `safety/desktop_guard.py`.
- Check: launch uses the fixed argv from the table; the model's text never reaches `subprocess`. Launch always asks first.
- Must not break: the first slice's Explorer rows.

### U10. Scenarios and reports
- Files: `src/cheongeum/evaluation/data/scenarios_30.json` (new steps only). Never `demo_scenarios.json`.
- Check: `check_expectations` accepts the new expectation keys (`source`, `used`). Owner runs `scripts/run_scenarios.py`.

## Risks to watch while building
- The picture path adds a network hop of image bytes to OpenAI. Each unit that sends one must keep the gate in front of it.
- Hand-synced lists: the intent registry, `NOT_DONE`, the layer sets, and `DESCRIBE_SCREEN` examples are four places. Derive where the code allows. Otherwise the test fails when they disagree.
