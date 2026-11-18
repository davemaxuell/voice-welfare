# Navigating agent: implementation plan

Date: 2026-11-17. Based on `navigating agent - merged.md` in this folder.

## Status (2026-11-17, after the build)

Units 0 to 6 were built on branch `feat/navigation` in the worktree `C:\Users\user\Desktop\voice-welfare-nav`, started from commit `e844479`. Nothing is committed yet. Where the build departs from the plan below:

- **Guard.** You chose "allow everything for now". The new setting `READ_ONLY_CLICKS` defaults to `any`, which allows every click on read-only sites. `safe` is today's rule. Input rules are unchanged. The existing safety tests and `run_scenarios.py` run with `safe`.
- **The model keeps choosing by name.** No item numbers. The agent maps the name to an observed item and clicks by its ref. That drops one prompt change and keeps small models on the format they already use.
- **Legacy lists are kept as they were.** `items` is a separate list rather than the source of `links` and `buttons`.
- **The ref attribute is `data-cheongeum-ref`**, separate from the field IDs.
- **The ref re-check runs the observe script again** before the click, so there is one naming rule instead of two copies.
- **On 복지로, the detail-page tabs are `role="link"` anchors.** The active one is marked by "선택됨" in `title` and `aria-label`. The old observation missed these anchors. Items now read "선택됨" as selected, and a link stops waiting as soon as the selection moves. On the real page a tab click went from 6.2 s to about 1 s.
- **`rules.py` fix.** "신청방법 탭 눌러줘" was routed to the welfare question handler. A click word now wins, as it already did for "맞춤형 급여 안내 눌러줘".
- **The flaky baseline runs.** Likely two checkouts running pytest at once and sharing port 5174, so one run's mock site shut down under the other. This is inferred, not reproduced. Seen live: the other session's pytest held the port during this build.

## Goal

A blind user asks 청음 for something on a website, and the agent reaches it more often. The plan covers stages 0, 1, and 2 of the merged document in detail. Stages 3 (vision) and 4 (desktop apps) are outlined at the end and wait for decisions.

The work is ordered so that the cheapest change with the largest measured effect lands first, and every unit ends with a check that can be rerun.

## Baseline

- Test suite before any change: 283 passed in about 108 seconds (`uv run pytest`), measured on 2026-11-17. Three of five full runs were clean, including two run back to back. The other two runs failed 91 and 5 tests, all in `tests/e2e`. Their failure output was not captured and the cause is unknown. Two later attempts did not reproduce them. So the suite is flaky under some condition, and a red run during this plan is rerun alone, with output saved, before it counts as a regression.
- Probe results before any change: section 5 of the merged document.
- Goal-task results before any change: not run for this plan. `scripts/eval_agent.py` calls a paid model and real sites, so it runs only on your go.
- The repository has no commits yet. A baseline commit before unit 1 would let each unit be diffed and reverted on its own. That is your call. I do not commit unless asked.

## Assumptions to confirm

1. **This Python repository is now the lead.** `observe.js` was extracted from the TypeScript original, and CLAUDE.md says to match the original's behavior. This plan changes `observe.js` and the action contract here only. If the TypeScript repository must stay in step, each unit needs a twin change there.
2. **`src/cheongeum/evaluation/data/demo_scenarios.json` is not touched.** New checks go into pytest and `scripts/eval_agent.py`.
3. **The mock site may grow.** A new page is added. Existing pages are not edited, so current tests keep their meaning.

## Data shapes

Three additions carry the whole plan. Everything else is code that fills or reads them.

**1. An interactive item, reported by `observe.js`** (`src/cheongeum/core/actions.py`, new model `InteractiveItem`, new optional `ScreenOutline.items`):

| Key | Type | Meaning |
|---|---|---|
| `ref` | string | The `data-cheongeum-id` stamped on the element. Stable while the DOM node lives. |
| `role` | `link`, `button`, `tab`, `menuitem`, `generic` | `generic` is a clickable element with no role. |
| `name` | string | Visible text, then `aria-label`, then `title`, then `img alt`. |
| `region` | `main`, `menu`, `other` | Where it sits. Replaces deriving this from two separate lists. |
| `selected` | bool, optional | From `aria-selected` or `aria-current`. |
| `expanded` | bool, optional | From `aria-expanded`. |
| `disabled` | bool | |

The existing lists (`links`, `buttons`, `menuLinks`, `mainLinks`, `linkCount`) stay in the observation. `observe.js` derives them from `items` in the same pass, so the two cannot drift. Their consumers (`speech/screen.py:159`, `orchestrator/session.py:1978`) are not changed in this plan.

**2. A ref on the action target** (`ActionTarget.ref`, optional). An action that carries a ref still carries `role` and `name`, because `PolicyGuard` judges those.

**3. The effect of an action** (`WebOutcome.effect` and `WebOutcome.revealed`):

| `effect` | Meaning |
|---|---|
| `moved` | URL or title changed. |
| `changed` | Same page, but main text, dialogs, or the item's own state changed. `revealed` holds the newly shown text. |
| `none` | Nothing observable changed. |

## Units

Each unit lists the files, the change, and the check that proves it. A unit starts only after the previous one's check passes.

### Unit 0. Fixtures and failing checks

Purpose: turn each measured gap into a test that fails today.

| File | Change |
|---|---|
| `src/cheongeum/practice_site/site/portal2.html` (new), `site/src/portal2.js` (new) | A synthetic public portal built from the patterns measured on 복지로 and 건강보험. Contents below. |
| `tests/e2e/test_navigation.py` (new) | One scripted test per gap, using the `scripted` helper pattern from `tests/e2e/test_autopilot.py`. |
| `scripts/eval_agent.py` | New local tasks L4 to L8 and one real task R8 (복지로, reach 복지서비스). |

`portal2.html` contains:

- Twelve utility buttons first in DOM order (본문 바로가기, 글자 작게, 글자 크게, 로그인, language names), then menu entries built as `<a role="button">` without `href` (복지서비스, 서비스 찾기, 복지지도).
- Three anchors with `role="link"` and no `href`.
- Two links that contain only an image with alt text.
- A tab list with three tabs (지원대상, 서비스 내용, 신청방법). One is a `<button role="tab">`, one is an `<li role="tab">`. Each hidden panel holds a fact found nowhere else on the page.
- An expander (`aria-expanded="false"`) that reveals a fact.
- A clickable `<div>` with no role, which changes the page title when clicked. The agent must never click it.
- A tab named 온라인 신청하기 that changes the page title when clicked. The agent must never click it.
- An article longer than 6,000 characters with a fact in the last paragraph.

Check: `uv run pytest tests/e2e/test_navigation.py` runs and the new tests fail for the expected reason. All existing tests still pass.

### Unit 1. Rank what the model sees

Purpose: the 복지로 fix. No contract change.

| File | Change |
|---|---|
| `src/cheongeum/agents/web/digest.py` | Replace `d.buttons[:12]` (line 199). Drop utility buttons by name (font size, skip links, language switch, social, carousel controls). Share one item budget across content links, menu links, and buttons, so a page with 2 links and 40 buttons spends the budget on buttons. |
| `tests/unit/test_grounding.py` | A view shaped like the 복지로 home page. Assert the menu buttons are in `items` and the font-size buttons are not. |

Check: the unit test, the unit 0 menu test, and `uv run python "research results/probes/digest_check.py" https://www.bokjiro.go.kr` now lists 복지서비스 among the items sent.

### Unit 2. Recover names and raise caps

| File | Change |
|---|---|
| `src/cheongeum/agents/web/browser/observe.js` | `linkName` falls back to `img alt` (line 79). Anchors with `role="link"` and no `href` join the links. `mainText` cap 4,000 to 20,000 (line 112). Button cap 40 to 80 (line 133). |
| `src/cheongeum/agents/web/autopilot.py` | New action `find`. The target is a keyword. The step moves the text window to the first match in the full main text. Rule-based, no extra model call. `DECISION_SCHEMA` and the Korean system prompt gain the action. |
| `tests/e2e/test_navigation.py` | Image-only link is listed and clickable. `find` reaches the fact in the last paragraph. |

Check: those tests, plus `probe_gaps.py` shows zero dropped image-only links on 네이버 and 건강보험.

Note: `mainText` is compared on every settle poll (`agent.py:306`) and read by "본문 읽어줘". A longer text changes neither behavior, but the existing reading tests are the pin.

### Unit 3. Interactive items with refs, role, and state

Purpose: the model picks an element, not a retyped name. This is the largest unit.

| File | Change |
|---|---|
| `src/cheongeum/core/actions.py` | `InteractiveItem`, `ScreenOutline.items`, `ActionTarget.ref`. |
| `src/cheongeum/agents/web/browser/observe.js` | Build `items` in one pass and stamp `data-cheongeum-id` on each element, as `idOf` already does for fields (lines 10 to 14). Derive the legacy lists from `items`. Include `role="tab"`, `role="menuitem"`, and role-less elements with `cursor: pointer` and their own text. |
| `src/cheongeum/agents/web/browser/__init__.py` | `_resolve` accepts `ref`. Before acting, it re-reads the element's current role and name and compares them with the action's. A mismatch returns `VERIFY_FAILED` and nothing is clicked. |
| `src/cheongeum/agents/web/digest.py` | `PageDigest.items` as a ranked list. `digest_for_llm` emits `{n, kind, name}` plus `selected` or `expanded` when present. `n` is a short number for this page only. |
| `src/cheongeum/agents/web/agent.py` | New `activate(ref, ctx)`. `follow_link(name, ctx)` keeps its signature for the voice path and resolves the name to an item, then takes the same path. One code path builds the action. |
| `src/cheongeum/agents/web/autopilot.py` | A `click` target may be an item number. A name still works, so small models are not forced onto numbers. History lines record the name, not the number. |
| `tests/unit/test_parser.py`, `tests/e2e/test_navigation.py` | Contract tests for the new keys. A click by number reaches the right one of two same-named items. A changed name between observe and click is refused. |

Why the adapter re-checks role and name: today a click by role and name can only land on an element that has that role and name at click time. A ref alone would lose that guarantee, and the guard's decision would be about a name the element no longer has.

Cost of finding role-less clickable elements: a `getComputedStyle` scan of every element took 12 to 16 ms (median of five) on pages with 2,000 to 3,800 elements, against 21 to 97 ms for today's whole observation. `observe.js` runs every 100 ms while the agent waits for a page, so this is acceptable. The raw scan matched 357 elements on 복지로 because children inherit the cursor. Only the outermost element with its own text is kept, which left 9 on that page, and the list is capped at 20.

Role-less clickable elements get `role: "generic"`. The agent builds the action like any other and `PolicyGuard` denies it. There is no special case outside the guard.

Check: the new tests, and every existing test unchanged. `test_llm_gets_digested_page` (same-named links listed once) must still pass, so same-name de-duplication for the model stays as it is.

### Unit 4. Report what the action did

| File | Change |
|---|---|
| `src/cheongeum/agents/web/effect.py` (new) | A pure function `diff_views(before, after, ref)` that returns the effect and the revealed text. Unit-testable without a browser. |
| `src/cheongeum/agents/web/agent.py` | `follow_link` and `activate` wait until the effect is not `none`. The timeout is 1.5 seconds for tabs and items that carry `expanded`, and 6 seconds for links as today. `WebOutcome` gains `effect` and `revealed`. |
| `src/cheongeum/agents/web/autopilot.py` | Step notes become "'제목' 열림", "같은 화면에서 바뀜: …", or "화면이 바뀌지 않음". A step with effect `none` counts as failed, so the existing repeat rule stops loops. After `changed`, the text window starts at the revealed text. |
| `src/cheongeum/orchestrator/session.py` | `_follow_link` (line 1859) stops saying "링크를 열었습니다" when nothing changed. For `changed` it says the tab or section opened and reads the start of the revealed text. |
| `tests/unit/test_effect.py` (new), `tests/e2e/test_navigation.py`, `tests/e2e/test_browsing.py` | The three effects. The tab test asserts the answer comes from the revealed panel. |

Check: the tests above, and the tab step in a trace completes in under 2 seconds on the mock page. Today the code path waits 6 seconds.

### Unit 5. Guard rule for tabs

| File | Change |
|---|---|
| `src/cheongeum/safety/guard.py` | In `_check_read_only` (lines 142 to 148), `role == "tab"` is allowed when the name passes the risk rule. `generic` and `menuitem` stay denied. |
| `tests/unit/test_parser.py` | New rows in the `test_read_only_policy` table (line 202), where the read-only guard cases live. Tab allowed. Risky-named tab denied. `generic` denied. `menuitem` denied. |
| `tests/e2e/test_navigation.py` | The role-less `<div>` and the 온라인 신청하기 tab are never clicked. The page title proves it. |

Expanders need no rule of their own. In the probe, all but one of the expanders were links or buttons, and those already pass or fail under the existing rules.

This unit has an open question. See decision 1 below.

### Unit 6. Measure again and document

1. `uv run pytest`, then `uv run python scripts/run_scenarios.py`. The scenario report must not regress.
2. Rerun the three probes and record the same table as section 5 of the merged document.
3. On your go, run `scripts/eval_agent.py` before and after, and put both result sets in the report. Its existing meter reports input characters per model call. The target is no more than 10% above today's average.
4. Update the Architecture section of `CLAUDE.md` for the new contract keys, `effect.py`, and the new autopilot actions.

## Decisions needed

1. **The 신청방법 tab.** You chose tabs under the same risky-name rule as buttons. `RISKY_BUTTON` matches any name that contains 신청 (`guard.py:50`). The reading order in the planning summary is 지원대상, 서비스 내용, 신청방법, so the third tab would be blocked. Recommendation: for tabs only, require that the tab is structurally real (inside a tab list, or carrying `aria-controls` or `aria-selected`) and block names that are actions (they end in 하기, or are a bare action word such as 제출, 결제, 로그인). 신청방법 and 신청 안내 pass. 신청하기 does not. The alternative is to keep the rule exactly as it is and accept that 신청방법 is unreachable by click.
2. **The baseline commit**, described under Baseline.
3. **The eval run**, described under Baseline. It costs model calls.

## Risks

| Risk | Handling |
|---|---|
| A small local model handles numbered items worse than names. | Names stay accepted. The eval compares both models before and after. |
| Stamping `data-cheongeum-id` on many elements, and a framework re-render dropping it. | Fields are already stamped this way. Every action re-observes first, so a dropped ref falls back to the name. |
| More text per model call. | Measured in unit 6 against the 10% target. |
| The mock page does not behave like the real sites. | The probes and the real eval tasks cover the real sites. The mock page only pins behavior. |
| Divergence from the TypeScript original. | Assumption 1. |
| The test suite failed on two of five baseline runs for an unknown reason. | Save output on every run. Rerun a red run alone before treating it as a regression. If it recurs with output, fix it before continuing. |

## Out of this plan

- **Iframes and shadow DOM.** The probe found no content case that justifies them yet.
- **Hidden text in `mainText`.** `observe.js:110` may include text from `display:none` elements. It can help answers and it can read out things a sighted user does not see. Decide after unit 6 with numbers.
- **`scroll` for lazy-loaded lists.** No measured case. Add it when an eval task needs it.
- **Clicking `menuitem` elements.** Not covered by the guard decision.
- **Migrating `speech/screen.py` and the link listing in `session.py` to `items`, then deleting the legacy lists.** A cleanup for after this plan.

## Later stages

**Stage 3, vision as a fallback reader.** Starts after unit 6 shows which failures remain. It needs your answer on where screenshots may go. The refs from unit 3 are what the numbered marks are drawn from, so nothing in this plan has to be redone. Touch points: `core/llm.py` (image part in `generate`), the adapter (masked screenshot), a trigger rule in `digest.py`, and a label in `verify.py` for answers read from an image.

**Stage 4, desktop apps.** A prototype only, on one app you name. It needs a design for an app allowlist in `PolicyGuard` before any code, because the guard tiers by URL origin today.
