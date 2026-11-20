# 첫 실행 설정과 청음 소개 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A first-run setup that a helper or the user alone can finish, ending with a short animated introduction of 청음, plus the storage and use of every value it collects.

**Architecture:** Split at consent. A screen wizard in the conversation window (`web/static/first-run.js`) runs Stage 1 (language, who, key, PC, helper extras) with recorded clips and Stage 2 (sound check, speed) with real TTS, then hands over to the existing consent screen. After consent, a new orchestrator collaborator `FirstRunGuide` runs Stage 3 (mic check, what to call you, stop practice, introduction, practice offer) as a short scripted conversation. Settings progress lives in `SettingsStore`; personal values (`callName`, guardian) live in the sealed `PersonalStore`, which now opens whenever the user said "personal PC".

**Tech Stack:** Python 3.12, FastAPI, Pydantic, httpx, pytest + pytest-asyncio, Playwright; vanilla JS web UI; Electron (desktop shell); three.js avatar.

**Spec:** `docs/superpowers/specs/2026-11-19-first-run-setup-design.md`

## Global Constraints

- The OpenAI API key is required: setup cannot finish without a key that passes the test call (owner decision 2026-11-19).
- No microphone and no STT before consent. Stage 1 and Stage 2 answers are keys (1–4, Enter, Esc, Space) and clickable buttons only.
- Setup never asks age, disability, income, household, or 시·군·구 (owner decision: asked later in 맞춤 찾기).
- All setup and introduction sentences are fixed text in code or the clip manifest, in ko/en/zh/ja. Never model output, never `translate_out`.
- Personal values (`callName`, guardian) are stored only in `PersonalStore`, only on a personal PC; on a shared PC `callName` lives in the session only.
- Shared runtime profile (`pilotProfile == "shared"`) always wins over the user's PC choice.
- User-facing text and code comments in Korean; `josa()` for 조사.
- Every step except language, key, and consent can be skipped; the introduction can be skipped (Esc, button, or "건너뛰기") and replayed ("청음 소개 다시 해줘").
- Reduced motion or the still-avatar setting: no avatar movement during the introduction; cards show still pose images.

## Review Focus

1. **Existing installs upgrading.** A user whose `preferences.json` predates this feature must not see the wizard; `first_run` reads as `"done"`. Pinned in Task 1.
2. **"Usual Chrome" chosen but Chrome missing or locked.** Session creation must fall back to the separate browser and the settings screen says so, instead of failing to start. Pinned in Task 2.
3. **App closed midway.** Closing in Stage 2 resumes at the sound check; closing in Stage 3 resumes at the step reached, once. Pinned in Tasks 8 and 10.
4. **Shared PC and the name.** A name said on a shared PC is not written to disk and is not used in the next session's greeting. Pinned in Task 10.
5. **Fast double key press.** Pressing "1" twice quickly answers one step only; the second press does not answer the next step. Pinned in Task 6.

---

## How each value is saved and used

This is the "save and use" map the tasks implement. "New" marks what this plan adds.

| Value | Saved in | Read by | What changes for the user | See, change, delete |
| --- | --- | --- | --- | --- |
| Language | `preferences.json` `language` | `AgentRuntime.create_session` → `initial_language`; wizard and clips | 청음 speaks and listens in it | Settings dialog; "영어로 말해줘" |
| API key | `preferences.json` `credential` (sealed) | `refresh_services` → STT, TTS, LLM | Voice and AI answers work | Settings dialog |
| PC type | `preferences.json` `deviceUse` | `workflows.personal`, `remember_service`, **new** `AgentRuntime.personal_enabled()` | Personal: 청음 remembers name, guardian, last service. Shared: nothing personal survives the session | Settings dialog |
| Speed | `preferences.json` `speed` | `refresh_services` → TTS speed | How fast 청음 talks | Settings dialog; "천천히 말해줘" (`speech.rate` adjusts on top) |
| Browser (new) | `preferences.json` `browser` | **new** `AgentRuntime.browser_mode()` at session creation | Usual Chrome keeps the user's logins | Settings dialog; applies on next launch |
| Auto-start (new) | Windows login item | Windows | 청음 starts when the PC starts | Settings dialog (desktop only) |
| Guardian | `personal.json` `guardian` (sealed) | `personal/guardian.py` (existing) | 보호자 연락 features have a number | "내 정보 지워줘" clears it |
| What to call you (new) | `personal.json` `callName` (sealed); session only on shared PC | Consent greeting, introduction line 1, "내 정보 알려줘" | "홍길동님, 반가워요." | "내 정보 지워줘"; "설정 다시 해줘" asks again |
| Setup progress (new) | `preferences.json` `firstRun` | `app.js start()`, `SessionOrchestrator.consent_to` | Interrupted setup continues where it stopped, once | Automatic |
| 시·도 (existing, leaves setup) | `preferences.json` `region` | 맞춤 찾기 prefill (`initial_region`) | 맞춤 찾기 skips the region question | Settings dialog |

---

### Task 1: Settings store — required key, browser choice, setup progress

**Files:**
- Modify: `src/cheongeum/server/settings.py`
- Modify: `src/cheongeum/server/app.py` (`/api/health`, `POST /api/settings`)
- Test: `tests/unit/test_first_run_settings.py` (new)
- Modify if they break: `tests/e2e/test_public_service_setup.py`, `tests/e2e/test_durable_workspace.py` (add `"apiKey": "sk-test-…"` to payloads that relied on saving without a key)

**Interfaces:**
- Produces:
  - `Preferences.browser: Literal["separate", "chrome"] = "separate"`; `SettingsStore.save` forces `"separate"` when `deviceUse != "personal"` (same place `rememberService` is forced off).
  - `FIRST_RUN_STEPS: tuple[str, ...] = ("stage2", "mic", "name", "stop", "intro", "practice", "done")` in `settings.py`.
  - `SettingsStore.first_run -> str` (attribute). No file yet: `"stage2"` (where setup resumes once Stage 1 is saved; the client ignores it while `setupRequired`). Loading a file: its `"firstRun"` value, or `"done"` when the key is missing (installs from before this feature). `save` writes the current value and never changes it.
  - `SettingsStore.set_first_run(step: str) -> None`: raises `ValueError` for a step not in `FIRST_RUN_STEPS`; writes atomically with the current preferences, credential and last service.
  - `/api/health` adds `"firstRun": runtime.settings.first_run if runtime.settings else "done"`.
  - `POST /api/settings`: empty `apiKey` while no key is known (`not audio_services.stt.supported`) → `400 KEY_REQUIRED` "OpenAI API 키를 입력해 주세요." Nothing is written.

- [ ] **Step 1: Write the failing tests**

```python
def test_first_save_starts_setup_progress_at_stage2(tmp_path):
    store = SettingsStore(tmp_path / "preferences.json", lambda: Seal(key=b"a" * 32))
    store.save(SettingsInput(apiKey=SecretStr("sk-test"), deviceUse="personal"))
    assert store.first_run == "stage2"
    assert SettingsStore(tmp_path / "preferences.json", lambda: Seal(key=b"a" * 32)).first_run == "stage2"

def test_settings_file_from_before_this_feature_counts_as_done(tmp_path):
    path = tmp_path / "preferences.json"
    path.write_text(json.dumps({"preferences": Preferences().model_dump(exclude={"browser"}), "credential": "", "lastService": None}))
    assert SettingsStore(path).first_run == "done" and SettingsStore(path).completed

def test_set_first_run_survives_reload_and_rejects_unknown_steps(tmp_path): ...
    # set_first_run("intro") → reload == "intro"; set_first_run("nope") raises ValueError; prefs and key unchanged

def test_browser_choice_is_forced_to_separate_on_shared_pc(tmp_path): ...
    # save(browser="chrome", deviceUse="shared") → preferences.browser == "separate"

async def test_saving_without_any_key_is_refused(tmp_path):
    # create_test_runtime() + SettingsStore(tmp) + ASGI client
    r = await c.post("/api/settings", json={"deviceUse": "personal"})
    assert r.status_code == 400 and r.json()["code"] == "KEY_REQUIRED" and not path.exists()
    health = (await c.get("/api/health")).json()
    assert health["setupRequired"] and health["firstRun"] == "stage2"
```

Check the error body shape of `_err` in `app.py` and match it in the assertion.

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/unit/test_first_run_settings.py -v`
Expected: FAIL (`AttributeError: 'SettingsStore' object has no attribute 'first_run'`).

- [ ] **Step 3: Implement the interfaces above** in `settings.py` and `app.py`. `_write` gains a `first_run` argument and writes it as top-level `"firstRun"`.

- [ ] **Step 4: Run the new tests and the settings e2e tests**

Run: `uv run pytest tests/unit/test_first_run_settings.py tests/e2e/test_public_service_setup.py tests/e2e/test_durable_workspace.py -v`
Expected: PASS. Fix payloads in the two e2e files only by adding an `apiKey`.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/server/settings.py src/cheongeum/server/app.py tests/unit/test_first_run_settings.py tests/e2e/test_public_service_setup.py tests/e2e/test_durable_workspace.py
git commit -m "feat: require a key and track first-run progress in settings"
```

---

### Task 2: Personal store and browser follow the user's PC choice

**Files:**
- Modify: `src/cheongeum/server/runtime.py` (`RuntimeConfig`, `load_config`, `AgentRuntime.create_session`, `AgentRuntime.refresh_services`)
- Modify: `src/cheongeum/server/app.py` (`/api/settings` GET adds `browserFallback`)
- Test: `tests/e2e/test_first_run_runtime.py` (new)

**Interfaces:**
- Consumes: `Preferences.browser`, `Preferences.deviceUse` (Task 1).
- Produces:
  - `RuntimeConfig.personalDataDir: str | None` = `CHEONGEUM_DATA_DIR` regardless of profile. `RuntimeConfig.dataDir` keeps today's meaning (set only on `PILOT_PROFILE=personal`).
  - `AgentRuntime.personal_enabled() -> bool`: `pilotProfile == "personal"` or (`pilotProfile != "shared"` and `settings.completed` and `settings.preferences.deviceUse == "personal"`).
  - `AgentRuntime.personal_store() -> PersonalStore | None`: lazily opens the sealed store at `dataDir or personalDataDir` (`personal.json`, `Seal()`), in-memory `PersonalStore()` when enabled without a directory, `None` when not enabled. `create_session` uses it instead of its inline block.
  - `refresh_services` sets `_personal = None` when `personal_enabled()` turns false, so new sessions get no store.
  - `AgentRuntime.browser_mode() -> Literal["chrome", "chromium"]`: `"chrome"` when `personal_enabled()` and (`config.browserMode == "chrome"` or `settings.preferences.browser == "chrome"`).
  - `AgentRuntime.browser_fallback: bool`: set true when `_get_chrome()` raises; `create_session` then uses Chromium. `GET /api/settings` returns `"browserFallback"`.

- [ ] **Step 1: Write the failing tests**

```python
async def test_personal_pc_choice_opens_a_sealed_store_without_pilot_profile(tmp_path): ...
    # env CHEONGEUM_DATA_DIR=tmp_path, no PILOT_PROFILE; settings saved deviceUse="personal"
    # s = await rt.create_session(); s.deps.personal.persistent is True
    # (tmp_path / "personal.json") bytes are sealed (Seal.is_sealed)

async def test_shared_pc_choice_has_no_personal_store(tmp_path): ...
    # deviceUse="shared" → s.deps.personal is None

async def test_switching_to_shared_drops_the_store_for_new_sessions(tmp_path): ...

async def test_usual_chrome_that_cannot_start_falls_back_to_separate_browser(tmp_path, monkeypatch):
    # browser="chrome", deviceUse="personal"; monkeypatch rt._get_chrome to raise
    s = await rt.create_session()
    assert rt.browser_fallback and s.web.adapter is not None
    # GET /api/settings → browserFallback True
```

Use `Seal(key=b"a" * 32)` via monkeypatching `cheongeum.personal.seal.Seal` construction if `Seal()` needs keyring in the test environment; follow how `tests/unit/test_profile_storage_failure.py` handles it.

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/e2e/test_first_run_runtime.py -v`
Expected: FAIL (`AttributeError: ... 'personal_enabled'`).

- [ ] **Step 3: Implement the interfaces above.**

- [ ] **Step 4: Run the new tests and the runtime-heavy suites**

Run: `uv run pytest tests/e2e/test_first_run_runtime.py tests/e2e/test_guardian_contact.py tests/e2e/test_pilot_recovery.py tests/e2e/test_shared_browser.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/server/runtime.py src/cheongeum/server/app.py tests/e2e/test_first_run_runtime.py
git commit -m "feat: open the personal store and usual Chrome when the user chose a personal PC"
```

---

### Task 3: What to call you (`callName`) — storage and everyday use

**Files:**
- Modify: `src/cheongeum/personal/store.py`
- Modify: `src/cheongeum/personal/dialogue.py` (`vault-read` reply includes the call name)
- Modify: `src/cheongeum/orchestrator/session.py` (`consent_to` greeting; a session-only `_call_name` for shared PCs)
- Modify: `src/cheongeum/speech/phrasing.py` (`speak_call_name`)
- Test: `tests/unit/test_call_name.py` (new), `tests/e2e/test_first_run_conversation.py` (new; greeting tests)

**Interfaces:**
- Produces:
  - `PersonalStore.call_name() -> str | None`, `PersonalStore.set_call_name(name: str | None) -> None`; stored as top-level `"callName"`; `clear_vault()` clears it.
  - `SessionOrchestrator.call_name -> str | None` (property): session value if set, else `deps.personal.call_name()` when `deps.personal` exists.
  - `SessionOrchestrator.remember_call_name(name: str) -> bool`: saves to `deps.personal` when present (returns `True`), else keeps it on the session only (returns `False`).
  - `speak_call_name(name: str) -> str` in `speech/phrasing.py`: `"홍길동" → "홍길동님"`, `"길동님" → "길동님"` (no double 님).
  - Greeting copy: with a name, the granted consent reply is `"{speak_call_name(name)}, 반가워요. 시작할게요."` instead of `"동의해 주셔서 감사합니다. 시작할게요."`; the reminders suffix stays.

- [ ] **Step 1: Write the failing tests**

```python
def test_call_name_round_trip_and_cleared_with_vault(tmp_path):
    store = PersonalStore(str(tmp_path / "p.json"))
    store.set_call_name("홍길동")
    assert PersonalStore(str(tmp_path / "p.json")).call_name() == "홍길동"
    store.clear_vault()
    assert PersonalStore(str(tmp_path / "p.json")).call_name() is None

def test_speak_call_name_never_doubles_nim():
    assert speak_call_name("홍길동") == "홍길동님" and speak_call_name("길동님") == "길동님"

async def test_consent_greets_by_saved_call_name(new_session): ...
    # session with PersonalStore(call_name 홍길동) → consent_to(True)["speech"].startswith("홍길동님, 반가워요.")

async def test_vault_read_includes_call_name(new_session): ...
    # "내 정보 알려줘" → speech contains "부르는 이름은 홍길동님"
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/unit/test_call_name.py tests/e2e/test_first_run_conversation.py -k "call_name or greets or vault_read" -v`
Expected: FAIL.

- [ ] **Step 3: Implement the interfaces above.** Check how `new_session` in `tests/conftest.py` passes `personal`; extend it with a keyword if needed rather than reaching into private fields.

- [ ] **Step 4: Run the tests and the personal suites**

Run: `uv run pytest tests/unit/test_call_name.py tests/unit/test_guardian.py tests/e2e/test_first_run_conversation.py tests/e2e/test_guardian_contact.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/personal/store.py src/cheongeum/personal/dialogue.py src/cheongeum/orchestrator/session.py src/cheongeum/speech/phrasing.py tests/unit/test_call_name.py tests/e2e/test_first_run_conversation.py
git commit -m "feat: remember what to call the user on a personal PC and greet by name"
```

---

### Task 4: Key test call

**Files:**
- Create: `src/cheongeum/server/key_check.py`
- Modify: `src/cheongeum/server/app.py` (`POST /api/settings/check-key`)
- Test: `tests/unit/test_key_check.py` (new)

**Interfaces:**
- Produces:
  - `async def check_openai_key(key: str, base_url: str, *, timeout: float = 8.0) -> Literal["ok", "invalid", "quota", "network"]`: one `GET {base_url}/models` with `Authorization: Bearer {key}`. 2xx → `ok`; 401, 403 → `invalid`; 429 → `quota`; any other status or `httpx.HTTPError` → `network`.
  - `POST /api/settings/check-key` body `{"apiKey": str}` → `{"result": <above>}`. Validates the key with `SettingsInput.key_format` rules (bad format → `400 INVALID_SETTINGS`). `base_url` = `runtime.config.voice.baseUrl`. The response never contains the key.

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.parametrize(("status", "expected"), [(200, "ok"), (401, "invalid"), (403, "invalid"), (429, "quota"), (500, "network")])
async def test_key_check_maps_status(http_mock, status, expected):
    def handle(req):
        assert req.url.path.endswith("/models") and req.headers["Authorization"] == "Bearer sk-test"
        return httpx.Response(status, json={})
    calls = http_mock(handle)
    assert await check_openai_key("sk-test", "https://api.openai.com/v1") == expected
    assert len(calls) == 1

async def test_key_check_network_error(http_mock):
    http_mock(lambda req: (_ for _ in ()).throw(httpx.ConnectError("down")))
    assert await check_openai_key("sk-test", "https://api.openai.com/v1") == "network"

async def test_check_key_endpoint_never_echoes_the_key(http_mock, tmp_path): ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/unit/test_key_check.py -v`
Expected: FAIL (`ModuleNotFoundError: cheongeum.server.key_check`).

- [ ] **Step 3: Implement** with the shared httpx client pattern the project uses for outbound calls (see `core/llm.py`).

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest tests/unit/test_key_check.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/server/key_check.py src/cheongeum/server/app.py tests/unit/test_key_check.py
git commit -m "feat: test the OpenAI key during setup"
```

---

### Task 5: Recorded setup clips

**Files:**
- Create: `src/cheongeum/web/static/setup-audio/manifest.json`
- Create: `src/cheongeum/web/static/setup-audio/<lang>/<id>.mp3` (generated)
- Create: `scripts/record_setup_clips.py`
- Test: `tests/unit/test_setup_clips.py` (new)

**Interfaces:**
- Produces: `manifest.json` = `{"<id>": {"ko": "...", "en": "...", "zh": "...", "ja": "..."}}`. The wizard reads screen text from this file, so screen text and clip text cannot drift. Language-option ids carry only their own language.

| id | ko text (exact) |
| --- | --- |
| `lang-ko` (ko only) | 한국어는 1번 |
| `lang-en` (en only) | English, press 2 |
| `lang-zh` (zh only) | 中文请按3 |
| `lang-ja` (ja only) | 日本語は4番 |
| `who` | 지금 누가 설정하고 계세요? 사용하실 분 본인이면 1번, 가족이나 복지관 직원이면 2번. |
| `key-alone` | API 키를 복사해 두셨으면 Ctrl과 V를 함께 누르고 Enter를 눌러 주세요. 키가 없으면 가족이나 복지관에 키 등록을 부탁해 주세요. |
| `key-checking` | 키를 확인하고 있어요. |
| `key-invalid` | 키가 맞지 않아요. |
| `key-quota` | 사용 한도를 넘었어요. |
| `key-network` | 인터넷 연결을 확인해 주세요. |
| `pc` | 이 컴퓨터를 혼자 쓰시면 1번, 여러 사람이 쓰면 2번. |
| `handover` | 이제 사용하실 분께 넘겨 주세요. 준비되면 Enter를 눌러 주세요. |

en/zh/ja texts: the implementer translates; flag them in the PR for a native-speaker check.

- `scripts/record_setup_clips.py [--force] [--lang ko|en|zh|ja]`: reads the manifest, synthesizes each missing clip with the configured TTS (`.env`, same voice as 청음, pace 1.0), writes `<lang>/<id>.mp3`.

- [ ] **Step 1: Write the failing tests**

```python
def test_every_manifest_entry_has_a_clip_for_each_of_its_languages():
    for clip_id, texts in MANIFEST.items():
        for lang, text in texts.items():
            path = AUDIO / lang / f"{clip_id}.mp3"
            assert text.strip() and path.stat().st_size > 0, (clip_id, lang)

def test_shared_steps_exist_in_all_four_languages():
    for clip_id, texts in MANIFEST.items():
        if not clip_id.startswith("lang-"):
            assert set(texts) == {"ko", "en", "zh", "ja"}, clip_id
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/unit/test_setup_clips.py -v`
Expected: FAIL (manifest missing).

- [ ] **Step 3: Write the manifest and the script; run** `uv run python scripts/record_setup_clips.py` (needs the `.env` key).

- [ ] **Step 4: Run the test and confirm packaging**

Run: `uv run pytest tests/unit/test_setup_clips.py -v` → PASS.
Run: `uv build --wheel` then list the wheel (`python -m zipfile -l dist/*.whl | grep setup-audio`) → every clip is listed. If not, add the path to the build config's included files.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/web/static/setup-audio scripts/record_setup_clips.py tests/unit/test_setup_clips.py
git commit -m "feat: add recorded setup clips in four languages"
```

---

### Task 6: Setup wizard, Stage 1 core (language, who, key, PC, save)

**Files:**
- Create: `src/cheongeum/web/static/first-run.js`
- Modify: `src/cheongeum/web/static/index.html` (new `<dialog id="first-run">`, one `<section data-step>` per step, a polite live region)
- Modify: `src/cheongeum/web/static/styles.css`
- Modify: `src/cheongeum/web/static/app.js` (`start()`: when `health.setupRequired`, open the wizard instead of `openSettings(true)`)
- Modify: `src/cheongeum/web/static/api.js` (`checkKey(apiKey)`)
- Test: `tests/e2e/test_first_run_ui.py` (new)

**Interfaces:**
- Consumes: `POST /api/settings/check-key` (Task 4), `POST /api/settings` with `KEY_REQUIRED` (Task 1), clip manifest (Task 5).
- Produces:
  - `export function createFirstRun({ api, desktop, speak, onConsentReady })` → `{ open(stage: 1 | 2, prefill?: object): void }`. `speak(text, lang)` is app.js's server-TTS path (used from Stage 2). `onConsentReady()` is called after Stage 2 and runs app.js `chooseSession()`.
  - Steps (`data-step`): `language`, `who`, `key`, `pc`, then helper-only steps from Task 7, then `handover` (helper path), then Stage 2 (Task 8).
  - On entering a step: focus its heading, announce its text in the live region, play its clip (`/setup-audio/<lang>/<id>.mp3`). Answering stops the clip.
  - Key handling carries the step id it was pressed on and is ignored if the step already changed, and the wizard ignores input for the 250 ms step transition (Review Focus 5).
  - Esc goes back one step, never before `language`.
  - Key step: check-key first (`key-checking` clip), then on `ok` continue; otherwise play `key-<result>` and stay with focus in the key field. On the helper path the step also shows a **키 받는 방법** link to `https://platform.openai.com/api-keys` and the note "OpenAI 계정에서 사용 한도를 정해 두세요."
  - The alone path saves settings after `pc` with `browser: "separate"`; the helper path saves after Task 7's steps.

- [ ] **Step 1: Write the failing tests** (Playwright against the real server. Add a `first_run_ui` fixture in this file, copied from the `ui_url` fixture in `tests/e2e/test_web_ui.py`, with `runtime.settings = SettingsStore(tmp_path / "preferences.json")`; route `**/api/settings/check-key` and `**/api/audio/speak` in the page)

```python
async def test_user_alone_finishes_stage1_with_keys_only(first_run_ui, page): ...
    # keys: "1" (한국어), "1" (본인), type key + Enter, "1" (혼자) → section[data-step=sound] visible
    # preferences.json: deviceUse personal, browser separate, firstRun stage2

async def test_wrong_key_stays_on_key_step_with_reason(first_run_ui, page): ...
    # check-key → {"result": "invalid"} → live region has "키가 맞지 않아요", focus in key input, step still key

async def test_double_key_press_answers_one_step(first_run_ui, page): ...
    # press "1" twice within 50 ms on language → current step is who, no answer recorded for who

async def test_each_step_moves_focus_to_its_heading(first_run_ui, page): ...

async def test_esc_goes_back_one_step(first_run_ui, page): ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/e2e/test_first_run_ui.py -v`
Expected: FAIL (no `#first-run` dialog).

- [ ] **Step 3: Implement** the interfaces above. Keep the existing settings dialog for later edits; it is no longer opened on first run.

- [ ] **Step 4: Run the new tests and the web UI suite**

Run: `uv run pytest tests/e2e/test_first_run_ui.py tests/e2e/test_web_ui.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/web/static tests/e2e/test_first_run_ui.py
git commit -m "feat: first-run wizard for language, helper or user, key and PC type"
```

---

### Task 7: Helper extras — browser, auto-start, guardian

**Files:**
- Modify: `src/cheongeum/web/static/first-run.js`, `index.html`
- Modify: `src/cheongeum/web/static/app.js` (settings dialog: browser select, auto-start checkbox shown only with `desktop`, fallback note from `browserFallback`)
- Modify: `apps/desktop/preload.cjs`, `apps/desktop/main.cjs`
- Modify: `src/cheongeum/server/app.py` (`POST /api/personal/guardian`)
- Test: `tests/e2e/test_first_run_ui.py`, `tests/e2e/test_guardian_contact.py`

**Interfaces:**
- Consumes: `AgentRuntime.personal_store()` (Task 2), `PersonalStore.set_guardian`.
- Produces:
  - Helper path order: `key` → `pc` → `browser` (personal PC and desktop only) → `autostart` (desktop only) → save settings → `guardian` (personal PC only, skippable) → `handover`.
  - `cheongeumDesktop.setAutoStart(on: boolean)` and `cheongeumDesktop.getAutoStart(): Promise<boolean>` in `preload.cjs`; `main.cjs` accepts them only `fromController(e)`, checks `typeof on === "boolean"`, calls `app.setLoginItemSettings({ openAtLogin: on })` / returns `app.getLoginItemSettings().openAtLogin`.
  - `POST /api/personal/guardian {name, phone}` → `{saved: true}`; `409 NOT_PERSONAL` when `personal_store()` is `None`; `400` when the phone fails `MOBILE` from `personal/store.py`. Never echoes the values.

- [ ] **Step 1: Write the failing tests**

```python
async def test_helper_path_saves_extras_then_hands_over(first_run_ui, page): ...
    # "1","2", key, "1" (personal), browser "chrome", guardian 홍길동 / 01011223344 → handover step visible
    # preferences.json browser chrome; personal store guardian == {"name": "홍길동", "phone": "01011223344"}

async def test_shared_pc_skips_browser_and_guardian(first_run_ui, page): ...

async def test_guardian_endpoint_refuses_on_shared_pc(...): ...   # in test_guardian_contact.py
```

Auto-start is covered by the desktop check in Step 4, not by pytest.

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/e2e/test_first_run_ui.py -k "helper or shared" tests/e2e/test_guardian_contact.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run tests and check auto-start in the desktop app**

Run: `uv run pytest tests/e2e/test_first_run_ui.py tests/e2e/test_guardian_contact.py -v` → PASS.
Run: `npm --prefix apps/desktop start` with a fresh `CHEONGEUM_SETTINGS_DIR`; on the helper path turn auto-start on; confirm Windows **설정 → 앱 → 시작 프로그램** lists 청음; turn it off in the settings dialog and confirm it disappears.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/web/static src/cheongeum/server/app.py apps/desktop/preload.cjs apps/desktop/main.cjs tests/e2e/test_first_run_ui.py tests/e2e/test_guardian_contact.py
git commit -m "feat: helper setup for browser, auto-start and guardian"
```

---

### Task 8: Stage 2 — sound check, speed, consent hand-off, resume

**Files:**
- Modify: `src/cheongeum/web/static/first-run.js`, `index.html`
- Modify: `src/cheongeum/web/static/app.js` (`start()`: `health.firstRun === "stage2"` → `firstRun.open(2)`)
- Modify: `docs/install.md` (first-run section replaces the settings-form paragraph)
- Test: `tests/e2e/test_first_run_ui.py`

**Interfaces:**
- Consumes: `createFirstRun` (Task 6), `health.firstRun` (Task 1).
- Produces:
  - `sound` step: speaks "제 목소리가 들리시면 Enter를 눌러 주세요." Enter → `speed`; Space replays; after the third replay without Enter, the existing **소리 확인** button is shown in the step.
  - `speed` step: speaks "이 정도 빠르기면 괜찮으세요? 더 천천히는 1번, 그대로는 2번, 더 빠르게는 3번." 1 and 3 move one notch in `[0.85, 1, 1.35, 1.6]` and replay; 2 saves via `POST /api/settings` (current prefs, `apiKey: ""`) and calls `onConsentReady()`.

- [ ] **Step 1: Write the failing tests**

```python
async def test_speed_keys_change_and_save_speed(first_run_ui, page): ...
    # settings saved (firstRun stage2) → load page → sound step; Enter → speed; "3" → "2" → preferences speed == 1.6
    # consent panel visible afterwards

async def test_reopening_in_stage2_resumes_at_sound_check(first_run_ui, page): ...
    # preferences.json completed with firstRun "stage2" → load → section[data-step=sound] visible, language step never shown

async def test_three_replays_show_the_sound_check_button(first_run_ui, page): ...
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/e2e/test_first_run_ui.py -k "speed or stage2 or replays" -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above and update `docs/install.md`.

- [ ] **Step 4: Run to verify they pass**

Run: `uv run pytest tests/e2e/test_first_run_ui.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/web/static docs/install.md tests/e2e/test_first_run_ui.py
git commit -m "feat: sound check and speed before consent, resumable"
```

---

### Task 9: Stage 3 text, name parsing, and the dialogue slot

**Files:**
- Create: `src/cheongeum/orchestrator/first_run.py` (text tables and pure helpers in this task; the guide class in Task 10)
- Modify: `src/cheongeum/core/dialogue.py`
- Test: `tests/unit/test_first_run_text.py` (new), `tests/unit/test_dialogue.py`

**Interfaces:**
- Produces:
  - `LINES: dict[str, dict[Lang, str]]` with keys `mic`, `mic-heard`, `mic-none`, `name`, `name-confirm`, `name-shared`, `stop-practice`, `stop-praise`, `practice-offer`, `practice-no`. Korean copy (exact):
    - `mic`: "이제 제가 들어 볼게요. 말하기 단축키 Ctrl, Shift, 스페이스를 누르고 '안녕하세요'라고 말해 보세요." ("안녕하세요" instead of the spec's "안녕 청음아", because `strip_address` would remove the call word before the guide sees it.)
    - `mic-heard`: "'{heard}'라고 들었어요. 잘 들려요!"
    - `mic-none`: "소리가 들어오지 않았어요. 마이크가 연결됐는지 확인해 주세요. 건너뛰려면 '건너뛰기'라고 해 주세요."
    - `name`: "어떻게 불러 드릴까요? 이름을 말씀해 주시거나 '건너뛰기'라고 해 주세요."
    - `name-confirm`: "{name}이라고 부를게요. 맞으면 '네'라고 해 주세요." (`{name}` is `speak_call_name(...)`, which always ends in 님, so 이라고 is always right)
    - `name-shared`: "이 컴퓨터는 여럿이 쓰셔서 이름은 이번에만 기억할게요."
    - `stop-practice`: "제가 말하는 도중에도 '멈춰'라고 하면 바로 멈춰요. 지금 한번 '멈춰'라고 해 보세요."
    - `stop-praise`: "잘하셨어요! 이렇게 멈춰요. 이제 제 소개를 들어 보실래요? 말하기 단축키를 누르고 '네'라고 해 주세요."
    - `practice-offer`: "연습용 신청서로 한 번 해 볼까요? 진짜로 제출되지는 않아요."
    - `practice-no`: "언제든 '청음아'하고 불러 주세요."
  - `INTRO: list[tuple[str, dict[Lang, str]]]` — `(pose, texts)` in the spec's order with poses `welcome`, `listening`, `screen-reading`, `confirmation`, `auth-handoff`, `stopped`, `complete` (all present in `cheongeum-avatar.glb`). Line 1 contains `{name}`; `INTRO_NONAME: dict[Lang, str]` replaces line 1 when there is no call name. Copy: the spec's introduction table.
  - `call_name_from(text: str) -> str | None`: strips 군말 and endings (`이라고 불러 줘`, `라고 해 줘`, `입니다`, `이에요`, `예요`, `요`, trailing `님`); returns `None` for skip words (`건너뛰기`, `건너뛸게`, `없어`, `싫어`, `안 할래`) or when the rest is empty or longer than 20 characters.
  - `DialogueState.first_run -> str | None` (property), `ask_first_run(step: str) -> None`, `end_first_run() -> None`; `stop()` clears it; `has_pending_interaction` includes it. Docstrings name their callers (`FirstRunGuide`, `SessionOrchestrator._stop`).

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.parametrize(("said", "name"), [
    ("홍길동", "홍길동"), ("홍길동이라고 불러 줘", "홍길동"), ("길동님", "길동"), ("음 김하늘이에요", "김하늘"),
    ("건너뛰기", None), ("싫어", None), ("가" * 25, None),
])
def test_call_name_from(said, name):
    assert call_name_from(said) == name

def test_every_line_and_intro_line_has_four_languages(): ...
def test_intro_poses_exist_in_the_avatar_model(): ...   # read glb clip names like the plan's recon script
def test_stop_clears_the_first_run_slot(): ...          # in test_dialogue.py
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/unit/test_first_run_text.py tests/unit/test_dialogue.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement.** Write en/zh/ja copy; flag for native review in the PR.

- [ ] **Step 4: Run to verify they pass**, plus `uv run pytest tests/unit/test_layers.py` (new module must respect import direction).

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/orchestrator/first_run.py src/cheongeum/core/dialogue.py tests/unit/test_first_run_text.py tests/unit/test_dialogue.py
git commit -m "feat: first-run conversation text, name parsing and dialogue slot"
```

---

### Task 10: Stage 3 conversation in the session

**Files:**
- Modify: `src/cheongeum/orchestrator/first_run.py` (`FirstRunGuide`)
- Modify: `src/cheongeum/orchestrator/session.py` (construct guide; `consent_to`; `handle_turn` `work()`; `_stop`)
- Modify: `src/cheongeum/server/runtime.py` (`OrchestratorDeps.first_run_step`, `OrchestratorDeps.first_run_progress`)
- Modify: `CLAUDE.md` (Architecture: one line for `FirstRunGuide` and the turn-order position; one line for `personal_enabled()`)
- Test: `tests/e2e/test_first_run_conversation.py`

**Interfaces:**
- Consumes: `LINES`, `call_name_from`, `DialogueState.first_run`/`ask_first_run`/`end_first_run` (Task 9); `remember_call_name`, `call_name` (Task 3); `SettingsStore.first_run`/`set_first_run` (Task 1).
- Produces:
  - `OrchestratorDeps.first_run_step: str | None` (from `settings.first_run` when it is not `"done"`), `OrchestratorDeps.first_run_progress: Callable[[str], None] | None` (`settings.set_first_run`).
  - `class FirstRunGuide` constructed once in `SessionOrchestrator.__init__` with `(dialogue, session callbacks for call name, progress, lang getter)`.
  - `FirstRunGuide.begin() -> str | None`: when `first_run_step` is `stage2` or a Stage 3 step, sets the slot to that step (`stage2` → `mic`), records progress, returns the step's sentence. `consent_to(True)` appends it to its reply.
  - `FirstRunGuide.answer(text: str) -> dict | None`: a draft for the current step, or `None` when the text is another command (rules parse not `UNKNOWN`), in which case the guide ends (`end_first_run`, progress kept for one resume) and the turn continues normally. In `handle_turn`'s `work()`, it runs first, before `_process`.
  - Step behavior: `mic` any text → `mic-heard` + `name`; `name` → `call_name_from`; `None` → `stop`; name → `name-confirm` (slot `name-confirm`); yes (`short_reply_kind` for ko, `foreign_confirmation` otherwise) → `remember_call_name`, add `name-shared` when it returns `False`, then `stop-practice`; no → `name` again. `practice` yes → `end_first_run`, progress `done`, then the same handling as the user saying "연습 신청서 열어줘"; no → `practice-no`, progress `done`.
  - `FirstRunGuide.after_stop() -> str | None`: called by `_stop` before `dialogue.stop()`; when the step is `stop`, returns `stop-praise`. `_stop` speaks it instead of the usual stop sentence and, after `dialogue.stop()`, calls `dialogue.ask_first_run("intro")`. At the `intro` step, yes → `intro_draft()` (Task 11); skip or no → `practice-offer` (slot `practice`).
  - Each step change calls `first_run_progress(step)` with a `FIRST_RUN_STEPS` value (`name-confirm` records `name`).

- [ ] **Step 1: Write the failing tests**

```python
async def test_consent_on_first_run_starts_the_mic_check(first_run_session): ...
    # deps.first_run_step="stage2" → consent_to(True)["speech"] ends with LINES["mic"]["ko"]; progress == ["mic"]

async def test_name_saved_on_personal_pc_after_yes(first_run_session): ...
    # "안녕하세요" → "홍길동이라고 불러 줘" → "네" → personal.call_name() == "홍길동"; speech contains stop-practice

async def test_name_on_shared_pc_is_session_only_and_not_greeted_next_time(...): ...
    # no personal store → speech contains name-shared; new session consent reply has no "홍길동"

async def test_stop_on_the_stop_step_praises_then_yes_plays_the_intro(first_run_session): ...
    # at stop step, "멈춰" → speech == stop-praise, dialogue.first_run == "intro"; "네" → result has introScript

async def test_another_command_ends_the_guide_and_runs_it(first_run_session): ...
    # at name step, "복지로 열어줘" → OPEN_SITE result, dialogue.first_run is None

async def test_reopened_session_resumes_at_recorded_step_once(...): ...
    # progress "name" → new session consent → name sentence; after finishing, progress "done"

async def test_practice_yes_opens_the_practice_form(first_run_session): ...
```

`first_run_session` is a new fixture in this file built on `new_session` with `first_run_step` and a list-backed `first_run_progress`.

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/e2e/test_first_run_conversation.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above. Keep `session.py` changes to construction, three call sites and the deps fields; logic lives in `first_run.py`.

- [ ] **Step 4: Run the new tests and the conversation suites**

Run: `uv run pytest tests/e2e/test_first_run_conversation.py tests/e2e/test_conversation.py tests/e2e/test_stop_inflight.py tests/unit/test_layers.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum/orchestrator src/cheongeum/server/runtime.py CLAUDE.md tests/e2e/test_first_run_conversation.py
git commit -m "feat: first-run voice steps after consent"
```

---

### Task 11: Introduction of 청음 with avatar animations, replay and restart commands

**Files:**
- Modify: `src/cheongeum/core/turn.py` (`IntroLine`, `TurnResult.introScript`)
- Modify: `src/cheongeum/orchestrator/first_run.py` (`FirstRunGuide.intro_draft()`), `session.py` (route `INTRO_REPLAY`, `SETUP_RESTART`)
- Modify: `src/cheongeum/core/intents.py`, `src/cheongeum/understanding/rules.py`
- Modify: `src/cheongeum/web/static/app.js` (play intro, intro card, `SETUP_RESTART` opens wizard Stage 1 with current values), `index.html` (`#intro-card`), `styles.css`, `companion.js` (`introPose`), `avatar/overlay.js` (`poseFor`)
- Modify: `apps/desktop/test/avatar.e2e.cjs` (scenario `intro`)
- Test: `tests/unit/test_parser.py`, `tests/unit/test_first_run_text.py`, `tests/e2e/test_first_run_ui.py`

**Interfaces:**
- Consumes: `INTRO` (Task 9), `FirstRunGuide` (Task 10), `SessionOrchestrator.call_name` (Task 3).
- Produces:
  - `class IntroLine(_M): text: str; pose: Literal["welcome", "listening", "screen-reading", "confirmation", "auth-handoff", "stopped", "complete"]`; `TurnResult.introScript: Optional[list[IntroLine]] = None`.
  - `FirstRunGuide.intro_draft(*, replay: bool = False) -> dict`: draft with `speech` = all lines joined plus `practice-offer`, `introScript` = the 7 lines in the session language, slot set to `practice`, progress `intro`. Called for yes at the `intro` step, and with `replay=True` for `INTRO_REPLAY` (no `practice-offer`, no slot, no progress).
  - Intents: `INTRO_REPLAY` ("청음 소개 다시 해줘", "청음 소개해줘"), `SETUP_RESTART` ("설정 다시 해줘", "처음 설정 다시 할래"); both `llm=False`; `SETUP_RESTART` `before_consent=True`.
  - app.js: when `r.introScript`, play the lines one at a time with server TTS; for each line set `desk.introPose = line.pose`, show `#intro-card` (text + `/avatar/poses/<pose>.webp`; `complete` uses `complete.webp`, `welcome` uses `ready.webp`), publish the desktop view; then speak `practice-offer`. Esc or the card's **건너뛰기** stops playback, clears `introPose`, and speaks `practice-offer`.
  - `desktopView(ui, live)` adds `introPose: live.introPose ?? null`. overlay `poseFor(s)` returns `s.introPose` first, and the "speaking always wins" rule does not apply while `introPose` is set. Reduced motion and the still setting keep today's still-image path.

- [ ] **Step 1: Write the failing tests**

```python
def test_intro_and_restart_phrases_parse():                      # test_parser.py
    assert parse("청음 소개 다시 해줘")["type"] == "INTRO_REPLAY"
    assert parse("설정 다시 해줘")["type"] == "SETUP_RESTART"

def test_intro_draft_is_a_valid_turn_result(): ...                # 7 lines, poses in order, parse_turn_result accepts

async def test_intro_shows_one_card_per_line_and_esc_skips(first_run_ui, page): ...
    # route speak; trigger a turn result with introScript; card text equals line 1 then line 2; Esc → card hidden, practice offer spoken
```

Desktop scenario `intro` in `avatar.e2e.cjs`: feed a snapshot sequence with `introPose` values; assert the overlay's `data-pose` follows `welcome, listening, screen-reading, confirmation, auth-handoff, stopped, complete`; with reduced motion assert the figure stays `still`.

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/unit/test_parser.py -k intro tests/unit/test_first_run_text.py tests/e2e/test_first_run_ui.py -k intro -v`
Expected: FAIL.

- [ ] **Step 3: Implement** the interfaces above.

- [ ] **Step 4: Run all checks**

Run: `uv run pytest tests/unit tests/e2e/test_first_run_ui.py tests/e2e/test_first_run_conversation.py tests/e2e/test_avatar.py tests/e2e/test_avatar_animation.py -v` → PASS.
Run: `npm --prefix apps/desktop run test:avatar intro` → PASS (a window opens).

- [ ] **Step 5: Commit**

```bash
git add src/cheongeum apps/desktop/test/avatar.e2e.cjs tests
git commit -m "feat: animated introduction of 청음 with replay and setup restart"
```

---

### Task 12: Whole-feature verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `uv run pytest`
Expected: all pass.

- [ ] **Step 2: Manual run, helper path.** Fresh `CHEONGEUM_SETTINGS_DIR` and `CHEONGEUM_DATA_DIR`; `npm --prefix apps/desktop start`. Walk the helper path to the handover, then as the user: sound check, speed, consent, mic check, name, "멈춰", introduction (watch the corner avatar), practice offer "네" opens the practice form.

- [ ] **Step 3: Manual run, user alone, screen not used.** Same with Windows Narrator on, eyes off the screen: finish with keys and voice only.

- [ ] **Step 4: Manual run, interruptions.** Close the app during Stage 2 and during Stage 3; reopen and confirm each resumes once at the right step. Decline consent and confirm the declined mode.

- [ ] **Step 5: Report** results with any failures quoted, then hand over for review.
