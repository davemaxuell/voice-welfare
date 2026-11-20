# Brief E: folders by voice, end to end (plan units U4, U6, U8)

Worktree: `C:\Users\user\Desktop\voice-welfare-desktop` (branch feat/desktop-vision). It already holds, uncommitted:
U0 (`core/execctx.py`), U1 (`safety/executor.py` GuardedExecutor), U2 (`orchestrator/approvals.py` table), U3 (`core/apps.py`, `core/desktop.py` AppAction and `safe_path`, guard app branch, `core/turn.py` APP_OPEN and the ExecutedAction union), U5 (`agents/desktop/explorer.py`, `speech/apps.py`) and U7 (`agents/desktop/port.py` DesktopPort, NullPort, `create_port`, `agents/desktop/win32.py`, `tests/fakes/desktop_port.py` FakeDesktopPort).
Read those modules first; they are the contract. `git diff --stat` and `git status` show them.

The first thing a user should feel: "다운로드 폴더에 뭐 있어?" then "1번 읽어줘". Then opening a file after confirming aloud.

## Notes from the U7 author (read `agents/desktop/port.py` and `win32.py` docstrings)
- Port error codes are `NOT_SUPPORTED`, `TARGET_NOT_FOUND`, `TIMEOUT`, `OS_ERROR`. Add `OS_ERROR` to the execution error code list in `core/actions.py` (the only edit allowed there) and give it a Korean failure sentence where the web's `_FAIL_MESSAGES` live, or in the desktop agent's own table.
- `launch(argv)` requires an absolute `argv[0]` that exists (a bare name could run a planted file). For explorer, "파일 탐색기 열어줘" should call `show_folder` on the Downloads folder (that opens 청음's own Explorer window); no launch is needed. Leave `launch` for later apps.
- `zone_marked` returns True when the mark cannot be read (cautious), False only when there is no mark.
- Import the fake in tests as `from fakes.desktop_port import FakeDesktopPort` (pytest puts `tests/` on sys.path).
- `show_folder` opens 청음's own window the first time (about 2 s) and moves the same window afterwards (about 0.3 s). Never wait for it before speaking the listing if you can avoid it; failure is not spoken as an error.

## Files you may touch
New: `agents/desktop/agent.py`, `agents/desktop/skill.py`, tests below. Edit: `core/intents.py`, `understanding/rules.py`, `understanding/llm_planner.py` (only if new params need mapping), `orchestrator/session.py`, `orchestrator/approvals.py`, `server/runtime.py`, `server/__main__.py`, `agents/web/docs.py` (move, below), `tests/unit/test_layers.py`, `tests/unit/test_registry.py` (the row count only), `tests/conftest.py` (only to let a test runtime take a desktop port).
Do NOT touch `core/llm.py`, `core/picture.py`, `agents/web/browser/`, `speech/picture.py` (picture work merges later).

## U4. New sentences (rules first; run the parity harness)
Parity harness: `.audit\desktop-vision\codemods\s4_parity.py` (main checkout). Baseline: `.audit\desktop-vision\spikes\s4-before.tsv` (504 rows, recorded at 072710a).
Run it in this worktree after your change (`.venv\Scripts\python.exe -B -X utf8 <harness> <out.tsv>`, then `--diff` against the baseline). Only these differences are allowed; anything else is a regression:
- "다운로드 폴더에 뭐 있어?": READ_DOWNLOAD → OPEN_PLACE (the owner decided "다운로드 폴더" is the Windows Downloads folder).
- "바탕화면에 뭐 있어?", "바탕 화면에 뭐 있어": DESCRIBE_SCREEN → OPEN_PLACE.
- "신청서 파일 읽어줘": READ_DOWNLOAD → READ_ITEM {name: "신청서"} (on the web it is routed back to `read_download`, so web behavior is unchanged).
- Sentences that are UNKNOWN today and gain a meaning (folder and app sentences in the harness NEW list; "위 폴더로 가줘" → PREV).
- New APP_OPEN-state rows (the harness adds the state once SESSION_STATES has it); rules must not depend on state for these.
New rows in `INTENTS` (help group "컴퓨터", add it to HELP_GROUPS): `OPEN_APP` {target}, `OPEN_PLACE` {target, show}, `OPEN_ITEM` {name}, `READ_ITEM` {name}. Two or more examples each; the first must parse on IDLE, BROWSING and APPLICATION_OPEN.
Rules, placed after CLEAR_LOGIN and before the READ_DOWNLOAD rule:
- App names come from `core/apps.py` (`find_app`). `<app alias> … (열어|켜|실행|띄워|시작|보여)` → OPEN_APP with the app id. Rows of every tier match, so "메모장 열어줘" no longer becomes a web search.
- Places need a folder word so common words stay free: `<place alias>\s*폴더`, `바탕\s*화면`, `내\s*문서`. With (열어|보여|뭐|목록|들어|가|읽어|알려) → OPEN_PLACE; `show` true for 열어/보여.
- "다운로드 읽어줘", "받은 파일 …" keep READ_DOWNLOAD.
- `^(\d{1,2})\s*번 …(읽어|들려)` → READ_ITEM {name: "N번"}; `…(열어|들어가|틀어|재생)` → OPEN_ITEM {name: "N번"}. A bare "N번" stays UNKNOWN.
- `<name> (파일|문서) (을|를)? (열어|틀어|재생)` → OPEN_ITEM; `<name> (파일|문서) (을|를)? 읽어` → READ_ITEM.
- `(위|상위|윗)\s*폴더` → PREV.
- `목록\s*(더|나머지|계속)` → LIST_LINKS {more: true} (the folder listing ends with "더 들으시려면 '목록 더'라고 하세요."; on the web it means the link list, which is what "링크 더" already does). Add it to the existing LIST_LINKS rule rather than a new rule.
Notes from the U3 author (read `core/apps.py` docstrings):
- Call `find_app` and `find_place` on the phrase before the verb, not the whole utterance, and try `find_app` before `find_place`. Known collisions: "한글로 말해줘" contains the hwp app name (no open verb, so it must stay what it is today); "그림판" contains the pictures alias "그림"; "다운로드 읽어줘" must stay READ_DOWNLOAD.
The LLM may produce the four new types (`llm=True`), using existing flat slots (`target`, `name`); `show` only from rules. Consent: desktop intents need consent (default).

## U6. Desktop agent, skill and session wiring
`agents/desktop/agent.py` `DesktopAgent` (layer `agents.desktop`):
- Owns the surface state: current place, the names below it (current folder), the current listing, the paging position, and the file being read with its reading position. The folder is re-listed from disk on every observe (never synced).
- Pass actions to the executor and guard as dicts (`model_dump(exclude_none=True)`), never `AppAction` instances: the guard routes to the app branch only for dicts.
- Guard reasons such as DENIED_EXECUTABLE contain the file name; speak them, but keep them out of `historySpeech`.
- Fill the observation summary with `core/desktop.py` `app_observation`. accessMode is `full` for the explorer surface.
- Every effect goes through `GuardedExecutor` with `Subject(current_url=None, host="app:explorer", page_kind=<place id>)`. Its `execute(action, signal)` maps AppAction verbs to port calls and calls `safe_path` again right before each effect (a name that no longer resolves inside the place gives NOT_FOUND, never an effect).
- Reading a file's text: move `agents/web/docs.py` down to a layer both agents may import (for example `core/docs.py`), migrate every caller, delete the old module in the same change. Run the reading on a thread.
`agents/desktop/skill.py` `DesktopSkill` returns drafts like `BrowseSkill` does (`core/turn.py` `draft()`), state `APP_OPEN`, page `app:explorer`, accessMode `full`:
- `open_app(target)`: control tier launches (explorer shows the Downloads folder and asks which folder: "파일 탐색기를 열었어요. 어느 폴더로 갈까요? 다운로드, 문서, 바탕 화면, 사진 중에서 말씀해 주세요."); not-yet: "<label>은 아직 열 수 없어요." (josa); never: a fixed sentence that 청음 does not open banking, certificate or identity apps and the user should open them directly.
- `open_place(place, show)`: list with `speech/apps.py` `speak_listing`; when `show` and the port is available, also `show_folder` (best effort; failure is not spoken as an error).
- `more()`, `back()` (parent folder inside the place; at the place root say so), `describe()` (re-list), `pick(n, verb)` (folder: enter; file + read: read; file + open: open; no verb: say what it is and the two words to use), `open_item(name)`, `read_item(name)` with `locate` (many: number the candidates and ask; none: say so), reading in chunks with "더 읽어줘" continuing.
- Every draft sets `historySpeech` to a code sentence with no file or folder names ("다운로드 폴더 목록을 읽어 줬어요."), so names never reach the planner's history.
`orchestrator/session.py`:
- `OrchestratorDeps.desktop` (None when off). When off, every desktop intent answers one fixed sentence: "이 컴퓨터에서는 아직 폴더와 앱을 열 수 없어요."
- The surface is the session state: APP_OPEN means the desktop. ROUTES pick by it: OPEN_APP, OPEN_PLACE → desktop. OPEN_ITEM, READ_ITEM → desktop on APP_OPEN; on the web OPEN_ITEM goes to `_unknown(text)` (today's UNKNOWN handling, which already resolves "2번" from the last link list) and READ_ITEM goes to `browse.read_download({"list": False})` (today's behavior). READ_MAIN with more, PREV and DESCRIBE_SCREEN (without picture) go to the desktop on APP_OPEN. A bare "N번" on APP_OPEN goes to `pick` from `_unknown`, before the link-list check. Everything else is unchanged and moves the user back to the web.
- `_finish`: an app draft never falls back to `self.web.current_view`; it fills the observation summary from the app view as U3 decided. `_history` stores `historySpeech` for app drafts.
- `_stop` aborts as today; the desktop agent drops any pending read position only if that is what the web does for reading (match it).
- `_what_can_i_say` and help pages include the 컴퓨터 group.
`server/runtime.py` and `server/__main__.py`: `DESKTOP_APPS` (default false; `--desktop` turns it on). On: `create_port()`; if the port is not available, desktop is None. When desktop is off, build the guard with `PolicyConfig(apps=())` so no app action can pass. Tests inject `FakeDesktopPort` through `create_test_runtime` (default desktop off, so existing e2e tests never touch a real desktop).

## U8. Open a file after confirming aloud
- The guard asks for unknown kinds; the agent raises risk for a file whose `zone_marked` is true (risk only goes up). Programs, scripts and shortcuts are refused by the guard with its sentence.
- On NEEDS_CONFIRMATION the skill asks with a code-built sentence, for example "'다운로드' 폴더의 '신청서.hwp'를 열려고 해요. 인터넷에서 받은 파일이라 여쭤봐요. 열려면 '진행해'라고 하세요." and stores the approval with kind `app` and a fingerprint: verb, place, names, the file's size and mtime, and the spoken question.
- Add the `app` row to `orchestrator/approvals.py`: world `app`, not_done "열지 않았어요.", the TTL semantic, run (open once inside `ctx.granted`), reject ("열지 않았어요. 폴더는 그대로예요." and state APP_OPEN). `_approve` re-observes the world the row names: for `app`, re-stat the file and compare the fingerprint; a changed or vanished file is not opened and the change is said.
- Opening never happens twice for one approval; an unconfirmed result is reported, not retried.

## Tests
`tests/unit/test_app_rules.py`: every new sentence in every state, and the harness diff equals the allowed list (save the after-TSV under `.audit/runs/` in this worktree).
`tests/unit/test_desktop_skill.py` (no browser, no port 5174): DesktopSkill and DesktopAgent with FakeDesktopPort on `tmp_path` folders and a real PolicyGuard: listing, paging, back at root, pick folder and file, read a `.txt` and a small PDF or HWPX fixture from `tests/fixtures` if one exists, ambiguous name asks, `.exe` refused with the sentence, zone-marked file asks, approval runs once, changed mtime is not opened, reject sentence.
`tests/e2e/test_desktop_session.py`: full session through `handle_turn` with FakeDesktopPort: "다운로드 폴더에 뭐 있어?" → APP_OPEN, page "app:explorer", accessMode "full"; "1번 읽어줘" reads; "더 읽어줘"; "뒤로 가줘"; "멈춰" mid-list; no file name anywhere in `export_history()` (or whatever the history accessor is); with desktop off the fixed sentence; "메모장 열어줘" gives the not-yet sentence and no web search; "신청서 파일 열어줘" on a zone-marked file asks, "진행해" opens once, after 2 minutes (inject the clock) it asks again; "거절" says the app reject sentence, not the mock-submit one.
E2E tests can run: the main checkout's server on :5174 serves identical files, and the plugin `.audit\desktop-vision\codemods\reuse_mock.py` lets this worktree reuse it: `PYTHONPATH=C:\Users\user\Desktop\voice-welfare\.audit\desktop-vision\codemods MOCK_SITE_WAIT_S=5 uv run pytest -p reuse_mock tests/e2e/<file>`. Run only the e2e files you touch plus `test_approval*`-style files that cover `_approve` and REJECT.

## Done when
Unit suite green, the parity diff equals the allowed list, the new e2e file passes, and the e2e approval and reject tests pass.
