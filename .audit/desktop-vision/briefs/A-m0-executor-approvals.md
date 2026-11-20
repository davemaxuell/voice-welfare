# Brief A: Milestone 0, units U1 and U2 (behavior-preserving refactors)

Worktree: `C:\Users\user\Desktop\voice-welfare-desktop` (branch feat/desktop-vision). U0 is already applied there:
`ExecContext` and `OutcomeStatus` now live in `src/cheongeum/core/execctx.py`. Unit suite before you start: 692 passed, 10 skipped.

These two units touch the most safety-critical code (`_run`, `_approve`). They must change no behavior. Every spoken sentence stays byte-identical.

## Files you may touch
`src/cheongeum/safety/executor.py` (new), `src/cheongeum/agents/web/agent.py`, `src/cheongeum/orchestrator/approvals.py` (new),
`src/cheongeum/orchestrator/session.py`, `src/cheongeum/agents/web/skills/form.py`, `browse.py`, `guided.py` (only where approvals are asked or rejected),
`tests/unit/test_executor.py` (new), `tests/unit/test_approvals_table.py` (new), `tests/unit/test_layers.py` if needed.
Do NOT touch `core/turn.py`, `core/actions.py`, `safety/guard.py`, `agents/web/browser/`, `understanding/`, `core/intents.py` (other delegates own them).

## U1. One guarded run path: `safety/executor.py`
Move the body of `WebExecutionAgent._run` (agents/web/agent.py, the method after `_action`) into a class both the web agent and a future desktop agent use.
Sketch: `.audit\desktop-vision\arena\candidate-3\sketch\src\cheongeum\safety\executor.py`. Data shape:

```python
@dataclass(frozen=True)
class Subject:            # what the guard and the action log need to know about where the action lands
    current_url: str | None   # web: last view url (guard tier source). desktop later: None
    host: str                 # action-log host column (web: hostname of current_url)
    page_kind: str            # action-log pageKind column (web: view pageId)

class GuardedExecutor:
    def __init__(self, *, agent_id, guard, adapter, action_log, subject: Callable[[], Subject], before_effect: Callable[[], None] | None = None): ...
    async def run(self, action: dict, ctx: ExecContext, log: list[dict], effect: Callable[[], Awaitable[dict]] | None = None) -> dict | None: ...
```
- Order stays exactly: trace POLICY_CHECK, guard.check with the same PolicyContext fields, append `{"agent", "action", "policy"}` entry, return None if denied,
  "before" action-log row (failure on an action with requiresConfirmation or policy code APPROVED returns LOG_FAILED without executing; otherwise ignored),
  counter += 1, before_effect(), trace EXECUTING, effect (default `adapter.execute(action, ctx.signal)`), retry only low-risk unapproved TIMEOUT up to MAX_TIMEOUT_RETRIES while not aborted,
  entry["result"], "after" row (failure ignored), return result.
- `effect` lets a later caller (picture capture) produce a result through the same guard and log. When given, it replaces `adapter.execute` for the first call and every retry.
- `_action_label` and `_host_of` move with it if only the executor uses them; keep `MAX_TIMEOUT_RETRIES` importable where tests use it.
- `WebExecutionAgent._run` becomes a one-line delegate (or callers call the executor directly; pick the one with fewer layers and say which).
- `_acted_since_observe = True` happens through `before_effect`.
- Layer: `safety` may import only `core`. The executor must not import `personal` (the action log object is injected).

Proof: `tests/unit/test_executor.py`, a parity table driven through a real `PolicyGuard` (build it the way existing unit tests do), a fake adapter that records calls and returns scripted results, and a fake action log that can be told to raise.
Cases: low unapproved TIMEOUT retried once; APPROVED action TIMEOUT not retried; non-low risk not retried; before-row failure on an approved or requiresConfirmation action gives LOG_FAILED and the adapter is never called; before-row failure on a plain low action still executes; denied gives None, the entry holds the policy, the adapter is not called, the counter is unchanged; counter increments; before and after rows carry host, pageKind, actionType, label, approvalId, phase and ok; an aborted signal is denied by the guard; before_effect runs once before the effect; an `effect` override is used and logged the same way.
The existing `tests/unit/test_action_log_guard.py`, `test_policy.py`, `test_safety*` must pass with no edits.

## U2. Approvals table: `orchestrator/approvals.py`
Today the facts about each approval kind are spread out: `NOT_DONE` (session.py, three keys; a new kind raises KeyError), the `if` branches in `_approve` that run each kind, the semantic action used when the 2-minute TTL re-asks, and `FormSkill.reject` (form.py), which says the mock-submit sentence for any kind it does not know.
Collect them in one table keyed by `kind` (`None` is the mock submit, `"click"`, `"assist"`; read every `ask_approval(` call site to find the real kinds):

```python
@dataclass(frozen=True)
class ApprovalKind:
    world: Literal["web", "app"]      # which world _approve re-observes ("app" arrives in a later unit; only "web" rows now)
    not_done: str                     # sentence when the fingerprint changed ("누르지 않았어요." ...)
    semantic: str                     # semantic action used when the TTL re-asks (copy today's value per kind)
    run: Callable[[SessionOrchestrator, dict, Turn], Awaitable[dict]]   # runs inside ctx.granted(ids)
    reject: Callable[[SessionOrchestrator], dict]                       # state + speech when the user says 거절 (today's per-kind branch)
APPROVALS: dict[str | None, ApprovalKind]
```
Sketch with the rewrite shape: `.audit\desktop-vision\arena\candidate-3\sketch\src\cheongeum\orchestrator\approvals.py`.
- `_approve` reads the table. Delete `NOT_DONE` and the old branches in the same change (migrate callers, then delete).
- The REJECT route reads the table's `reject`. `FormSkill.reject` keeps only what is truly form-specific, or is replaced; say which. A missing approval keeps today's behavior.
- Use `TYPE_CHECKING` imports to avoid cycles; `approvals.py` is in the `orchestrator` layer.
- Structure test `tests/unit/test_approvals_table.py`: an AST scan of `src/` finds every `ask_approval(` call and the `kind` it stores (absent means None) and asserts each is a key of `APPROVALS`; a second test asserts the table's `not_done` and reject sentences equal today's literals (copy them into the test before you change the code).
- Existing approval behavior is covered by `tests/unit/test_approval.py` and e2e tests you cannot run now (port 5174). Read the e2e tests that exercise approve, reject, the TTL and fingerprint changes (`grep -rln "거절\|APPROVAL_TTL\|눌러" tests/e2e`) and make sure the sentences they assert are produced by identical code paths. List those e2e tests in your report so I can run them later.

## Done when
Unit suite green with the new tests, no existing test edited except `test_layers.py` if a new edge appears, `git diff` limited to the files above, and your report lists the e2e tests to run.
