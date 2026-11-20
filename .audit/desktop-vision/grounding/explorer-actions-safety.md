## Report: how actions are checked, approved, executed and verified, and where desktop actions would fit

### Components Found
- **Action contract**, `src/cheongeum/core/actions.py`
  - `ActionType` has 10 values: `navigate, back, click, fill, press, select, check, scroll, read, focus` (L16-17).
  - `Action` (L76): `id, type, target?, url?, value?` (at most 300 chars), `checked?, reason, risk` (`low|sensitive|consequential`), `requiresConfirmation`. It is a strict model with `extra="forbid"`. `url` must parse as a URL.
  - `ActionTarget` (L55): `ref, label, role, name, testId, fieldId, nth`. Its docstring says "좌표 클릭은 계약에 없다". A validator requires `role` and `name` whenever `ref` is set (L68-73). Sending `{"coords": …}` gives `DENIED_SCHEMA` (tests/unit/test_policy.py:50).
  - `ActionResult` (L95): `actionId, ok, verified, errorCode?, message?, readValue?, latencyMs`.
  - Error codes (L19): `TARGET_NOT_FOUND, AMBIGUOUS_TARGET, VERIFY_FAILED, TIMEOUT, ABORTED, NAVIGATION_FAILED, RESUBMIT_BLOCKED, NOT_SUPPORTED, UNKNOWN`. `LOG_FAILED` is not in that list; `agent.py` makes it up by hand at L532.
  - `Observation` (L185): `platform: Literal["pc"]`, `url` and `title` (both required), `fields`, `errors`, `dialogs`, `step?`, `status?`, `outline?` (whose `items` are `InteractiveItem{ref, role∈link|scriptlink|button|tab|menuitem|generic, name, region, disabled, selected?, expanded?}`), `capturedAt`.
  - `def parse_action(candidate: Any) -> dict | None:` and `def parse_observation(raw: dict) -> dict:`.
  - `class ExecutionAdapter(Protocol)` (L217): `platform`, `start`, `async def execute(self, action: dict, signal: AbortSignal | None = None) -> dict`, `async def observe(self) -> dict`, `close`, `bring_to_front`.
- **PolicyGuard**, `src/cheongeum/safety/guard.py`: the single gate. `def check(self, candidate: Any, ctx: PolicyContext) -> dict` returns `{"allowed", "code", "reason"}`.
- **PolicyConfig / PolicyContext**, same file (L14, L32). The context holds only `currentUrl, stopped, approvals, actionsThisTurn`.
- **ExecContext**, `src/cheongeum/agents/web/agent.py:38`: `signal, approvals: set, is_stopped, trace, counter`. `def granted(self, ids: list[str]) -> Iterator[None]` adds the ids and removes them in `finally`.
- **WebExecutionAgent**, agent.py:140: `__init__(self, adapter: Any, guard: PolicyGuard, profile: SiteProfile, action_log: Any = None)`. Every operation goes through `_run`.
- **WebOutcome**, agent.py:66: the status (`ok | needs-clarification | needs-approval | validation-error | policy-denied | failed | aborted | unconfirmed`) plus `pending`, `effect`, `focused`, etc.
- **Approval fingerprint**, `src/cheongeum/agents/web/approval.py`: `fingerprint(view, actions, speech, field_ids=None)` and `recheck(asked, view, actions) -> tuple[dict, str | None]`.
- **DialogueState approval slot**, `src/cheongeum/core/dialogue.py:47-57, 116-129`: `ask_approval` stamps the time from an injected clock; `approval_age` reads it.
- **PlaywrightExecutionAdapter**, `src/cheongeum/agents/web/browser/__init__.py:104`: the only adapter.
- **SiteProfile**, `src/cheongeum/agents/web/profile.py:71`. It holds `origin`, urls (home/apply/login), link names, button names (next/prev/submit/dismiss), `receipt_pattern`, `fields: list[FieldProfile]` (id, label, step, kind, sensitivity, aliases, validator), and `classify(url) -> PageId`.
- **ActionLog**, `src/cheongeum/personal/action_log.py`: an append-only, hash-chained, sealed log kept for 30 days.

### Flow
1. **Turn setup.** `SessionOrchestrator._begin_turn` (session.py:328) builds an `ExecContext`. The approvals set is shared across turns (`self._approvals`). `is_stopped` is true when the turn's epoch is stale or the state is STOPPED. `_stop` bumps the epoch, aborts the controller, and clears approvals and all dialogue waits (L275-286).
2. **A skill builds an action.** Example: `follow_link(name, ctx)` (agent.py:190) calls `observe`, then `_locate` matches the name against `outline.items` (links first; several matches means it asks back), then `_action(type="click", target={ref, role, name})`. `_action` defaults are `risk="low"`, `requiresConfirmation=False` (L496).
3. **Execution: `async def _run(self, action: dict, ctx: ExecContext, log: list[dict]) -> dict | None:`** (L499).
   - It calls `guard.check` with `currentUrl=_last_view.url`.
   - It appends `{agent, action, policy}` to `log`. If the action is not allowed it returns `None`.
   - It writes a "before" row to the action log. If that write fails and the action needed approval, it returns `LOG_FAILED` without executing.
   - It increments the action counter, calls `adapter.execute`, and retries once on `TIMEOUT`, but only when `risk == "low"` and the policy code is not `APPROVED` (L538).
   - It writes an "after" row with `ok`.
4. **Inside `check`** (guard.py:103), in this order:
   - schema → stopped → rate limit (12 per turn in runtime.py:267) → action type allowlist.
   - The tier comes from the **URL only**: `tier_of(action.url if navigate else ctx.currentUrl)` (L116).
     - origin in `allowedOrigins` (profile origin plus `extraAllowedOrigins`) → `full`
     - http(s) and `readOnlyWeb` → `read-only`
     - anything else → `none` (`DENIED_ORIGIN`)
   - **full**: input actions need an allowlisted `fieldId` and no secret label or value. Approval is required when `risk != low`, or `requiresConfirmation`, or the action is a click on a `role=="button"` whose name matches `RISKY_BUTTON` and is not in `safeButtons`.
   - **read-only** (`_check_read_only`, L148): inputs only into a `searchbox`, or `sensitive` + confirmation + approved. Any `risk != low` is **denied outright** rather than asked (L169). A button or link whose name matches `LOGIN_NAME` returns `NEEDS_CONFIRMATION`. Under `readOnlyClicks=="safe"`, tabs and script links pass the `is_action_name` filter, buttons and menu items pass the `RISKY_BUTTON` filter, and roles other than `link` are refused.
5. **Adapter `execute`** (browser/__init__.py:260) calls `_perform`. For a `ref` target, `_resolve_ref` (L516) re-runs `observe.js`, finds the item by ref, and raises `VERIFY_FAILED` if role or name changed. It then locates `[data-cheongeum-ref=…]` and raises `AMBIGUOUS_TARGET` unless exactly one match. With the visual cursor on, it re-resolves after the cursor animation. Playwright timeouts become `TIMEOUT`.
6. **Verification after execution.**
   - `_await_effect` / `diff_views` decide whether the click moved the page, changed it, or did nothing.
   - `fill`/`assist_fill` read the field values back.
   - `submit_approved` waits for the receipt pattern.
   - A timeout on an approved action with no visible change gives `status="unconfirmed"` (L290, L418, L838).
7. **When approval is needed.**
   - `_failed` turns `NEEDS_CONFIRMATION` into `needs-approval` with `pending=action` (L564).
   - `point_at` (L243) moves focus to the target and returns the pending click without pressing.
   - `BrowseSkill.ask_click` (skills/browse.py:212) speaks a question built by code and stores `{kind:"click", action, url, then, confirmation, fingerprint: fingerprint(view, [action], question)}`.
   - The fingerprint holds, per action, `{type, role, name, now: (item found by ref, or fieldId), valueHash?}`, plus `page = origin+pathname`, watched fields as `{fieldId, label, valueHash}`, and `speech`. Body text and title are left out on purpose.
8. **The user says "눌러": `async def _approve(self, turn: Turn) -> dict:`** (session.py:1117).
   - It re-observes with `self.web.observe` and runs `recheck`. If anything differs, it clears the approval and says what changed plus `NOT_DONE[kind]`.
   - If `approval_age >= APPROVAL_TTL_S` (120 s, L71), it asks again with a fresh fingerprint and timer.
   - Otherwise, inside `with turn.ctx.granted(ids)`, it dispatches on `kind`: `"click"` → `browse.click_approved`, `"assist"` → `form.assist_approved`, `None` → `form.submit_approved`.
9. **`_finish`** (session.py:587) records events from `a["action"]["type"]` and validates the turn with `parse_turn_result`. `ExecutedAction.action` is the strict `Action` model (turn.py:159), and `observation` and `accessMode` come from the web view.

### Files Read
- `src/cheongeum/core/actions.py`, `src/cheongeum/core/turn.py` (L90-359), `src/cheongeum/core/dialogue.py` (L1-135), `src/cheongeum/core/jsutil.py` (L90-174)
- `src/cheongeum/safety/guard.py`, `src/cheongeum/safety/__init__.py`, `src/cheongeum/safety/gates.py`
- `src/cheongeum/agents/web/agent.py`, `src/cheongeum/agents/web/approval.py`, `src/cheongeum/agents/web/profile.py`, `src/cheongeum/agents/web/browser/__init__.py` (plus the uncommitted diff)
- `src/cheongeum/agents/web/skills/browse.py` (L150-290, L620-689)
- `src/cheongeum/orchestrator/session.py` (L255-344, L580-694, L1100-1247)
- `src/cheongeum/server/runtime.py` (L200-326)
- `src/cheongeum/personal/action_log.py`
- `tests/unit/test_layers.py`, `tests/unit/test_action_log_guard.py`, `tests/unit/test_policy.py` (L1-60), `tests/e2e/test_safety.py` (L300-359), plus greps of `tests/conftest.py`, `tests/unit/test_approval.py` and `src/cheongeum/agents/web/browser/observe.js`

### Boundaries
- **Input to the gate:** an action dict plus `PolicyContext`. **Output:** a decision dict, then an `ActionResult` dict, then a `WebOutcome`, then a skill draft, then a `TurnResult`.
- **Wiring:** `server/runtime.py:250` `create_session` builds the adapter, the `PolicyConfig` (derived from `SiteProfile` fields and buttons), `ActionLog` and `WebExecutionAgent`, all passed in through `OrchestratorDeps.web`.
- **Import layers** (test_layers.py:12): `agents.web` may import only `core, safety, speech.phrasing`. A new `src/cheongeum/agents/desktop/...` maps to layer `"agents.desktop"`, and a top-level `desktop/` maps to `"desktop"`. Either fails with "새 단계 …를 ALLOWED 표에 넣어 주세요" until it is added to `ALLOWED`. It also has to be added to the `orchestrator` and `server` sets. A `skills` subfolder gets special treatment only under `agents/web`.
- **Test fakes:** there is no reusable fake adapter. The `ExecutionAdapter` Protocol is unused as a type (`adapter: Any`). Unit tests use ad-hoc classes such as `_FakeAdapter` with only `execute` (test_action_log_guard.py:17). E2E tests use real Playwright and monkeypatch `s.web.adapter.execute` (test_safety.py:325).

### Assumes "the target is a web page with a URL"
- `Platform = Literal["pc"]`, and `Observation.url` is required.
- `tier_of` reads only the URL origin. A pseudo-scheme like `uia://explorer` parses, but its `origin` is `"null"` (jsutil.py:110), so it falls to tier `none` and is denied with `DENIED_ORIGIN`.
- `approval._page` (origin+pathname), `observe()`'s `pageId = profile.classify(url)`, the action log's `host`, `ask_click`'s spoken site and title, `TurnResult.accessMode`, and the adapter's request router all read the URL.
- `ItemRole` has no UIA-like roles (list item, tree item, edit, window).
- `_approve` always re-observes through `self.web`, and `NOT_DONE` has only three keys.

### Non-Obvious Things
- The full tier gates only **buttons** by name. A link named "신청" is low-risk there.
- On the read-only tier, raising risk means **denied**, not "asked". Login gets approval only because `point_at` sends it as `risk=low` and `LOGIN_NAME` forces the question.
- Adding `"null"` to `allowedOrigins` would make every non-http URL tier `full`. That is a trap for a pseudo-scheme design.
- The action log's `host` comes from the view **before** the action, so a navigate row shows the old host.
- `_run` retries depend on the policy code (`APPROVED`), not on `requiresConfirmation`. Approved login clicks are never retried.
- The fingerprint deliberately ignores title and body text, so rotating banners and clocks do not cancel an approval. A desktop window title that changes constantly would need the same care.
- `TurnResult.actions` validates against the strict `Action` model. New action types must be added to `ActionType`, or the turn fails at `_finish` (the RECOVERING path).
- Peer work in progress: browser/__init__.py and cursor.js are modified but uncommitted (cursor `__MODE__` replaces `__RIPPLE__`). CLAUDE.md still describes `__RIPPLE__`.

### Where desktop actions would plug in
- **Contract:** either reuse `click`/`focus`/`read` with `target{ref=UIA RuntimeId, role=ControlType, name=Name}`, since the contract already forbids coordinates, or add new types (`launch`, `switch_window`, `open_file`) to `ActionType`.
- **Adapter:** a new adapter implementing the `ExecutionAdapter` methods, with a re-check before click equivalent to `_resolve_ref`.
- **Guard:** a new tier source. `PolicyContext` needs something like an app or window identity beyond `currentUrl`, plus an allowlist of apps and paths in `PolicyConfig`.
- **Approvals:** a new `kind` in `_approve`/`NOT_DONE`, and `fingerprint._page` keyed on the app or window.
- **Layers:** a new entry in the `ALLOWED` table.

### Open Questions
- I did not read `form.py`'s `assist`/`prepare_submit` approval construction in detail, or `autopilot.py`'s step dispatch beyond confirming it calls `self.web.*`.
- I did not trace `_route`, which picks between skills, or the `core/intents.py` registry where a desktop intent would be added (`test_registry` requires every intent to have a route).
- I did not check whether `server/app.py` exposes any adapter-specific endpoints.
