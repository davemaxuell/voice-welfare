# Applying "navigating agent.md" to 청음

Date: 2026-11-17. Companion to `navigating agent.md` in this folder.

This document answers one question. Which ideas in the GUI-agent research note would make 청음 better at getting through websites, and later desktop apps, and in what order should they be built?

## Verdict

The note describes agents that look at screenshots and click pixel coordinates. 청음 should not move to that design. It already runs the same observe, decide, act, re-observe loop, but on DOM text with actions addressed by role and name. That is the better base for a voice product for blind users, because the safety gate judges every click by its role and name.

The largest wins are not in the note's headline techniques. A live probe of nine public pages shows that the autopilot loses most of its ground before the model is ever asked. On the 복지로 home page the model is offered 12 buttons, all of them utility buttons, while the main menu buttons are observed and then cut. Fixing what the model is shown comes first. Vision and app control come later.

## How the evidence was gathered

- **Code reading.** `src/cheongeum/agents/web/` (autopilot, agent, digest, browser adapter, `observe.js`), `src/cheongeum/core/actions.py`, `src/cheongeum/core/llm.py`, `src/cheongeum/safety/guard.py`.
- **Live probe.** Headless Chromium with the same context settings as the adapter (locale `ko-KR`, viewport 1100 by 860), one visit per page on 2026-11-17. Each page was opened read-only. Nothing was clicked or typed. The scripts are in `research results/probes/`.
- **External sources.** Listed at the end. Each link was returned by a search in this session.

Run a probe from the repository root:

```bash
uv run python "research results/probes/probe_gaps.py"            # what observe.js sees and misses, per site
uv run python "research results/probes/digest_check.py" <url>    # which items reach the autopilot model
uv run python "research results/probes/drill_anchors.py" <url>   # markup of anchors without href
```

## How 청음 navigates today

1. `observe.js` runs in the page and returns fields, links, buttons, headings, dialogs, and up to 4,000 characters of main text.
2. `digest.py` turns that into a short page summary. `digest_for_llm` passes at most 30 content links, 12 menu links, and 12 buttons (`digest.py:188-199`).
3. `autopilot.py` asks the model for one action per step out of `open_url`, `click`, `search`, `back`, `read_more`, `answer`, `ask_user`, `fail`. The budget is 10 steps and 75 seconds.
4. `WebExecutionAgent._run` sends every action through `PolicyGuard.check` before the Playwright adapter runs it (`agent.py:322`).
5. Answers are checked against the text of the pages seen in this run (`safety/verify.py`).

This is the loop in the note's Diagram 1. The differences are deliberate. Perception is text, the model is text-only (`core/llm.py:81`), and the action contract has no coordinate click (`core/actions.py:47`).

## What the probe measured

| Page | Seen by observe | Measured gap |
|---|---|---|
| 복지로 home | 2 links, 40 buttons (the cap) | 12 of 40 buttons reach the model. Not sent: 복지서비스, 서비스신청, 복지위기알림, 복지지도. 9 clickable `div`s with no role are not observed. |
| 복지로 service detail | 2 links, 24 buttons | 12 of 24 buttons reach the model. 3 anchors with `role="link"` and no `href` are not observed. 6 clickable `div`s are not observed. The page has no `<main>` and one usable heading. |
| 정부24 | 0 links, 0 buttons | Redirected to a bot wall (`plus.gov.kr/mbuster`). Not a perception problem. 청음 reports it and does not bypass it. |
| 홈택스 | 43 links, 11 buttons, 8 fields | 1 anchor without `href`. Small gap on the landing page. |
| 국민연금 | 6 links, 1 button | Redirected to a gate page. Small gap. |
| 보건복지부 | 84 links, 28 buttons | 2 image-only links dropped. 17 expandable controls observed without their open or closed state. One cross-origin news widget in an iframe holds 2,413 characters. |
| 건강보험 | 98 links, 40 buttons (the cap), 23 fields | 6 image-only links dropped. 2 tabs built as `li` are not observed, and their hidden panel holds 718 characters. |
| 네이버 | 129 links, 20 buttons | 28 image-only links dropped. 14 tabs observed as plain links, so the model cannot tell they are tabs. |
| 네이버 뉴스 | 524 links (300 kept), 40 buttons (the cap), 45 fields | Visible text is 17,075 characters and `mainText` keeps 4,000. `read_more` pages only through those 4,000. |

What the numbers say:

- **Truncation is the first problem.** On 복지로, menus are buttons, and the first 12 buttons in DOM order are "본문 바로가기", "공동인증서 내보내기", "지원", "작게", "크게", "로그인" and similar. The autopilot prompt tells the model it can only click names in the list. So the model cannot choose 복지서비스 on the product's main target site.
- **Names are lost cheaply.** `linkName` in `observe.js:79` ignores `img alt`, so a link that contains only an image with alt text has an empty name and is dropped. Every image-only link in the sample had alt text. No vision model is needed to recover them.
- **Role and state are lost.** Tabs and expanders are mostly real links or buttons, so they are observed, but `role="tab"`, `aria-selected`, and `aria-expanded` are not reported. The model cannot tell a tab from a link, or which tab is open.
- **In-page changes look like success.** `follow_link` waits up to 6 seconds for the URL or title to change, then returns `ok` either way (`agent.py:164-167`). A click on a tab or an expander therefore stalls for 6 seconds and is recorded as a successful move. This is read from the code. It was not timed.
- **Iframes and shadow DOM matter less than expected.** No page in the sample used shadow DOM. Child frames were banners, ads, and one news widget. Deep pages of 홈택스 or 정부24 may differ. They were not sampled.
- **`mainText` may include hidden text.** On 보건복지부 and 건강보험, `mainText` is longer than the visible body text. It is built from `textContent` of a clone (`observe.js:110`), which includes text inside `display:none` elements. This was not investigated further.

Limits of the sample: nine pages, mostly landing pages, one visit each, no login. Content differs per visit.

## What to take from the note

| Idea in the note | Fit | Why |
|---|---|---|
| Perceive, reason, act loop | Already built | `autopilot.py:138`. |
| Grounding through DOM or accessibility data and element IDs | Take | This is the right grounding for 청음. Give each interactive element a ref and let the model pick a ref. |
| Feedback after each action, re-plan when a click has no effect | Take | The loop currently reports success when nothing changed. |
| Vision input | Take as a fallback reader | For pages where text extraction is thin and for images without alt text. Not as the main sense. |
| Coordinate clicks | Reject | The contract excludes them on purpose, and `PolicyGuard` cannot judge a coordinate. |
| OS accessibility APIs for desktop apps | Take later | `ExecutionAdapter` is already platform-neutral (`core/actions.py:182`). |
| Human handoff for logins, CAPTCHA, payments | Already built | `safety/gates.py`, `guard.py`. |
| Prompt injection defense | Already built in principle | Page text is treated as untrusted data. Vision output must follow the same rule. |
| Training, fine-tuning, RL, 1.2M traces | Reject | 청음 uses hosted and local models. This is a different kind of project. |
| OSWorld, WebArena, WebVoyager | Reject | Extend `scripts/eval_agent.py` with tasks on the sites that matter to 청음 users. |
| Memory of learned procedures | Not now | Site knowledge belongs in `SiteProfile`. Self-written procedures would be a second, unreviewed source. |

### Reliability of the note

Use the note for general techniques only. Its product table has entries that could not be verified in this session, such as "OpenAI Dots" and "Grok Bot", and one entry that is wrong on its face. It says Claude's computer use was "fine-tuned GPT-3.5". Claude is Anthropic's own model family. The benchmark percentages were not checked.

## Proposed stages

### Stage 0. Measure first

Add tasks to `scripts/eval_agent.py` that fail today for the reasons measured above. For example, a 복지로 task that needs the 복지서비스 menu, a task whose answer sits behind a tab, a task whose answer sits past 4,000 characters, and a task that needs an image-only link. Add tab, expander, and image-link fixtures to the mock site so the unit and e2e suites cover them without the network. The mock site has none today.

### Stage 1. Show the model the right things

No new model, no new dependency.

1. **Rank instead of cut.** Replace `d.buttons[:12]` with a selection that drops utility buttons (font size, skip links, language, social, footer) and keeps navigation buttons. On sites where links are scarce and buttons are many, give buttons the link budget.
2. **Recover names.** Use `img alt` in `linkName`. Observe `[role="link"]` anchors without `href`.
3. **One interactive list with refs.** Each entry carries a ref, a role (link, button, tab, menu item), a name, and its state (selected, expanded, disabled). `observe.js` already stamps `data-cheongeum-id` on fields (`observe.js:10-14`). Extend that to every interactive element. The model answers with a ref. The adapter resolves the ref to one element, so name ambiguity ("여러 개가 맞음", `autopilot.py:256`) and the text-matching fallback (`browser/__init__.py:314`) stop being failure paths. `PolicyGuard` still receives role and name, so its rules keep working.
4. **Clickable elements without a role.** Observe elements with `cursor: pointer` and their own text that sit outside any link or button. Treat them as buttons for the guard, so the risky-name rule applies.
5. **Raise or page the caps.** `mainText` 4,000 characters, 300 links, 40 buttons.

Alternative for item 3: Playwright's `aria_snapshot()` returns a YAML tree of roles, names, and states, and it exists in the installed version (1.65.2, checked by import). An open issue reports that the Python API lacks the `ref` option that the Node API has. Without refs the snapshot cannot be mapped back to elements, so extending `observe.js` is the lower-risk path. A one-hour prototype can confirm this.

### Stage 2. Tell the model what its action did

1. **Effect check.** Compare the observation before and after each click: URL, title, main text, dialogs, and the clicked element's state. Report "moved", "changed in place", or "no visible change" in the step history. Stop waiting 6 seconds when the change is in place.
2. **New moves.** `scroll` for lazy-loaded lists. The adapter supports it (`browser/__init__.py:257`) and the autopilot does not offer it. Tab selection and expand come for free once stage 1 reports them as clickable items.
3. **Policy.** `_check_read_only` allows clicks on links and on buttons whose name is not risky (`guard.py:142-148`). Tabs and expanders that are neither need an explicit rule. This is a safety decision for the owner.

### Stage 3. Vision as a fallback reader

1. **Plumbing.** `generate` accepts an optional image and sends it as an image part in the OpenAI-compatible message.
2. **When.** Only when the digest is thin (little main text, few named items), when an image has no alt text and sits where content should be, or when the user asks for a screen description.
3. **Marks, not coordinates.** Draw the stage 1 refs on the screenshot as numbered marks and ask the model about the marks. This is Set-of-Mark prompting. The model's answer names a ref, and the action stays element-addressed.
4. **Rules that must hold.** Vision output is untrusted text. It never becomes an instruction. Numbers read from an image cannot be checked by `verify.py`, which compares against DOM text, so such answers must be labelled as read from an image or withheld.
5. **Privacy.** A screenshot can contain what the user typed. Mask input fields before capture. Playwright's `screenshot(mask=...)` exists in the installed version. Capture only on read-only pages, or use a local vision model only.
6. **Cost.** One extra model call when triggered. The local Qwen 7B setup is text-only, so a vision-capable model is needed.

### Stage 4. Desktop apps

1. **Shape.** A second `ExecutionAdapter` over Windows UI Automation. UIA exposes the role-and-name tree that screen readers use, and control patterns map onto the existing action types: Invoke for `click`, Value for `fill` and `read`, Toggle for `check`, ExpandCollapse for menus.
2. **Library.** `pywinauto` with `backend="uia"` wraps patterns behind control methods. The `uiautomation` package exposes pattern objects directly. Either adds a Windows-only dependency.
3. **What must be designed first.** `PolicyGuard` tiers by URL origin (`guard.py:70-78`). Apps need their own allowlist, for example by process and window, and their own read-only tier. `Platform` is `Literal["pc"]` and `Observation` requires a `url`.
4. **Recommendation.** Build a throwaway prototype on one harmless app after stages 1 and 2 land. Certificate and login windows stay with the user, as they do on the web. The planning summary's expansion path is more public websites (`docs/기획요약.md:32`), so this stage is a scope decision, not a technical one.

## Decisions for the owner

1. Which stages to build. Recommended: 0, 1, 2 now. Stage 3 after the eval shows what remains. Stage 4 as a prototype only.
2. Whether read-only sites may have tabs, expanders, and role-less clickable elements clicked, under the same risky-name rule as buttons.
3. Whether screenshots may be sent to a hosted model with input fields masked, or vision must stay local.
4. Whether desktop apps are in scope, and which app the prototype should target.

## External sources

- Set-of-Mark prompting: [arXiv 2310.11441](https://arxiv.org/abs/2310.11441).
- Playwright Python aria snapshots: [guide](https://playwright.dev/python/docs/aria-snapshots), [Locator API](https://playwright.dev/python/docs/api/class-locator), [release notes](https://playwright.dev/python/docs/release-notes). The missing `ref` option is reported in playwright-python issue 2826, seen through a mirror and not confirmed as still open.
- Windows UI Automation: [control types and supported patterns](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternmapping), [pywinauto getting started](https://pywinauto.readthedocs.io/en/latest/getting_started.html).
- DOM lists versus screenshots as agent input: [webfuse comparison](https://www.webfuse.com/blog/dom-snapshots-vs-screenshots-as-web-agent-context). The search results on this topic were blogs and vendor posts, and they disagreed on details of browser-use. They support the general tradeoff only.
