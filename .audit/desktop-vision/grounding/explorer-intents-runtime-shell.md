## Report: understanding, orchestration, runtime assembly, desktop shell

### Components Found
- **`INTENTS`**, `core/intents.py:76-211`: the intent table, one `_row(type_, describe, help, examples, *, llm=True, before_consent=False, **params)` per intent. It has 37 rows, and `tests/unit/test_registry.py` hard-codes `== 37`. Four things are derived from it: the intent models, the LLM enum and prompt, the consent allow-list and the help text.
- **`parse_intent(candidate)`**, `core/turn.py:127`: a discriminated union built from `INTENTS` (line 121).
- **`SEMANTIC_ACTIONS` + `SemanticAction`**, `turn.py:166` and `turn.py:208`: one closed set written out twice by hand.
- **`draft(state, semantic, speech, **extra)`**, `turn.py:361`: the return type of every skill. It is a plain dict, and `None` extras are dropped.
- **`RuleBasedIntentProvider.parse_sync`**, `understanding/rules.py:152`: an ordered if-chain, so the first match wins.
- **`flat_to_intent(flat, utterance)`**, `llm_planner.py:54`: maps the fixed flat slots (`fills, fieldMention, topic, text, more, site, list`, lines 25-51) to params with one hand-written branch per type. The LLM can produce every type except APPROVE, STOP and PROGRESS (line 21).
- **`Understanding.understand`**, `understanding/understand.py:51`: rule split, then rule parse, then `plan_with_llm`.
- **`KnownSite` / `KNOWN_SITES` / `resolve_site(target, extra=())`**, `understanding/sites.py:13,22,152`: name aliases → URL, a one-letter fuzzy match for 3+ Hangul characters (`near_site`), and a spoken-domain fallback. This is the natural model for an app-name → app table.
- **`OrchestratorDeps`**, `orchestrator/session.py:43-65`: a dataclass holding `intent_provider, web, welfare, llm, goal_llm, web_llm, personal, action_log, clock, …`.
- **`ROUTES: dict[str, Route]`**, `session.py:1210-1248`, with `Route = Callable[[SessionOrchestrator, dict, Turn], Awaitable[dict]]`.
- **`BrowseSkill`**, `agents/web/skills/browse.py:65`. Its constructor is `(web, dialogue, narrator, form, deps, progress, official_text)`. Methods are `async def x(self, …, ctx: ExecContext) -> dict`, and the dict comes from `draft()`. Web results arrive as `WebOutcome` (`agent.py:67`) and are converted using `outcome_failure` and `ask_again` from `common.py`.
- **`Progress`**, `core/progress.py`: one per session. Only `run_goal` writes to it (`browse.py:612-623`). `_progress_draft` and `GET /api/session/{id}/progress` read it.
- **`AgentRuntime`**, `server/runtime.py:188`. **`load_config`** is at `:109`, and **`create_test_runtime`** is at `tests/conftest.py:29`.
- **`ExecutionAdapter` Protocol**, `core/actions.py:217`. `ActionTarget` (`:55`) carries the comment "좌표 클릭은 계약에 없다" (no coordinate clicks). `ActionType` is a web-only Literal (`:17`), and `Platform = Literal["pc"]`.
- **`DownloadStore`**, `agents/web/downloads.py`.
- **Layer table `ALLOWED`**, `tests/unit/test_layers.py:12`.

### Flow
1. `handle_turn` (`session.py:185`) normalizes to NFC, then runs `detect_sensitive` and `redact_text`. A stop goes to `_stop` and skips the queue. It then strips the wake word ('청음아'). A progress question goes to `_progress_reply` and also skips the queue. Everything else goes through `_enqueue(_process)`.
2. `_process` (`:352`) handles language switching and translation, then calls `_process_korean` (`:494`). Before understanding, that function runs these checks in order: secret, spoken secret, profile answer, vault confirmation, guided fill, personal commands, short reply, `strip_filler`, `_answer_many`, `vague_question`.
3. `_understand` (`:709`) calls `Understanding.understand`, which returns `Understood(intents, by)`.
4. `_gate` (`:481`) is the consent-and-stop gate. Then either `_run_plan` (`:723`) runs, looping `_route` and stopping on `PLAN_STOP_STATES`, or `_route` (`:829`) runs directly. `_route` handles clarification picks, picks from the welfare match list, `_consent_gate`, then `ROUTES[type](self, intent, turn)`, falling back to `_unknown`.
5. The skill returns a draft. `_finish` (`:587`) commits the state, appends history, records events, and runs `parse_turn_result`. Note that it always takes `page`, `observation` and `accessMode` from `self.web.current_view`.
6. Approval: a skill calls `dialogue.ask_approval({kind, action, fingerprint…})`. On '눌러', `_approve` (`:1117`) re-observes the **browser**, runs `recheck(fingerprint, view, actions)` and checks `APPROVAL_TTL_S=120`. It then dispatches on `kind` ∈ {`click`, `assist`, None=submit} inside `with turn.ctx.granted(ids):`.

### Adding one intent end to end today (hand-edited lists)
1. Add a `_row` in `intents.py`. It needs at least 2 examples that the rules parse in the given state, and the first example must parse on IDLE, BROWSING and APPLICATION_OPEN, because the help text reads it.
2. Add a branch in `rules.py parse_sync`. Its position in the chain matters.
3. Add a `ROUTES` entry plus its handler in `session.py`.
4. If the intent has a new parameter, add a branch in `flat_to_intent`. If the parameter fits no flat slot, also extend `INTENT_JSON_SCHEMA` `required` and `properties`, and the test's `TOPIC_PARAMS` and `to_flat`.
5. Add any new semantic action to both `SEMANTIC_ACTIONS` and `SemanticAction`. A new state needs `SESSION_STATES`, the `SessionState` Literal and `STATE_LABELS_KO`.
6. Update the 37 count in `test_registry`, and update its `ALLOWED_WITHOUT_CONSENT` literal if `before_consent=True`.
7. For a new package such as `agents/desktop`: add it to the `test_layers.ALLOWED` table, add a field to `OrchestratorDeps`, wire it in `AgentRuntime.create_session` (`runtime.py:289`), and construct the skill in `SessionOrchestrator.__init__`.
8. Desktop actions placed in `draft["actions"]` would fail `parse_turn_result`. The reason is that `ExecutedAction.action: Action` accepts only web `ActionType`.
9. For scenario coverage, add steps to `src/cheongeum/evaluation/data/scenarios_30.json`. `demo_scenarios.json` must not be modified. Each step has the shape `{utterance, expect:{state, action(=semanticAction), page, accessMode,…}}`. `check_expectations` (`evaluation/__init__.py:108`) fails on any key it does not know.

### Runtime and shell
- **Per process:** profile, welfare provider, intent provider, three role LLMs (`LLM_UNDERSTAND|GOAL|WEB_*`), STT/TTS, PII model, one shared browser (`_get_browser`) or one Chrome persistent context (`_get_chrome`), and the personal store and action log (sealed when `dataDir` is set).
- **Per session:** a `PlaywrightExecutionAdapter` with its own context (chromium) or its own tab (chrome), a `PolicyGuard` and a `DownloadStore`.
- **Browser:** `BROWSER_MODE` defaults to `chromium`, meaning the bundled Chromium with a new context per session. It runs headed unless `HEADLESS=true|1`. `BROWSER_MODE=chrome` uses the installed Chrome via `channel="chrome"` with a persistent profile at `~/.cheongeum/chrome-profile`, always headed. `build(desktop=True)` (`__main__.py:28`) sets only `PRACTICE_MODE=false` and `CHEONGEUM_DATA_DIR=~/.cheongeum`, so the browser mode comes from `.env`.
- **`--desktop` mode:** a self-only CSP, port 8790, and `_exit_when_parent_closes`, which exits when stdin closes.
- **Electron (`main.cjs`):**
  - Spawns python, trying `CHEONGEUM_PYTHON`, then `.venv`, then `uv run`, and polls `/api/health`.
  - Hidden window plus tray by default (`CHEONGEUM_SHOW_WINDOW=1` shows it).
  - Mic permission is granted only to its own origin, and autoplay is allowed.
  - One global shortcut, `CommandOrControl+Shift+Space`, sends IPC `cheongeum:talk`.
  - http(s) window-opens go to `shell.openExternal`.
  - `preload.cjs` exposes only `{isDesktop, onTalk}`. There is no renderer→main IPC, no file dialogs, and no app launching.
- **Python side:** `src` has no `subprocess`, `ctypes` or `os.startfile`. There is no pywinauto, uiautomation, comtypes or pywin32. Only `pywin32-ctypes` (from keyring) and `onnxruntime` (from faster-whisper) are present.
- **Platform targets:** `requires-python >=3.12`, with no platform classifiers. electron-builder targets Windows NSIS x64 and macOS dmg (unsigned).
- **Downloads:** `DownloadStore(folder)` uses `~/.cheongeum/downloads` on desktop. The server and tests pass `None`, so files stay at the Playwright temp path. It keeps an **in-memory per-session list** (`_files`), not a directory scan, so it is not the Windows Downloads folder. It is filled by `adapter._save_download` and read by `READ_DOWNLOAD`.

### Boundaries
- **Inputs:** text from `/api/turn` and `/api/audio/turn` reaches `handle_turn`, and UI buttons reach `confirm`, `cancel` and `consent_to`.
- **Outputs:** the TurnResult dict, plus progress and reminders over REST.
- **Skills** reach the browser only through `WebExecutionAgent` (PolicyGuard → adapter → re-observe).
- **LLM:** `OpenAIStructuredLlm.generate(*, system, user: str, schemaName, schema, signal=None)` (`core/llm.py:98`) is text only, with no image content parts.

### Non-Obvious Things
- How today's rules parse the proposed utterances (probed with the real parser):
  - "바탕화면에 뭐 있어?" → `DESCRIBE_SCREEN`, because `화면에\s*뭐` matches inside 바탕화면.
  - "다운로드 폴더에 뭐 있어?" → `READ_DOWNLOAD{list:true}`.
  - "다운로드 폴더 열어줘", "메모장 열어줘", "지금 창 읽어줘", "파일 탐색기 열어줘", "이 창 뭐야?", "계산기 켜줘" → all `UNKNOWN`.
- With an LLM configured, `UNKNOWN` goes to `plan_with_llm`, which may pick `OPEN_SITE` or `GOAL`. `resolve_site` then fails and it **searches "메모장 홈페이지" on Naver**.
- `DESCRIBE_SCREEN` means the browser page (`browse.screen` → `web.observe`). On a blank page it answers with `not_open`'s "입력할 신청서가 없어요".
- Rule order and the help-example tests mean any new rule must not swallow existing examples on any of the three screens.
- `_approve`, `NOT_DONE` (`:73`) and `recheck` all assume a web view. A desktop approval kind needs its own branch and its own fingerprint.
- New intents default to `before_consent=False`, so they wait for consent. That fits screenshots.
- A stop aborts `ctx.signal` and bumps the epoch. New skills must respect `ctx.signal` and `ctx.is_stopped`.

### Files Read
`CLAUDE.md`, `core/{intents,turn,progress,llm(78-142),actions(1-80,185-230)}.py`, `understanding/{rules,llm_planner,understand,sites,filters(grep)}.py`, `orchestrator/session.py` (full), `agents/web/skills/{browse(1-660),common}.py`, `agents/web/{agent(37-175),downloads,approval(grep)}.py`, `agents/web/browser/__init__.py` (1-260, 560-633), `speech/screen.py` (196-260), `safety/gates.py`, `server/{runtime,__main__,app(parts)}.py`, `apps/desktop/{main.cjs,preload.cjs,package.json,electron-builder.yml}`, `pyproject.toml`, `uv.lock` (grep), `tests/conftest.py`, `tests/unit/{test_registry,test_layers}.py`, `scripts/run_scenarios.py` (1-98), `evaluation/__init__.py` (grep), the scenario JSONs (sampled), `README.md` (env table), `.audit/desktop-vision.todo.md`.

### Open Questions
- I did not read `.env`, and there is no `.env.example`, so the actual `BROWSER_MODE` and `HEADLESS` in desktop use are unknown.
- I did not check whether `scripts/package-desktop`, which `docs/install.md` mentions, exists.
- I did not trace `DialogueState.ask_approval` / `commit` internals beyond their call sites.
- I ran one read-only `python -I` probe that imported the package to test the rules parser. It may have refreshed `__pycache__` .pyc files. No source files were touched.
