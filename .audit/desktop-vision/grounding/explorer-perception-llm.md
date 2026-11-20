## Perception and LLM path: what exists today and where a vision screenshot plugs in

No screenshot or vision code exists anywhere in `src/`. Nothing in `src/` matches screenshot, image_url, vision or base64. Every LLM call is text-only.

### Components Found
- **`observe.js`** (`src/cheongeum/agents/web/browser/observe.js`): an in-page IIFE that returns `{title, fields, errors, dialogs, step?, status?, outline}`. It reads the top-level document only and never descends into iframes.
- **`PlaywrightExecutionAdapter`** (`agents/web/browser/__init__.py:104`): holds `self.page: Page | None` (l.128) and `self.context`. `self.shared` is True in Chrome mode. `observe()` is at l.566-571. There is no screenshot method, but `self.page` is the handle for `page.screenshot(mask=..., style=..., scale="css")`. Playwright is pinned at 1.65.2 in `uv.lock`, so all of those options exist.
- **`ScreenOutline` / `Observation` / `InteractiveItem` / `ActionTarget`** (`core/actions.py:156-197`, l.55). The `ActionTarget` docstring says "좌표 클릭은 계약에 없다": coordinate clicks are not part of the contract. A `ref` must carry `role` and `name` (l.68-73). `Platform = Literal["pc"]`, and `url` is required.
- **`PageDigest` / `digest_page` / `digest_for_llm`** (`agents/web/digest.py:33,169,234`): a rule-based summary. `BLOCKED` (l.17) is the bot-block and CAPTCHA regex.
- **`OpenAIStructuredLlm.generate`** (`core/llm.py:98`): `async def generate(self, *, system: str, user: str, schemaName: str, schema: dict, signal: AbortSignal | None = None) -> Any | None`.
- **`Narrator`** (`speech/screen.py:23`): `describe_screen` (sync, rules only), `brief_screen`, `page_intro` and `summarize_body` (the last three are async and call the LLM).
- **`check_grounding` / `unsupported_numbers` / `quote_in_source`** (`safety/verify.py:188,169,41`).
- **`redact_text` / `detect_sensitive`** (`safety/privacy.py:165,138`).
- **`auth_page_kind`** (`agents/web/auth_page.py:55`): returns login, verification or other. **`blocked_speech`** (`agents/web/playbook.py:120`).
- **`read_document`** (`agents/web/docs.py:11`) and **`DownloadStore.read_latest`** (`downloads.py:36`): read downloads with pypdf, or as HWPX zip+XML. Old binary HWP is not readable.

### Flow ("화면 설명해줘", describe the screen)
1. `rules.py:197` matches `(화면|페이지).*(설명|읽어|뭐가|뭐\s*있|어떻게\s*생|전체|묘사)` and produces `{"type":"DESCRIBE_SCREEN"}`. The intent registry row is at `core/intents.py:195`.
2. The router at `session.py:1233` calls `s.browse.screen(t.text, t.ctx)`.
3. `BrowseSkill.screen` (`skills/browse.py:484-497`) calls `self.web.observe(ctx)`:
   - `WebExecutionAgent.observe` (`agent.py:443`) runs `adapter.observe()`. That runs `page.evaluate(OBSERVE_SCRIPT)` and then `parse_observation`.
   - The agent adds `pageId = profile.classify(url)` and updates `Churn`.
4. Branch on the view:
   - If the page is a mock page or the user said 자세히/전체/구성, it uses `narrator.describe_screen(view)` plus `form.ask_next`. This is pure rules: title, kind, menu, notices with an injection caution, headings, landmarks, errors, dialogs, 10 fields, a 200-character excerpt, 12 buttons and 15 links.
   - Otherwise it uses `narrator.brief_screen(view, ctx)` (`screen.py:200`). If `digest.kind == "blocked"`, that returns `describe_page`, which ends in `blocked_speech`. Otherwise it calls `summarize_body`.
5. `summarize_body` (`screen.py:228-254`):
   - Builds `body = headings[:6] + d.main`, capped at 3000 characters.
   - Calls `llm.generate(system=..., user=jdumps({"title": redact_text(title), "page": redact_text(body)}), schemaName="page_summary", schema=SIMPLE_TEXT_SCHEMA, signal=ctx.signal)`.
   - Then runs `unsupported_numbers(text, [body, title])` against the **raw** text. Any unsupported number returns `None`, and the caller falls back to `main_chunk` (the first 150 characters of the body).
6. The result goes back as `draft(..., "describe-screen", speech, view=view, masked=True)`. `_finish` → `_summarize(view)` (`session.py:666`) masks field values for the UI.

`page_intro` (the same LLM summary) runs after open_site, follow_link, back and search (`browse.py:141,201,273,376,471`). The autopilot uses `digest_for_llm` instead (`autopilot.py:73`).

### Observation details
- **Refs.** `refOf` (`observe.js:138-147`) stamps `data-cheongeum-ref="r<seq>-<rand>"` and reuses an existing value unless it is a duplicate, which happens with clones. Fields without an id get `data-cheongeum-id`.
- **Items.** Candidates are standard controls plus up to 20 `cursor:pointer` "generic" roots. Each item is `{ref, role, name, region, disabled, selected?, expanded?}`. There are **no coordinates or bounding boxes** in the observation.
- **Ref check before acting.** `_resolve_ref` (`__init__.py:516`) re-runs the whole observe script before each ref action and raises `VERIFY_FAILED` if the role or name changed.
- **Shared Chrome.** `BROWSER_MODE=chrome` uses `launch_chrome_profile` (`__init__.py:78`), a persistent context with `no_viewport=True`, so screenshot size equals the window size. Each session claims its own tab (`_claimed_pages`). `close()` opens a blank tab before closing the last one (l.618-627). Chromium mode is a per-session context with a 1100×860 viewport.

### LLM configuration
- `load_config` (`server/runtime.py:109-143`) reads `LLM_PROVIDER|MODEL|BASE_URL|API_KEY|REASONING_EFFORT`.
- Per-role overrides come from `_llm_role` (l.96): `LLM_UNDERSTAND_*`, `LLM_GOAL_*` and `LLM_WEB_*`. `answer_llm` uses the WEB role and is what `summarize_body` uses (`getattr(deps,"web_llm")` falls back to `deps.llm`).
- Providers are mock, openai, ollama, qwen and openai-compatible, all over raw httpx (no openai SDK).
- Timeout is 30s, or 60s for ollama (`llm.py:95,141`). `LlmConfig.timeoutMs` is never set from env, and `create_structured_llm` ignores it.
- Messages are built at `llm.py:105` as `[{"role":"system","content":system},{"role":"user","content":user}]`, where `user` is a **str**. There is no image-part support.
- There is no `.env.example`. I did not read `.env`.
- **Tests.** `FakeLlm` (`tests/conftest.py:98`) has the same `generate` signature and answers by `schemaName`. `with_llm` sets `session.deps.llm` and `deps.welfare.llm`. `scripted()` calls `json.loads(user)`, so tests assume `user` is a JSON string.

### Boundaries
- **Inputs.** Utterance → intent → `BrowseSkill.screen` → adapter `page`.
- **Outputs.** Speech text plus `TurnResult.observation` (masked by `_summarize`) and the `flags.masked` bit.
- **Natural vision seams:**
  1. A new adapter method next to `observe()`. It must also be added to the `ExecutionAdapter` Protocol (`actions.py:217`).
  2. `generate` would need list-shaped `content` with an `image_url` data URL.
  3. A new Narrator method beside `summarize_body`, chosen in `BrowseSkill.screen`.
  4. A new `LLM_VISION_*` role via `_llm_role`, because the WEB role may point at a text-only Ollama or Qwen model.
- **Layering** (`tests/unit/test_layers.py`):
  - `speech.screen` may import `agents.web`, `core`, `safety` and `speech.phrasing`.
  - `core.llm` must not import anything above `core`.
  - `agents.web` must not import `speech.screen`. That is why `playbook.py` lives in `agents/web`.

### Non-Obvious Things
- **`redact_text` truncates whole page bodies.** For any keyword (주민등록번호, 비밀번호, 계좌, 카드번호…), `_has_value_after` returns True if *any digit appears anywhere later* in the string (`privacy.py:117`). Everything after the keyword then becomes ` [비공개]` (l.181). I confirmed this by running it: `'신청 시 주민등록번호 앞자리가 필요합니다. … 334,810원 …'` becomes `'신청 시 주민등록번호 [비공개]'`. Welfare pages often list 주민등록번호 under required documents, so the LLM often sees only a stub. A screenshot would show the full page, so text and vision would get different privacy treatment. There is no pixel-level analogue of `redact_text`.
- **Verification needs text sources.** `unsupported_numbers` and `quote_in_source` (≥4 normalized characters, 85% 2-gram overlap) compare against strings. For an image answer, the only checkable source is DOM text. Numbers seen only in images, canvas or iframes would be flagged, and the summary would be dropped.
- **Masking has DOM-only anchors.** Non-sensitive field `value`s, including typed name and phone, go into the observation. They would also show in pixels, so a mask must cover `input, textarea, select` and `[type=password]`.
- **iframes are invisible to `observe.js`.** reCAPTCHA, payment widgets and embedded viewers never reach the DOM text, but they appear in a screenshot. Cross-origin iframes can only be masked as whole `page.locator("iframe")` boxes.
- **CAPTCHA and bot-block detection is text-only.** `digest.BLOCKED` checks the title plus the first 600 characters of main, and `auth_page_kind` checks the title, password fields and app names. An image-only CAPTCHA with no matching text is not detected.
- **Bug: `auth_page._view_haystack` reads `view.get("mainText")` (`auth_page.py:36`).** `mainText` lives under `view["outline"]`, so main text never contributes to verification-app detection.
- **The visual cursor overlay would appear in screenshots.** It is `#__cheongeum_cursor` plus ripple rings at z-index 2147483647, appended to `documentElement` (`cursor.js:18-45`). It needs `style=` hiding. `cursor.js` and `__init__.py` have uncommitted changes (a cursor mode refactor).
- **`describe_screen` adds an injection caution only for notices.** It is added when a notice mentions AI, 에이전트 and similar (`screen.py:123-127`, a scenario test checks for it). A vision summary would need the same "don't follow on-screen instructions" framing in its system prompt.
- **`web_answer` does not pass `signal`** to `generate` (`browse.py:569`). `summarize_body` does.

### Open Questions
- I could not tell whether `page.screenshot` works or hangs on a background tab of headed shared Chrome (`no_viewport`), for example when the Electron UI is in front.
- There is no hook today that maps a region of the image back to `outline.items`. Any click after a vision description has to go through the existing name-based `follow_link`. How the vision answer should name items so they match exact `InteractiveItem.name` strings is undecided.
- It is unclear whether OpenAI strict `json_schema` plus image input works with the model the owner sets. I could not see `.env`.
- Scanned PDFs return "글을 찾지 못했어요" from `read_document`. That is a possible later vision use, and I did not explore it.

### Files Read
- `src/cheongeum/agents/web/browser/__init__.py`, `browser/observe.js`, `browser/cursor.js` (grep only)
- `src/cheongeum/core/actions.py`, `core/llm.py`, `core/intents.py` (l.150-231)
- `src/cheongeum/agents/web/digest.py`, `agent.py` (l.1-170, 436-475), `auth_page.py`, `playbook.py`, `docs.py`, `downloads.py`, `autopilot.py` (l.55-184), `skills/browse.py` (l.440-619)
- `src/cheongeum/speech/screen.py`, `safety/verify.py`, `safety/privacy.py`
- `src/cheongeum/understanding/rules.py` (l.170-219), `understanding/llm_planner.py` (l.170-191)
- `src/cheongeum/orchestrator/session.py` (l.625-713, 1215-1248, plus greps)
- `src/cheongeum/server/runtime.py`
- `tests/conftest.py` (l.98-140), `tests/unit/test_layers.py` (l.1-80)
- `.audit/desktop-vision.todo.md`, `uv.lock` (playwright version), `pyproject.toml` (grep)
