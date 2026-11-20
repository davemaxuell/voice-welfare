# Bokjiro live fixes todo

Goal: on live Bokjiro, "검색해줘" answers only when results are readable, "뒤로 가줘" lands exactly one page back, and the multi-step goal finishes inside its budget.

Bug fix playbook steps (verbatim), with skips:

- [x] 1. Reproduce it yourself on the matching surface via the driver skill. Done with `probe_live.py` (session + headed Chrome, scratch profile): search said done at 17 s with an empty view, read found nothing, back skipped Bokjiro's main page.
- [x] 2. Binary-search the cause. Three probes, see Evidence. skip `how`/`why` fan-out: the timelines name the mechanism directly.
- [x] 3. Review the cache change. Two independent reviews checked the runtime configuration, restricted mode, and Back. A Chromium regression reproduced one finding. Opening and closing a popup discarded the original tab’s pending search. Each tab now tracks its own requests and document method.
- [x] 4. Verify on the same surface. Replayed in headed Chrome with a fresh profile on 2026-11-18.
- [ ] 5. Stage the commits so the failing repro lands before the fix. skip commit: user has not asked to commit. Tests are written failing-first.
- [ ] 6. Run Opening a PR. skip: user has not asked for a PR.

## Evidence

- Limiter (probe_cache.py, same browser, alternating, 3 rounds): Bokjiro home text at 1.2 / 2.3 / 1.6 s with cache, 31.5 / 25.4 / 15.7 s with cache off, 55.5 / 23.0 / 13.1 s with a `**/*` route. Playwright disables the HTTP cache while any route is registered. Forcing the cache back on over CDP did not help (13.5 / 15.6 / 14.2 s).
- Search (run1.json): POST at 20.3 s, page still `readyState=interactive`, 0 chars at 35.6 s when the turn said "검색했어요". `_observe_until` returned on timeout, `_settle` saw "" == "" and stopped.
- Back (run1.json): one `back` action, yet two history steps (35.62 → index.do, 45.78 → localhost). `go_back(wait_until="domcontentloaded")` hit the 10 s limit on the slow page, `_run` retried the low-risk action.
- No extra history entries from the results page: `history.length` stayed 3 in four runs (probe_route.py).
- Results page with cache (probe_build2.py): skeleton 322 chars at 2.5 s, unchanged 4.0 → 7.1 s while XHR `getHeaderInf.do` is in flight, then XHR `selectTwzzIntgSearchList.do`, results (11,172 chars) at 10.1 s.

## Data shape

The browser sets `loading` while a recent same-host request is in flight. It tracks Bokjiro’s integrated-search header and result-list requests until they finish, including when they take longer than ten seconds. Search reports when it cannot confirm a change or when results are still loading.

## Fixes

- [x] A. Read-only browsing preserves the HTTP cache. Direct navigation checks the URL scheme.
- [x] B. Back waits for commit. One Back command returned from live integrated search to the exact home URL.
- [x] C. Direct search returned readable results. A browser regression test holds the result-list request open past the normal freshness window and releases it before the next read.
- [x] D. For a named program’s application instructions, start on the detail URL matched in the official catalog and verify the answer against the requested site.
- [x] E. Back waits for the page to settle, like Open does. Live: Back from integrated search described Bokjiro's home page instead of "아직 다 열리지 않았어요". Test: `test_back_onto_a_page_that_fetches_its_content_describes_that_content`.
- [x] F. Back onto the results of the user's own search (a form POST) no longer dead-ends. The adapter reports the blocked URL. If it matches the last search's results, Back jumps two history entries to the page where the search was typed (`back` with `url`, verified to land there), then searches again. Any other form result stays put, and the reply no longer says "다시 시도". Tests fail without the change (copy of the tree, 2 failed) and pass with it. Live (2026-11-18 18:40): result page → Back → results (17 s) → Back → Bokjiro home → Back → session start. The guard blocked both history POSTs, and the server saw only the user's search and the fresh re-search.

## Live verification on 2026-11-18

- The original 기초연금 request opened WLF00001164, selected 신청방법, and quoted the displayed application instructions. The updated R3 check passed in 18.5 seconds with the default click policy and 11.1 seconds with the stricter policy. Both runs used gpt-5-mini and an isolated Chrome profile.
- The 장애인연금 request opened WLF00003249 and answered from its application tab in 10.0 seconds.
- The direct sequence opened Bokjiro, searched for 기초연금, read the result list, and returned to the home page in one Back action. These checks used text commands through the session entry point.
- The full suite passed 969 tests. After the popup fix, all 64 affected browser tests passed, including the new regression. A final headed Chrome session repeated the direct sequence and passed R3 in 8.6 seconds.
