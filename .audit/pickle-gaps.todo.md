# pickle gaps: todo

Source: `reports/피클 AI 에이전트 청음 적용 검토.md` (Pickle research, 2026-11-18) and the notes in `research_notes/피클 AI 에이전트 청음 적용 검토/`. Every item below was checked against the code on 2026-11-18: 청음 does not have it yet.

Status: **final checks.** All items landed. Final suite + scenarios + Windows installer done. Awaiting owner commit yes/no.

Effort: S = one or two modules plus tests. M = several modules or a new server-to-UI channel. L = new subsystem, vendor, or policy work.

## Owner decisions (2026-11-18)

| Topic | Decision |
|---|---|
| `READ_ONLY_CLICKS` default when `feat/navigation` merges | `any` (click everything). Conflicts with the 2026-11-18 go-word rule for important buttons on real sites, and U1's risk floor covers the `full` tier only. Owner chose this knowingly. |
| U7, things 청음 can't do | Say it can't, speak the matching official contact number first (that service's, else 129), then 2 to 3 things it can do instead. |
| 18 Phone client | Skip. |
| 19 Phone calls | No calls. Read the user a short script and the number so they call themselves. |
| 20 Scheduled tasks | Reliable reminders only (planned A6). No background tasks. |
| 21 Mail and calendar | Skip. |
| 22 Camera reading | Skip. |
| 23 Faster replies | Safe version: rules parser on the browser's partial results, commit at end of turn. Nothing new leaves the PC. |
| 24 간편인증 | Include: name the app, wait for "인증 끝났어", re-check the page. |
| 1 Progress | On by default. At most one sentence every 15 seconds. Quiet while the user talks. |
| 2 Approval expiry | 2 minutes. |
| 9 Speech preferences | Speed, answer length, voice, progress on/off. Not 존댓말/반말. |
| 10 Action log | Encrypted file on the PC, kept 30 days. Answers repo decision 5. |
| 11 Vault | Encrypt with an OS-held key. Losing the OS profile loses the vault (accepted). |
| 12 Saved values to sites | Ask per site the first time, and route guided-fill values through `_approve`. |
| 15 Models | Allow mixing providers per role. |
| 16 Documents | PDF and HWPX. |
| 17 Installer | Windows and macOS. Unsigned. No auto-update; update by running a new installer. |
| Commits | None during the build. At the end: run every build and test, review with pstack skills, then ask the owner yes or no for the final commit. |

## Build order

- [x] 0. Bring in `feat/navigation` (28 uncommitted files in `C:\Users\user\Desktop\voice-welfare-nav`) with `READ_ONLY_CLICKS=any`. Resolve overlaps with U1 to U5. Full suite passes.
  - Ported with `.audit/navport.py` (3-way merge after the ieum→cheongeum rename). 10 conflicts resolved by hand. Login keeps U5's go-word gate under `any` (guard check moved outside the `safe` branch, new test `test_read_only_any_clicks_still_asks_before_login`). `follow_link`, `point_at`, `click_approved` share one ref-based `_locate`; `click_approved` refuses if the approved ref is gone. U5's login flow replaces nav's links-only login. 721 tests pass.
- [x] Items 1–7 landed.
- [x] Items 8–17, 19, 20, 23, 24 landed (17 = electron-builder scaffolding + install docs; full offline Python bundle deferred).
- [x] Final builds: `uv sync` ok; `uv run pytest` 851+ passed (PASS boundary fix retested); `scripts/run_scenarios.py` ok (completion/grounding/RAG/axe clean); Windows installer `apps/desktop/dist/청음-Setup-0.1.0.exe` built after fixing electron-builder.yml (invalid empty signing fields). macOS dmg not built on this Windows machine.
- [x] Review: thermo-nuclear / cavecrew subagents aborted by the harness; manual review of approval.py, seal.py, action_log.py, auth_page.py, agent._run. One bug fixed: `\bPASS\b` missed `PASS로` (Hangul is a word char in Python). Blast radius: approval.py → session `_approve` + form/browse ask paths + e2e safety; seal.py → PersonalStore + ActionLog + runtime data dir; progress.py → session progress reply + GET /progress + speaker.js; auth_page.py → BrowseSkill login/auth_done + item 24 app names; action_log → WebExecutionAgent._run only.
- [ ] Commit yes/no (owner).

## Tier A. Fits today's code and rules

- [x] 1. Spoken progress, and an answer to "지금 어디까지 했어?" (M)
  - Pickle: lists steps on screen, but could not answer "언제 완료되느냐". Statuses: Working, Waiting, Done, Failed, Canceled.
  - Today: `Autopilot.run` takes `on_step`, but `BrowseSkill.run_goal` calls `pilot.run(goal, ctx)` without it. The UI shows only '처리 중…'.
  - Change: pass `on_step` into a per-session progress buffer. Code builds each step sentence from action type, target name, and host, never page text or model text. Expose it over a poll or SSE endpoint in `server/app.py`. `speaker.js` speaks the latest step at most once every 15 seconds, on by default, quiet while the user talks. Answer "지금 어디까지 했어?" from the buffer before the turn queue. Switch with item 9.
  - Keep `on_step` off the X7 dead-code cut list in `drafts/research results/agent skills tools - fit for cheongeum.md`.
  - Done when: a goal run speaks its steps, "지금 어디까지 했어?" mid-run names the current step, and "멈춰" still interrupts.

- [x] 2. Approvals tied to what was read aloud, cancelled on change, 2-minute expiry (S–M)
  - Pickle: proceeds only within what was agreed. If the price rises, it says by how much and asks again. Hand-off cards expire.
  - Today: approvals are action ids granted in `SessionOrchestrator._approve`. Nothing checks that the page, target, or values still match when "응" arrives. No expiry exists.
  - Change: store a fingerprint (action type, target role and name, origin and path, field ids with value hashes, the spoken sentence) with each pending approval. Re-observe and compare just before `adapter.execute`. On a mismatch, cancel and speak the difference in a code-built sentence. After 2 minutes, read the summary again before acting.
  - Done when: a test changes a field value between the read-back and "응", and the action does not run. A test approves after 2 minutes and hears the summary again.

- [x] 3. No automatic retry of important actions (S)
  - Pickle: after a dropped screen it checks whether payment went through before retrying, and stops after the same error twice.
  - Today: `WebExecutionAgent._run` retries any TIMEOUT once (`MAX_TIMEOUT_RETRIES = 1`), whatever the risk.
  - Change: skip the retry for any action that is not low risk or that needed approval. Re-observe for the site profile's success marker and say "접수됐는지 확인하지 못했어요. 다시 할까요?".
  - Done when: a mock submit that times out is not sent twice.

- [x] 4. "다 했어" re-checks the page and resumes (S–M)
  - Pickle: "I'm done" after a take-over, or PASS done on the phone, and the task continues from that screen.
  - Today: `BrowseSkill.auth_done` checks nothing.
  - Change: at hand-off, focus the first field the user must fill and pause TTS so it doesn't talk over the screen reader. On "다 했어" or "인증 끝났어", re-observe. If the page is still a login or verification page, say so and keep waiting. Otherwise speak the new title and resume the pending task.
  - Depends on: U5 (real-site login after a spoken go-ahead uses the same flow).
  - Done when: an e2e test hands off on the practice login page and resumes only after the page changes. Test with NVDA and 센스리더 in the user test.
  - Landed: `agents/web/auth_page.py` (`auth_page_kind` login|verification|other for item 24), hand-off focuses first fill field + UI pauses TTS after one AUTH_HANDOFF line, `auth_done` re-observes and resumes `auth_resume`. E2E: `test_auth_done_stays_while_login_page_unchanged`, `test_auth_done_speaks_title_and_resumes_pending_form` (practice login stays put until `goto` apply.html).

- [x] 5. Three-way result wording: confirmed, nothing changed, couldn't confirm (S)
  - Pickle: reported a message as delivered after the other person hung up, and reported a seat that 코레일톡 did not show.
  - Today: the check that an action changed the page exists only in `feat/navigation`. Fixture answers are labelled "API 실시간" (C13).
  - Change: every action reply uses one of the three code-built forms. Fixture answers say "저장된 자료 기준".
  - Depends on: step 0.
  - Done: `press_result` / `unconfirmed_message` / `click_note` in `agents/web/effect.py` (re-exported from `skills/common.py`). browse follow_link·click_approved, form ask_again/fill_confirmed, autopilot click notes share them. Fixture·API-fallback sources say "저장된 자료 기준".

- [x] 6. Deadline check for "지금 신청할 수 있어?" (S)
  - Pickle: recommended a Seoul grant whose applications had already closed.
  - Today: the welfare data has no application-period field (no 신청기간, 접수기간, or 마감 field in `agents/welfare/`).
  - Change: first check which period fields the official API returns. Answer yes or no only when the official text has a period or deadline compared against today. Otherwise say it couldn't be confirmed and give the service contact that `prepare` already extracts.

- [x] 7. Hide personal data in page text before it goes to the LLM (S–M)
  - Pickle: hides filled secrets in the page text the model reads, enforced in the browser tools.
  - Today: `page_for_llm` sends 1,500 characters of page text per goal step and `BrowseSkill.web_answer` sends up to 3,000, neither through `redact_text`. Vault values read aloud can enter `_history` and then the LLM prompt.
  - Change: run `redact_text` over page text in `digest_for_llm` and `web_answer`. Keep the unredacted copy only for the local `check_grounding`. Replace vault values in assistant turns with `[비공개]` before `_history`.
  - Done when: a page with a resident-number pattern produces an LLM payload without it, and grounded answers still pass.

- [x] 8. Every dead end gives a next step, plus a one-time warning on sites that ban automation (S)
  - Pickle: offers another route when something can't connect. Meanwhile 정부24 suspends macro users (1 month, then 3, then permanently) and 코레일 blocked Pickle.
  - Today: `blocked` pages are reported with no next step. `HELP_HUMAN` returns a fixed sentence with 129.
  - Change: follow the U7 decision: say it can't, speak the matching official contact number first, then 2 to 3 things it can do. Give each site playbook entry (복지로, 정부24 first) an alternative route per obstacle and an `automationNotice`, spoken once per session through `Narrator.once`. Route blocked pages and policy denials through `skills/common.py`.
  - Overlaps: planned A2 (site playbooks) and A5 (hand-off to a person). If the other session builds U7 first, extend it instead.

- [x] 9. Speech preferences set by voice: speed, answer length, voice, progress on/off (S)
  - Pickle: users pick the agent's voice and speech style.
  - Today: browser speech is fixed at `rate = 1.25` in `speaker.js`. The server TTS voice is fixed in `VoiceConfig` at startup.
  - Change: "천천히/빨리 말해줘", "짧게/자세히", voice choice (browser voices or the server TTS voice list), and "진행 상황 말해줘/조용히" (item 1). Stored in the vault file and listed and deleted with the existing vault commands. Same as planned A3. No 반말 option.
  - Landed: `PersonalStore.speech` in the vault file; `parse_speech_pref` + `PersonalDialogue` speech-*; session wires `Progress.spoken` and returns `speechPrefs` on every turn; `speaker.js` `applySpeechPrefs` for rate/voice; short answers trim to two sentences when length=short.

## Tier B. Needs a design pass

- [x] 10. Action log written before each action, read back by voice (M)
  - Pickle: a signed, hash-chained record is written before any credential use, kept 365 days, and checked in the app.
  - Today: one event per action is appended after the turn to a 5,000-entry in-memory deque (`core/events.py`), lost on restart, and served without auth at `GET /api/events`.
  - Change: an encrypted local file (same key as item 11), kept 30 days. In `WebExecutionAgent._run`, append before `adapter.execute` (sequence number, time, host, page kind, action type, code-built label, approval id, previous-line hash), then append the outcome. Refuse an approval-requiring action if the write fails. "오늘 한 일 들려줘" reads the last five entries. Target names go through `redact_text`.
  - Landed: `personal/seal.py` + `action_log.py`; wired in `_run` and runtime when `dataDir` set; voice via `action-log-read`. In-memory `/api/events` kept for PRD metrics.

- [x] 11. Encrypt the vault with an OS-held key (M)
  - Pickle: master key on the phone in iCloud Keychain, Face ID to open the vault.
  - Today: `personal/store.py` writes plain JSON, and the `chmod(0o600)` error is swallowed ("윈도 등").
  - Change: AES-GCM via `cryptography`, key in Windows Credential Manager (DPAPI) or macOS Keychain via `keyring`, both added to `pyproject.toml`. Migrate an existing plain file on first load. Memory-only mode unchanged. Fix the "파일 권한 600" line in `CLAUDE.md`. Document that losing the OS profile loses the vault.
  - Landed: `PersonalStore(..., seal=)` shares `Seal` with the action log; plain files migrate on first load; CLAUDE.md updated.

- [x] 12. Ask before a saved value goes to a site for the first time (S)
  - Pickle: a "Never shared" list only the user can change; per-connection permission off by default.
  - Today: guided fill offers vault values and grants its own approval (`skills/guided.py`), an open question in `.audit/orchestrator-split.md`.
  - Change: the first time a vault value is offered on an origin, name the site ("정부24에 전화번호를 넣을까요?") and remember a per-origin allow, listed and deleted with the vault commands. Send guided-fill values through `_approve`.
  - Landed: `siteAllow` in PersonalStore; guided asks per-origin then routes fills through approval fingerprints; voice list/clear commands.

- [x] 13. "로그아웃해줘" and "로그인 기록 지워줘" (S)
  - Pickle: login cookies outlive the connection grant; disconnecting doesn't log the browser out.
  - Today: `BROWSER_MODE=chrome` keeps logins in `~/.cheongeum/chrome-profile` (`launch_chrome_profile`), with no voice command to clear them.
  - Change: clear the current site's cookies through the Playwright context and read back the cleared hosts. At the first login hand-off in Chrome mode, say once that the login is remembered and how to clear it.
  - Depends on: U5.
  - Landed: `CLEAR_LOGIN` intent; adapter `clear_site_login`; chrome hand-off `narrator.once` tip.

- [x] 14. Recover from false interruptions (M)
  - Pickle (stack inferred): LiveKit resumes after a false interruption (2.0 s default). Its earlier Electron app, Glass, rewrote echo cancellation in Rust.
  - Today: `watchBargeIn` stops TTS when the mic level crosses a threshold. The first 0.6–0.9 s of speech after a barge-in is not recorded (C12). VAD, barge-in, and claps have no tests.
  - Change: keep a rolling one-second pre-roll buffer in `mic.js`. If nothing is recognized within about two seconds of a barge-in, resume TTS from the interrupted chunk in `speaker.js`. Keep U2's `stopOnly` listening intact.
  - Landed: mic preroll + `listenAfterBarge`; server TTS resume from interrupted chunk; conversation loop restores TTS on empty/failed STT.

- [x] 15. Per-role models, providers may differ (S–M)
  - Pickle: routes across Google, OpenAI, Anthropic, and xAI plus self-hosted open models.
  - Today: one `LLM_PROVIDER` and `LLM_MODEL` for every schema (`server/runtime.py`). Repo QA: goal mode 9/10 on OpenAI vs 3–5/10 on local Qwen 7B.
  - Change: optional per-role overrides (provider, base URL, model; for example goal steps and web answers vs understanding and chat routing), falling back to the main settings. Model IDs stay in `.env` only. `/api/health` and the consent text say which provider each role uses, so the user hears where text goes.
  - Landed: `LLM_UNDERSTAND_*` / `LLM_GOAL_*` / `LLM_WEB_*`; wired to intent/plan, autopilot, web_answer+screen; health.llmRoles + consent.

- [x] 16. Save downloaded documents and read PDF and HWPX aloud (M)
  - Pickle: delivered the 정부24 주민등록등본 as a PDF at the end of the task.
  - Today: no download handling anywhere in `agents/web/`.
  - Change: handle Playwright downloads into a per-user folder, say the file name and where it was saved, and read text aloud on request through `chunk_text`. PDF via a small pure-Python library; HWPX via `zipfile` and XML (no extra dependency). Old binary HWP: say it can't be read and name the file.
  - Landed: Playwright download listener → `DownloadStore`; `READ_DOWNLOAD`; `docs.py` PDF(pypdf)+HWPX; HWP refused.

- [x] 17. Installers for Windows and macOS (L)
  - Pickle: store builds on iOS and Android, 19 releases between Aug 10 and Nov 8.
  - Today: `apps/desktop/package.json` has only `start`. No electron-builder, PyInstaller, or similar. Setup needs the repo, `uv`, Node, and `playwright install`.
  - Change: bundle Python, the app, and Chromium with the Electron shell. Local models download on first run, with consent. Unsigned, no auto-update. The installer must be usable with NVDA, 센스리더, and VoiceOver. Unsigned builds show SmartScreen and Gatekeeper warnings; document the exact keystrokes to get past them.
  - Landed: `electron-builder.yml`, `npm run dist`/`dist:win`/`dist:mac`, `docs/install.md` (SmartScreen·Gatekeeper keystrokes). Full offline Python/Chromium embed remains a follow-up packaging pass.

## Tier C. Decided

- [x] 19. Call script instead of calls (S). When the user wants a person or a phone-only step, read a short script (who to ask for, what to say, which documents to have ready) and the matching official number, then offer to repeat. No call is placed. Builds on item 8 and planned A5.
  - Already in `playbook.help_human_speech` + `_help_human` (no call; number + script + alternatives).
- [x] 20. Reliable reminders (S). Planned A6: check at startup, work in the web UI as well as the desktop app, stop repeating overdue items after the user acknowledges. Before speaking unprompted at night, offer 지금 / 아침에.
  - Landed: web+desktop `startReminders`; night ask; ack via '알겠어'.
- [x] 23. Faster replies from partial results (M). When the browser's speech recognition is in use, set `interimResults=true`, run the rules parser on partial text, and commit only at end of turn. Discard on change. No effect with server STT.
  - Landed: browser STT interim; partial STOP cancels TTS/turn early; final still commits the turn.
- [x] 24. 간편인증 hand-off (S–M). Detect PASS, 카카오, 네이버, 토스 and similar verification screens, name the app, pause TTS, wait for "인증 끝났어", and re-check the page with item 4's flow. The agent never reads or types codes.
  - Landed: `verification_app` + hand-off names the app; AUTH_HANDOFF still pauses TTS; auth_done re-checks.
- Skipped by decision: 18 phone client, 21 mail and calendar, 22 camera reading.

## Not on this list, and why

- Already in 청음: local browser the user can watch with a virtual cursor, page summaries, links by name, search, grounded web answers, goal mode capped at 10 steps and 75 s, form filling with approval, approval before important actions, stop and cancel, consent gate, password-field refusal, redaction of what the user says (rules plus local model), answer checking against sources, page text treated as untrusted, CAPTCHA detect-and-stop, official welfare API first, four languages, voice input with barge-in, clap and hotkey, recordings not stored, due-date reminders, personal vault, separate browser session per user.
- Being built by the other session: help command "뭐라고 말하면 돼?" (U4), real-site login after a spoken go-ahead (U5). Landed: U1 to U3.
- Do not copy: CAPTCHA solving, a cloud browser that receives plaintext passwords, the agent typing passwords, cancelled-seat sniping, review-point farming, AI phone calls, payments and shopping, agent-to-agent chat, the 3D character and pay-per-reset quota.
