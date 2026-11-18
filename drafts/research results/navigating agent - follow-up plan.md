# Navigating agent: follow-up plan for the open problems

Date: 2026-11-18. Follows `navigating agent - implementation plan.md`. Covers what the pre-commit check left open on branch `feat/navigation` (worktree `C:\Users\user\Desktop\voice-welfare-nav`).

## Status (2026-11-18, after the build)

Built in the worktree, not committed: units A, B, C and E. Unit D was measured and stopped by its own rule (below). Unit F was skipped. Final run: 346 tests passed, 35 of 35 scenarios, 0 read-only violations, 0 secret leaks, lint clean. Per-unit patches are in the worktree under `.audit/patches/` (`unitB.diff`, `unitC.diff`, `unitE.diff`), and `.audit/snapshots.txt` lists one snapshot commit per unit. These are not on any branch.

- **A.** Built as planned. A new unit test starts a foreign server on a free port and shows that the run waits, then takes the port once that server stops.
- **B.** Built. A new test page tab shows "불러오는 중…" for 1.5 s, and the agent reads the real content. The real 복지로 tab clicks took 0.5 s and 0.9 s.
- **C.** Changed from the text-based design. The agent learns spots (the line just before a change), not texts, so a notice that cycles through more than two messages is also ignored. Learning happens only between two looks at least 1 s apart with no action in between. The first version learned inside the click and never fired. The new test caught that with exactly the predicted wrong reply.
- **D.** Visible-only text was stopped by the plan's own rule, then built as the alternative (see below). Useful content would disappear from the default text (measured on 2026-11-18, eight sites):

  | Site | Characters now | Visible only | What drops |
  |---|---|---|---|
  | 복지로 home | 868 | 461 | Hidden menus, popular search words |
  | 복지로 detail | 996 | 951 | 7 menu lines |
  | 건강보험 | 4,064 | 2,257 | Hidden menus |
  | 네이버 | 2,656 | 2,573 | 5 lines |
  | 네이버 뉴스 | 20,000 | 17,130 | Headlines in tabs that are not shown |
  | 보건복지부 | 2,789 | 937 | The notice list and news in tabs that are not shown. The tab buttons carry `aria-expanded`, so a switch ends in under 1 s (checked on the live site after the build). An earlier note here said 6 s, which was wrong |
  | 국민연금 | 739 | 389 | Language list |
  | 홈택스 | 519 | 225 | Hidden menus |

  The observation time was unchanged (median of five).

  **Built as option 2 (user's choice, 2026-11-18).** The full text (`mainText`) stays as it is for reading and answering. A second copy, `outline.visibleText`, is used only to judge what a click changed (`effect._lines`).
  - **Hidden means:** `checkVisibility()` is false (display:none, closed `<details>` except its summary), or the text sits in a `visibility:hidden` element. 보건복지부 hides inactive tab lists with `visibility:hidden` plus zero height and opacity, so the visibility rule is required. A version without it broke that site.
  - **Proofs:** with the old comparison, the new tests fail with the reported wrong replies ("같은 화면에서 내용이 바뀌었어요", "바뀌지 않았어요"). Without the visibility rule or the `<details>` rule, the matching tests fail too.
  - **Real sites:** 보건복지부 공지사항 and 보도자료 each read their list (0.9 s, 0.8 s). 복지로 신청방법 reads its panel, and going back to 지원대상 now reads that panel too (0.6 s, 0.5 s). An earlier note in the table said 보건복지부 tabs take 6 s. That was wrong, because the tabs carry `aria-expanded`.
  - **Cost:** the reading text is unchanged on six public sites, except a line break now follows each `<summary>`. One observation takes 2 to 17 ms longer on real pages.
  - **Check:** two independent reviews. The first found that content revealed by scrolling (`visibility:hidden` scroll-reveal) was read as the click's effect. A pre-click scroll fixed that, but the second review showed it doubled actions per click (goal mode hit the 12-action cap at click 6), broke targets re-rendered on scroll, and added 0.27 s per click. The scroll was removed and scroll-reveal is now a known limit. No public site showing it was found.
  - **Known limits:** scroll-reveal text, carousels that hide slides with CSS (they become self-changing spots, so the first click after opening can read a slide), accordions hidden only by height or opacity, and tabs with no state marker still waiting 6 s.
  - **Final run:** 366 tests, 35 of 35 scenarios, 0 read-only violations, 0 secret leaks, lint clean. Snapshot `after-unitD`, patch `.audit/patches/unitD.diff`. Not committed.
- **E.** Built as in the table, with one exception. `readOnlyClicks` was not made required, because that means editing `tests/unit/test_policy.py`, which another session is changing on `feat/local-stt-privacy`. The action-name rule is `safety.guard.is_action_name`.
- **Check (2026-11-18).** The independent reviewer said "not ready", with one high finding. C learned content that arrived late as "changes by itself" and then hid real click results there. Reworked:
  - A place counts as self-changing only after it changes during two separate pauses.
  - Only as many lines as used to change there are ignored.
  - Waiting loops are marked explicitly and never learn.
  - With the old rule, the new regression test fails with the reviewer's exact wrong reply. With the new rule, it passes.

  Also fixed:
  - Unit A runs only for e2e tests, shows its wait message, waits 120 s by default (`MOCK_SITE_WAIT_S`), and binds the port exclusively on Windows.
  - The login hand-off follows only links with an address.
  - The action-name rule is widened.
  - `javascript:` variants are judged by the parsed protocol.

  Final run: 362 tests, 35 of 35 scenarios, lint clean. Snapshot `after-check2`.
- **Merge requirement (agreed with the "skills and intents" session, 2026-11-18).** That session's two click checks only look at some roles. One is `_risky_button` on the full tier, which checks role `button`. The other is `LOGIN_NAME` on read-only sites, which checks roles `button` and `link`. After the merge, `observe.js` also emits `scriptlink`, `tab`, `menuitem` and `generic`. A risky name with one of those roles would skip the spoken confirmation. So at merge, both checks must cover every role except a real `link`, and tabs and script links should use `is_action_name` instead of `RISKY_BUTTON`. The order is `LOGIN_NAME` first, then the `readOnlyClicks` gate. Approved clicks go through `outline.items` and refs. That session also logged this in `.audit/agreed-fixes.tsv` in the main checkout.
- **Conflict to settle at merge.** Another session reports that you decided risky clicks on real sites get a spoken explanation and an explicit go word, then the click. This branch's `READ_ONLY_CLICKS=any` default came from "allow everything for now" in this session. The newer rule should replace `any` at merge. `is_action_name` and the role classification can feed it.

## Goal

A click always reports what really happened, and the test suite stops failing for reasons unrelated to the code. Five units, cheapest and safest first. Each unit is one commit and ends in a check that can be rerun.

## Before any unit

1. **Commit the checked work.** The branch passed the check (320 tests, 35 of 35 scenarios). With that commit in place, each fix below can be reviewed and reverted alone. Waits for your approval.
2. **The rename in the main folder** (`ieum` to `cheongeum`) is uncommitted on `feat/local-stt-privacy`. These fixes stay on the old names. The rename is applied once, when the branches merge.

## Unit A. Stop test runs in two folders from breaking each other

Problem: every test setup reuses whatever already answers on port 5174. A run in one folder can use the other folder's mock site (different files), then lose it when that run ends. This is the likely cause of the 91-failure run (inferred, seen once live).

Why not a separate port per run: the port is written into the scenario data, including `demo_scenarios.json`, which must not be edited, and into about 30 test lines. So the port stays shared and access is made orderly.

| File | Change |
|---|---|
| `src/ieum/practice_site/serve.py` | Every response carries a header that identifies the site folder it serves. New helper `ensure_mock_site()`: reuse the server only when the header matches this checkout. If another checkout holds the port, print one line and wait until it is free (up to 5 minutes), then start our own. |
| `tests/conftest.py`, `scripts/run_scenarios.py`, `scripts/eval_agent.py` | Use the helper instead of "reachable means reuse". |
| `tests/e2e/test_navigation.py` | Delete the `_portal2_served` workaround. |

Check: start the mock site from the main folder, then run `uv run pytest tests/e2e/test_navigation.py` in the worktree. Today that gives 13 setup errors. After the change it prints the wait line, and passes once the other server stops.

## Unit B. Wait for slow panels

Problem: after a tab click, the wait stops at the first quiet sample. A panel that loads from the server in more than about 0.8 seconds is read out as "불러오는 중" (reproduced by the reviewer).

| File | Change |
|---|---|
| `src/ieum/agents/web/effect.py` | A small rule: revealed text is settled when it is not empty, does not look like a loading message (불러오는 중, 로딩, loading, 잠시만), and is the same in two samples in a row. |
| `src/ieum/agents/web/agent.py` | `_await_effect` waits for settled text after the clicked element changes, up to 3 seconds. The three wait cases (tab or expander, link, other) become named policies instead of one condition. |
| `practice_site/site/portal2.html`, `site/src/portal2.js` | A tab whose panel shows 불러오는 중 and fills in after 1.5 seconds. |
| `tests/e2e/test_navigation.py`, `tests/unit/test_effect.py` | The slow tab reads its content, not the placeholder. |

Check: the new tests, and the real 복지로 tab click still finishes in about 1 second (0.9 s today).

## Unit C. Do not read a rotating banner as the result of a click

Problem: when a click has no detectable effect, the agent waits 6 seconds, and a banner that changed in that time is read out as "새로 보이는 내용" (reproduced by the reviewer).

Design: no extra waiting. The agent already looks at a page several times before the user's next command. Lines that appear or disappear between two looks at the same page, with no action in between, are remembered as lines that change on their own. The effect check ignores them.

| File | Change |
|---|---|
| `src/ieum/agents/web/effect.py` | `volatile_lines(prev, cur)`, and `diff_views` takes a set of lines to ignore. |
| `src/ieum/agents/web/agent.py` | `observe` keeps that set per page address. It is cleared when the address changes and not updated while a click is being checked. |
| `practice_site/site/portal2.html` | A notice line that rotates every second, switched on by a URL parameter so other tests are not slowed. |
| tests | On the rotating page, a no-effect click says "바뀌지 않았어요", and a tab click reads only the panel. |

Check: the new tests. Possible extra gain to measure, not promised: opening a page with a ticker waits the full 6 seconds today because the text never stops changing. Ignoring the same lines there could shorten it.

Limit: a banner that first changes after the click, having never changed before, is still misread. Rare, because the pause between opening a page and the next command is usually longer than a banner cycle.

## Unit D. Page text holds only what is visible (needs your decision)

Problem: the page text includes text hidden with CSS. So a tab built without accessibility markup shows no new text when clicked, and the agent says "바뀌지 않았어요" after 6 seconds (reproduced). On the real 복지로 page, going back to 지원대상 says only "같은 화면에서 내용이 바뀌었어요" for the same reason.

Recommendation: visible text only. Reasons:
- The agent's job is to say what is on the screen. Hidden menus, closed popups and templates are not on it.
- Hidden text is where a page can plant instructions that no sighted helper would ever notice (inferred, a known attack pattern).
- Tabs and expanders can now be clicked, so hidden panels are reachable the honest way.

Cost: an answer that sits in a closed panel needs one click first. Text written for screen readers (visually clipped, not `display: none`) stays, because it is written for our users.

Steps:
1. **Measure first.** Run both versions of the text on the eight public sites. Record characters kept and a sample of what is dropped. If something useful disappears, stop and show you before going on.
2. `browser/observe.js`: mark elements that are not displayed in the live page, in the pass that already scans every element, and leave them out of the text copy.
3. Mock page: a tab pair with no ARIA, hidden by a CSS class.
4. Tests: the CSS-only tab click reads its panel. Existing reading tests and the 35 scenarios must still pass.

Check: the tests, the scenario report, and the before-and-after table from step 1. This is the unit where `scripts/eval_agent.py` (paid) would tell the most.

Alternative if you want hidden text kept: leave the text as it is and add a second, visible-only fingerprint used only to detect change. Clicks are then reported correctly, but the agent keeps reading text a sighted person cannot see.

## Unit E. Define the `safe` setting properly (needs your decision)

Problem: `READ_ONLY_CLICKS=safe` no longer matches the old rule, because elements are now classified by their declared role. No effect today (the default is `any`). This unit makes `safe` ready for when you turn it on.

Proposed rule for clicks on sites outside the supported list:

| Element | `safe` rule | Example |
|---|---|---|
| Link with an address, whatever role it declares | Allowed | `<a href role="menuitem">복지서비스</a>` works again |
| Tab that is structurally a tab, and link without an address | Allowed unless the name is an action: ends in 하기, or is a bare action word (신청, 제출, 결제, 로그인, 탈퇴, 삭제) | 신청방법 allowed. 신청하기, 회원 탈퇴 blocked |
| Button, menu item without an address | Today's word list | 보내기 blocked |
| Clickable element with no role | Blocked | |

| File | Change |
|---|---|
| `browser/observe.js` | A link with an address is always a link. A tab counts as a tab only inside a tab list or with `aria-controls` or `aria-selected`. A link without an address gets its own role value, so the guard can tell it from a real link without new fields on the action. |
| `core/actions.py`, `agents/web/digest.py` | The new role value. |
| `safety/guard.py` | The table above. `readOnlyClicks` becomes a required setting, so the default lives in one place. |
| `tests/unit/test_parser.py`, `tests/e2e/test_navigation.py` | One row per line of the table, plus the three cases the reviewer found. |

Check: the table tests, the full suite and the 35 scenarios, which run with `safe`.

The decision is the middle row. It is the 신청방법 question from before. Without it, 복지로's 신청방법 is blocked in `safe` mode.

## Unit F. Small cleanups (optional)

Typed shape for the list of buttons and tabs sent to the model. Names for the 30, 12 and 12 slot numbers. Remove the fallback for observations without `items` after moving the old test fixtures. No behavior change. Skip it if you would rather keep the diff small.

## After each unit

Full test suite, then the scenario report, one at a time. After B, C and D, also the real 복지로 tab click.

## Decisions needed

1. Approve the commit of the checked work.
2. Unit D: visible text only (recommended), or keep hidden text.
3. Unit E: allow information-named tabs such as 신청방법 in `safe` mode (recommended), or keep one word list for everything.
4. Whether to include Unit F.
5. Whether `scripts/eval_agent.py` may run. It calls a paid model and real sites.

Units A, B and C need no decision.
