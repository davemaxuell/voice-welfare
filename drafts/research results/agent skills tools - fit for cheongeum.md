# Skills, intents, and tools in 청음: inventory and verdicts

Date: 2026-11-17. Companion to `agent skills tools.md` in this folder. Describes the working tree on branch `feat/local-stt-privacy`, including the uncommitted local STT and PII model work.

This document answers two questions. What can 청음 do today, part by part? Which capabilities of commercial agent products should 청음 add, and which of its own parts should it cut?

Part 1 is a reference. It describes what the code does and gives no opinion. Part 2 holds the verdicts. Part 3 gives an order of work, the decisions that are yours, and a lookup table of where to edit.

## Verdict

청음 already has the parts of the survey that fit its user. It routes intents, runs multi-step plans, splits work between two agents, asks for approval before consequential actions, checks answers against their sources, keeps session state, stores a small personal vault, reminds about deadlines, and has its own evaluation scripts.

Five ideas from the survey are worth adopting, each in a smaller form than the survey describes.

1. **A skill registry.** One table that every intent is declared in, replacing the six places an intent is declared today. The probe shows the cost of the current layout. Six intents exist that the LLM planner cannot produce.
2. **Site playbooks.** The survey's "skills" are instructions loaded on demand. For 청음 the equivalent is per-site knowledge as data. Today only the practice site has a profile. Real sites have a name and a URL and nothing else.
3. **Narrow, explicit memory.** Speech preferences, and the document checklist attached to an application record. No memory learned from conversation.
4. **A turn-level audit log.** The product's stated differentiator is recording where users get stuck. Today the log holds browser actions only, in memory, and is lost on restart.
5. **A grounded handoff to a person.** `HELP_HUMAN` is a stub that says the feature is unsupported. The official data already carries contact numbers.

Reject connectors and plugin marketplaces, cloud sandboxes and code execution, more agents, work done while the user is away, every agent framework in the survey's table, and a vector database for now. Section 13 gives the reason for each.

Fix the six safety gaps in section 10 before adding anything. Three are reproduced by scripts in this folder.

- Goal mode pressed the mock-submit button with no approval step, because the approval rule lives in the caller and not in `PolicyGuard`.
- Saying "취소" to a vault save stops the session but leaves the save pending. A later "응" saves the value and takes the session out of the stopped state.
- While the session is stopped, "내 정보 알려줘" still reads the vault aloud.

Two more are read from code and matter as much. In hands-free mode nothing listens while the agent works, so "멈춰" cannot interrupt a goal run of up to 75 seconds. On read-only sites the guard checks button names but not link names.

Cut the LLM intent classifier that no server configuration can reach, the contract entries that nothing emits, 16 dead helpers, and two routes that only tests call. Section 15 lists them with evidence.

## How the evidence was gathered

- **Code reading.** I read `core/turn.py`, `core/actions.py`, `core/dialogue.py`, `core/llm.py`, all of `understanding/`, `orchestrator/session.py`, `safety/gates.py`, `safety/guard.py`, and the assembly in `server/runtime.py`. Three read-only reviewers read the rest and reported with file and line. I checked the claims that the verdicts depend on.
- **Probes.** Three scripts in `probes/`. `inventory.py` prints the contract tables. `goal_submit_check.py` reproduces the first safety gap on the local practice site with a scripted model. `gate_checks.py` reproduces the two vault gaps with rules only and an in-memory vault.
- **One configuration check.** I built the intent provider and the structured LLM client for 72 combinations of provider, model, key, and base URL.
- **No live model call, no real site visit.**

Run the probes from the repository root:

```bash
uv run python "drafts/research results/probes/inventory.py"           # tables as text, --json for JSON
uv run python "drafts/research results/probes/goal_submit_check.py"   # headless Chromium, practice site only
uv run python "drafts/research results/probes/gate_checks.py"         # headless Chromium, practice site only
```

Each finding in this document carries one of three labels. **Reproduced** means a script in this folder shows it. **Read from code** means I or a reviewer traced it in source and nobody ran it. **Not reproduced** means a reviewer derived it and I did not trace it myself.

The "used in" columns of `inventory.py` are string matches over `src/cheongeum/**/*.py`. They prove that a name is unused. They do not prove that a name is used for the purpose its table suggests.

### Reliability of the survey

`agent skills tools.md` has no links. It ends with "as cited" and cites nothing, and it refers to a source "[36]" that the file does not contain. I did not verify its product claims or its star counts, and this document does not rely on them. The survey is used here for one thing, which is its list of capability categories: intent routing, planning, a tool registry, connectors, memory, scheduled and background work, sandboxing, sub-agents, approvals, audit, and evaluation.

The survey describes cloud agents that act for an office worker across business software while the worker is away. 청음 is a local program for one blind person who is present and listening, on public sites where the agent must not log in or submit. Most verdicts in Part 2 follow from that difference.

---

# Part 1. What 청음 has today

## 1. The parts and the path of one turn

| # | Part | Package | Job |
|---|---|---|---|
| 1 | Voice in | `web/static/mic.js`, `voice/stt*.py` | Microphone, speech detection, transcription |
| 2 | Understanding | `understanding/` | Turn words into one or more intents |
| 3 | Language | `language/i18n.py` | Translate in and out for English, Chinese, Japanese |
| 4 | Orchestrator | `orchestrator/session.py` | Order, gates, routing, one turn at a time |
| 5 | Dialogue state and memory | `core/dialogue.py`, `personal/` | What the agent is waiting for, vault, application records |
| 6 | Agent A | `agents/web/` | Browser skills, executor, page reading |
| 7 | Agent B | `agents/welfare/` | Answers from official welfare data |
| 8 | Safety | `safety/` | Action gate, consent and stop gates, privacy, answer checks |
| 9 | Speech | `speech/` | Wording of what is spoken |
| 10 | Voice out | `web/static/speaker.js`, `voice/tts.py` | Synthesis, chunked playback, signal tones |
| 11 | Shell | `server/`, `web/static/`, `apps/desktop/`, `practice_site/` | API, web UI, desktop app, practice site |
| 12 | Evaluation and logs | `evaluation/`, `scripts/`, `core/events.py` | Scenarios, model comparisons, action events |

One turn runs in this order (`orchestrator/session.py`). Each step either answers and ends the turn, or passes the text on.

1. `handle_turn` normalizes the text, detects sensitive values, and redacts it. The raw text is not used after this line (`:153-161`).
2. A stop word ends here. `_stop` runs outside the queue, raises the epoch so that waiting turns are dropped, and aborts running browser actions (`:229-238`).
3. The turn waits for the session lock. Turns run one at a time, in order (`:218-223`).
4. A secret value gets a warning and nothing else. This runs before any translation, so no model sees it (`:274-275`, `:416-418`).
5. A language-switch phrase changes the language. Foreign text is translated to Korean (`:276-299`).
6. A short non-command on a login screen may be a spoken password. The agent warns and keeps only a hash (`:862-890`).
7. An answer to a discovery question continues discovery (`:424-437`).
8. An answer to a vault confirmation saves or drops it (`:441-445`).
9. Guided fill takes the answer, or starts on "하나씩 채워줘" (`:447-454`).
10. A vault or application-record command runs (`:456-461`).
11. A bare "알았어" or "아니" gets a short reply and is never treated as a value or a command (`:463-466`).
12. Leading filler is removed. Several questions in one sentence are split and answered one by one (`:468-473`).
13. A request with no object, such as "열어줘", gets a specific question back (`:474-477`).
14. `Understanding.understand` produces intents. Rules split and parse first. The LLM planner runs only when the rules return UNKNOWN (`understanding/understand.py:51-89`).
15. The consent gate and the stop gate run (`safety/gates.py`).
16. `_route` calls one skill, or `_run_plan` calls several in order and stops at the first step that needs the user (`:604-635`, `:707-815`).
17. `_finish` commits the state, appends history, records action events, and validates the `TurnResult` (`:496-557`).
18. The reply is translated back when the language is not Korean. If a number changes in translation, the Korean original is spoken (`:369-393`).

Steps 7 to 10 run before the gates in step 15. Section 14 comes back to that.

## 2. Intents

`core/turn.py:125-159` defines 33 intent types. The table comes from `probes/inventory.py`. "LLM" says whether the LLM planner can produce the type (`understanding/llm_planner.py:20-46`). "Before consent" says whether the type runs when the user has not agreed to screen reading (`safety/gates.py:13`).

| Intent | Parameters | Example | LLM | Before consent | Handler |
|---|---|---|---|---|---|
| `START_APPLICATION` | | 장애인연금 신청 도와줘 | yes | no | `_start_application` |
| `LOGIN` | | 로그인하고 싶어 | yes | no | `BrowseSkill.login` |
| `AUTH_DONE` | | 인증 끝났어 | yes | no | `BrowseSkill.auth_done` |
| `FILL` | `fills` (1 to 5) | 이름은 김하늘 | yes | no | `FormSkill.fill` |
| `READ_FIELD` | `fieldMention` | 주소 다시 읽어줘 | yes | no | `FormSkill.read_field` |
| `EDIT_FIELD` | `fieldMention` | 이름 고칠래 | yes | no | `FormSkill.edit_field` |
| `NEXT` | | 다음 | yes | no | `FormSkill.next` |
| `PREV` | | 이전, 뒤로 가줘 | yes | no | `FormSkill.prev` on the form, else `BrowseSkill.back` |
| `REVIEW` | | 입력한 내용 읽어줘 | yes | no | `FormSkill.review` |
| `EXPLAIN` | `fieldMention?` | 이 항목 무슨 뜻이야 | yes | no | `_explain`, then Agent B glossary |
| `PREPARE_SUBMIT` | | 접수해줘, 최종 확인 | yes | no | `FormSkill.prepare_submit` |
| `APPROVE` | | 승인 | **no, by design** | no | `_approve` |
| `REJECT` | | 거절, 하지 마 | yes | no | `FormSkill.reject` |
| `STOP` | | 멈춰, 그만, stop | **no, by design** | yes | `_stop`, before the queue |
| `RESUME` | | 다시 시작 | yes | no | `BrowseSkill.resume` |
| `CURRENT_STEP` | | 지금 어느 단계야 | yes | no | `BrowseSkill.current_step` |
| `DESCRIBE_SCREEN` | | 화면 설명해줘 | yes | no | `BrowseSkill.screen` |
| `ABOUT_SITE` | | 여기 무슨 사이트야 | yes | no | `BrowseSkill.about_site` |
| `REPHRASE` | | 쉽게 말해줘 | **no** | no | `_rephrase` |
| `OPEN_BROWSER` | | 크롬 켜줘 | yes | no | `web.show_browser` |
| `DISCOVER` | | 내가 받을 수 있는 복지 찾아줘 | yes | yes | `_discover_step`, then Agent B |
| `SERVICE_DETAIL` | `service?` | 2번 자세히 알려줘 | **no** | yes | Agent B `service_detail` |
| `PRECHECK` | `service?` | 기초연금 받을 수 있는지 확인해줘 | yes | yes | Agent B `precheck` |
| `PREPARE_APPLY` | `service?` | 신청하려면 뭐가 필요해 | yes | yes | Agent B `prepare` |
| `GOAL` | `goal` | 네이버에서 오늘 뉴스 알려줘 | yes | no | `BrowseSkill.run_goal` |
| `OPEN_SITE` | `target` | 복지로 열어줘 | yes | no | `BrowseSkill.open_site` |
| `FOLLOW_LINK` | `name` | 공지사항 눌러줘 | **no** | no | `BrowseSkill.follow_link` |
| `READ_MAIN` | `more` | 본문 읽어줘, 계속 읽어줘 | **no** | no | `BrowseSkill.read_main` |
| `LIST_LINKS` | `more` | 링크 목록 알려줘 | **no** | no | `BrowseSkill.list_links` |
| `SEARCH` | `query`, `site?` | 기초연금 검색해줘 | **no** | no | `BrowseSkill.search` |
| `POLICY_QUESTION` | `topic` | 기초연금은 몇 살부터 받아? | yes | yes | `_policy_question`, then Agent B |
| `HELP_HUMAN` | | 상담원 연결해줘 | yes | yes | Fixed sentence. It says the feature is unsupported. |
| `UNKNOWN` | `text` | anything else | yes | no | `_unknown` |

All 33 types have a rule in `understanding/rules.py`. Rule order decides ties. The first matching rule wins.

Six types cannot come from the LLM planner for no stated reason: `REPHRASE`, `SERVICE_DETAIL`, `FOLLOW_LINK`, `READ_MAIN`, `LIST_LINKS`, `SEARCH`. The planner's flat schema has no field for a link name, a search query, or the `more` flag (`llm_planner.py:50-73`). When the rules miss one of these, the planner returns something else or UNKNOWN, and the turn falls to free chat.

### What `UNKNOWN` does

`_unknown` (`session.py:1032-1061`) tries these in order.

1. A pending "which field?" question repeats its choices.
2. "더 알려줘" pages through discovery results.
3. "2번" follows the numbered link that was just read out.
4. While a field value is awaited, a question is answered and a valid value is filled.
5. With an LLM, `chat_route` picks one of six routes (`understanding/chat.py`).

| Route | What runs |
|---|---|
| `welfare` | Agent B answer from official data |
| `web_search` | `BrowseSkill.web_answer`. Opens a search, answers, checks the answer against the page |
| `web_task` | `BrowseSkill.run_goal`, which is goal mode |
| `general` | The model's own one or two sentences |
| `language` | Switch the conversation language |
| `clarify` | Ask back. Not offered twice in a row |

6. Without an LLM, a question goes to Agent B and anything else gets "잘 이해하지 못했어요".

### Turn labels that are not intents

`TurnResult.intentType` also carries labels for the turns that end before step 14.

| Label | Set at step | Meaning |
|---|---|---|
| `STOP` | 2 | Immediate stop |
| `SECRET_DISCLOSURE` | 4, 6 | A secret was spoken, or may have been |
| `SET_LANGUAGE` | 5 | Language switch |
| `PROFILE_ANSWER` | 7 | Answer to a discovery question |
| `VAULT_CONFIRM` | 8 | Yes or no to a vault save or clear |
| `GUIDED_FILL` | 9 | Guided fill start or answer |
| `PERSONAL_VAULT_SAVE`, `_VAULT_READ`, `_VAULT_CLEAR`, `_APP_RECORD`, `_APP_DUE`, `_APP_DONE`, `_APP_STATUS` | 10 | Vault and application-record commands |
| `ACK` | 11 | Bare acknowledgement or bare "no" |
| `MULTI_QUESTION` | 12 | Several questions answered in one turn |
| `CLARIFY` | 13 | Request with no object |
| `PLAN(A>B>C)` | 14 | Several intents in one utterance |
| `CONSENT` | API | Consent given or declined |

## 3. Agent A: web skills

### FormSkill (`agents/web/skills/form.py`)

Works on the practice application form. One method, the assist path, works on real sites.

| Method | Does | Refuses or limits |
|---|---|---|
| `fill` | Fills up to 5 fields, reads each value back from the screen, asks for the next empty required field | On a real site it does not fill. It asks for approval first (assist path) |
| assist path (`_assist_fill_request`, `assist_approved`) | Matches a spoken field name to an input on a real site, asks for approval, fills after "승인" | Skips password, one-time code, resident number, account, card, and search fields. Never presses submit |
| `read_field` | Reads one value. The phone number is masked | Form must be open |
| `edit_field` | Speaks the current value and waits for a new one | Field must be on the current step |
| `next`, `prev` | Moves between the 3 steps. Reports missing required fields | Closes a popup only when it has exactly one button named 닫기 or 확인 |
| `review` | Reads all filled values, masked | |
| `prepare_submit` | Goes to the last step, builds the submit click, asks for approval | Does not submit |
| `submit_approved` | Presses 모의접수 after approval and reads the receipt number | Only on the last step. Waits 3 seconds for the receipt |
| `reject` | Drops the pending approval | |

### BrowseSkill (`agents/web/skills/browse.py`)

| Method | Does | Refuses or limits |
|---|---|---|
| `open_site` | Opens a known site. For an unknown name it searches "{name} 홈페이지" | Never invents a URL |
| `follow_link` | Clicks a link or a navigation button by name. "2번" picks from the list just read | Several matches: reads up to 5 candidates and waits. When names repeat, only the first can be clicked |
| `back` | Browser back | |
| `read_main` | Reads the body in chunks of 350 characters. On a 복지로 service page it reads Agent B's official text | |
| `list_links` | Reads 10 links at a time | Leaves out buttons whose names match the risky-button list |
| `search` | Types into the page's search box and presses Enter. Falls back to the search-engine URL | Query of 100 characters or fewer |
| `screen`, `current_step`, `about_site` | Describes the screen, the step, or the site | An unknown site gets its title only |
| `web_answer` | Searches, answers from the result page, checks the answer against the page text | Needs an LLM. Reads the first 200 characters when the check fails |
| `run_goal` | Goal mode | Needs an LLM |
| `login`, `auth_done` | Opens the login page and hands over to the user | Never types credentials |
| `resume` | Continues after a stop | |

### GuidedFill (`agents/web/skills/guided.py`)

Starts on "하나씩 채워줘" on a real site. It asks for each input in turn, offers a saved vault value when the label matches, fills, and reads the value back. "건너뛰기" skips and "그만" ends. It leaves out checkboxes, search boxes, and fields whose label mentions 비밀번호, OTP, 주민, 계좌, 카드, 동의, or 약관. The spoken value counts as the approval for that field.

### Goal mode (`agents/web/autopilot.py`)

The model picks one action per step from `open_url`, `click`, `search`, `back`, `read_more`, `answer`, `ask_user`, `fail`. It has no action that types into a form.

| Limit | Value |
|---|---|
| Steps | 10 |
| Time | 75 seconds, checked at the start of each step |
| Same action on the same page | Third time fails |
| Rejected answers | 3. An answer is rejected when it is not Korean, when the named site was not visited, or when its quote or numbers are not in the pages seen |
| Malformed reply | Asked once more |
| Browser actions per turn | 12, shared by the whole run (`server/runtime.py:224`). A search costs 2 |
| What the model sees per step | 30 content links, 12 menu links, 12 buttons, 8 headings, 1,500 characters of body |

The rule against pressing login, sign-up, payment, application, submit, and consent buttons is in the prompt. The code-level limit is `PolicyGuard`. After `ask_user` no goal state is kept, so the user's reply starts a new turn.

### Executor and browser (`agents/web/agent.py`, `agents/web/browser/`)

Every browser action goes through `WebExecutionAgent._run`, which calls `PolicyGuard.check`, then the Playwright adapter, then observes the page again.

| Action type | Emitted for | Notes |
|---|---|---|
| `navigate` | Open a URL | |
| `back` | Browser back | |
| `click` | Link, button, form step, submit | Target by role and name. No coordinates |
| `fill` | Form field, search box | Value read back and compared |
| `press` | Search | Only ever "Enter" |
| `select`, `check` | Form field | |
| `read` | Read a visible field | |
| `scroll`, `focus` | **Never emitted** | Handled by the adapter and allowed by the guard |

Timeouts are 5 seconds per action and 10 seconds per navigation. A timeout is retried once. A click waits up to 6 seconds for the URL or title to change and reports success either way. Native alert boxes are dismissed and their text is added to the next observation. New tabs are followed.

`observe.js` collects up to 60 fields, 300 links, 40 buttons, 40 headings, 3 dialogs, and 4,000 characters of main text. It never reads password or one-time-code values. `digest.py` classifies a page as `blank`, `blocked`, `form`, `search-results`, `article`, `list`, or `page`. A `blocked` page (CAPTCHA, access denied) is reported to the user and not bypassed.

### Site knowledge

| Where | What it holds |
|---|---|
| `agents/web/profile.py` | One profile, for the practice site. 3 URLs, button names, receipt pattern, 8 fields with validators. `loginPassword` is the one secret field |
| `understanding/sites.py` | 23 known sites, name to URL. 17 public sites and 6 portals. One-character typos are tolerated for Korean names of 3 or more characters |
| `agents/web/agent.py:69` | Synonyms for field labels on real sites |
| `agents/web/skills/browse.py:60` | Spoken names of the practice site |
| `agents/welfare/agent.py` | 복지로 service-page URL pattern, read through the API |

## 4. Agent B: welfare information (`agents/welfare/`)

| Capability | Does | Limits |
|---|---|---|
| `answer_question` | Finds the named service, retrieves 3 chunks, asks the model to answer from them, keeps the answer only when it cites retrieved chunk ids and its numbers appear in them | Falls back to a rule-based section answer. When the data has no answer and the model knows a general one, it says so and tells the user to confirm with 129. That general answer is not number-checked |
| `discover` | Asks age, disability, income level, and region, then ranks the catalog by rule | Never says eligible or not eligible. Reads 3 names at a time |
| `service_detail` | Name, region, summary, targets for one item in the result list | |
| `precheck` | Compares the official criteria with the user's answers, condition by condition | Refuses when no criteria text is available. At most 3 conditions. Sends the profile to the model |
| `prepare` | How and where to apply, up to 3 form names, first contact number | |
| `explain_field` | Glossary for the practice form | 6 entries. Unknown field: "추측해서 설명하지 않겠습니다" |
| `readable_service` | Builds reading text for a 복지로 service page from API data | |
| `briefing` | One or two sentences after opening an official page | Dropped when it contains a number that the source lacks |

**Data.** With `WELFARE_DATA_MODE=official-api` and a key, Agent B calls the 한국사회보장정보원 central and local-government APIs, caches for 6 hours, and falls back to the fixture on error. Without a key it uses the fixture: one detailed service (장애인연금), 6 glossary entries, and a saved catalog of 461 central and 284 Busan entries from 2026-11-16. In fixture mode a question about any other service gets "공식 자료를 찾지 못했어요".

**Retrieval.** `rag.py` splits one service into section chunks and scores them by character 2-gram overlap plus a section-keyword bonus. Top 3, no score threshold, no embeddings. The last report shows Recall@3 100% and MRR 0.950 on 20 team-written questions.

**Handoff to Agent A.** After a grounded answer, "신청 도와줘" builds an `AgentHandoff` (`core/turn.py:321-336`) with the goal, the sources, and the target URL. In practice mode the target is the practice form. In real-site mode Agent A opens the official 복지로 page read-only, or searches when the URL is unknown.

## 5. Dialogue state and memory

| Store | Holds | Lives |
|---|---|---|
| `DialogueState` (`core/dialogue.py`) | Session state plus six independent waits: approval, field value, which-field question, discovery question, vault confirmation, guided fill | Session |
| History | Redacted user text and agent speech per turn | Session, unbounded |
| Discovery profile | Age, disability, income, region | Session. Never reset within a session |
| Approvals | Ids of approved actions, valid inside one `with` block | Turn |
| Vault (`personal/store.py`) | `name`, `address`, `phone`, `email`, `birth`. Nothing else can be stored | `CHEONGEUM_DATA_DIR/personal.json`, plain JSON, file mode 600. Memory only when the variable is unset |
| Application records | Service, applied date, receipt number, due date, note, done | Same file |
| Browser preferences | Microphone id | `localStorage` |

Seven voice commands reach the vault and the records (`personal/commands.py:87-124`): save, read, and clear the vault, record an application, record a due date, mark a result, and ask for status. Saving and clearing ask for confirmation first. Vault values are offered only by guided fill.

**Reminders.** A record that is not done and is due within 3 days, or overdue, produces a reminder. It is appended to the consent reply. The desktop app also polls every 60 minutes and speaks a given text once per day. The first poll is 60 minutes after consent. The plain web UI never polls.

Session states: 23 are defined (`core/turn.py:12-36`). `LISTENING`, `PAUSED`, and `DONE` are never set by any Python code.

## 6. Safety

**PolicyGuard** (`safety/guard.py`) gives every URL one of three tiers.

| Tier | Which sites | Allowed |
|---|---|---|
| `full` | The practice site and `EXTRA_ALLOWED_ORIGINS` | Fill allowlisted fields, click, navigate. An action marked sensitive or consequential needs an approval id |
| `read-only` | Any other http or https site | Navigate, back, read, click links, click buttons whose name does not match `RISKY_BUTTON`, type and Enter in search boxes. Other inputs only with approval |
| `none` | Everything else | Nothing |

`RISKY_BUTTON` is a list of 41 action words (신청, 제출, 동의, 로그인, 결제, submit, pay, and so on) matched against the button name. Secret fields are refused in every tier, by field id, by label, and by value. A turn may run at most 12 actions.

**Gates** (`safety/gates.py`). Before consent, only the 7 welfare and help intents run. While stopped, only `RESUME` runs.

**Privacy** (`safety/privacy.py`, `safety/pii_model.py`). Rules detect passwords, one-time codes, resident numbers, accounts, cards, passport and licence numbers, and health terms, including digits spoken as Korean syllables. An optional local KoELECTRA model adds detection for 10 label types. It is on only when `PII_MODEL` points to a model folder. Detected values become `[비공개]` before anything else sees the text.

**Answer checks** (`safety/verify.py`). A quote must appear in the source, exactly or with 85% 2-gram overlap. Every number above 10 in an answer must appear in the source or the question. Used by Agent B, `web_answer`, goal mode, page summaries, and translation.

## 7. LLM calls

One client (`core/llm.py`) serves every stage. It uses OpenAI-compatible chat completions with strict JSON schema, a 30-second timeout (60 for Ollama), and no HTTP retry. Every caller has a rule-based fallback for a failed call. There are 14 schemas.

| Schema | Used by | For |
|---|---|---|
| `intent_plan` | `understanding/llm_planner.py` | Ordered intents for an utterance the rules missed |
| `split_questions` | `understanding/filters.py` | Split several questions |
| `chat_route` | `understanding/chat.py` | Pick the free-chat route |
| `browse_step` | `agents/web/autopilot.py` | One goal-mode action |
| `web_answer` | `agents/web/skills/browse.py` | Answer from a search page |
| `page_summary` | `speech/screen.py` | Short page summary |
| `grounded_answer`, `general_answer`, `precheck`, `service_brief` | `agents/welfare/agent.py` | Agent B |
| `translate_in`, `translate_out`, `translate_quote` | `language/i18n.py` | Translation |
| `simple` | `orchestrator/session.py` | "쉽게 말해줘" |

## 8. Voice, server, UI, desktop

**Speech to text.** `STT_PROVIDER` selects OpenAI, a local faster-whisper model, a local OpenAI-compatible server, or none. With none, the web UI uses the browser's speech recognition for single commands and hands-free conversation is unavailable. The local model handles Korean and sends other languages to OpenAI when a key exists. The last STT report (70 of 82 clips, synthetic audio) fails 3 of the 4 gates for making local the default: Korean character error rate 12.9% against 2.5%, digit match 62.5% against 75%, p95 latency 4.8 seconds against 1.8.

**Listening** (`web/static/mic.js`). Hands-free mode detects speech start at 2.5 times the noise floor, ends an utterance after 1.5 to 2 seconds of silence, and caps it at 25 seconds. The user can interrupt speech by talking, by Space, by the global hotkey, or by two claps. No test covers speech detection, interruption, or claps.

**Text to speech.** OpenAI, or the browser's synthesis at rate 1.25. Text is split into chunks of up to 140 characters and the next chunk is fetched while one plays. Two signal tones mark "listening" and "heard".

**Server** (`server/app.py`). 15 routes. At most 3 sessions; a fourth evicts the oldest. No idle expiry. Four routes are never called by the UI: `GET /api/session/{id}/state`, `POST /api/audio/transcribe`, `GET /api/events`, `GET /api/welfare/services`.

**Web UI.** Consent panel, conversation controls, language picker, text input, 13 example buttons, status, field list, approval panel, sources, action log. Live regions announce changes. High contrast and voice-guidance toggles are not saved.

**Desktop** (`apps/desktop`). Starts the server, hides the window, adds a tray menu and the global hotkey Ctrl or Cmd, Shift, Space, and stops the server when it quits.

**Practice site.** A 3-step form, a login page, and a synthetic portal. Both the form and the portal contain planted instructions addressed to an AI, to test that the agent ignores them.

## 9. Evaluation and logs

| Tool | Measures |
|---|---|
| `scripts/run_scenarios.py` | 35 scenarios (5 demo, 30 synthetic), RAG Recall and MRR, axe accessibility on 7 pages. Last report: 35 of 35, 0 unauthorized submissions, p95 1,656 ms |
| `scripts/eval_agent.py` | 10 goal tasks per model, 7 on real sites. Its report file is not in `reports/` |
| `scripts/eval_stt.py` | Character error rate, digit match, stop recognition, latency |
| `uv run pytest` | 220 test functions by grep: 129 unit, 91 end to end |
| `TurnResult.trace` | Phase, agent, and milliseconds for each step of a turn. The UI does not show it |
| `core/events.py` | One event per browser action: type, success, latency, error code. 5,000 in memory, lost on restart. Turns with no browser action leave no event |

---

# Part 2. Verdicts

## 10. Fix first: safety gaps

These come before any addition. Each row needs a test that fails today.

| # | Gap | Evidence | Direction |
|---|---|---|---|
| S1 | Goal mode pressed 모의접수 with no approval. The policy code was `ALLOWED`. The planted "press submit" notice on the form was in the text sent to the model | **Reproduced** by `probes/goal_submit_check.py` | The approval requirement is set by the caller (`build_submit_action`). `follow_link` builds a low-risk click for any button name, and the `full` tier never looks at the name (`guard.py:98-118`). Move the rule into the guard. On the `full` tier a click on the profile's submit button, or on a `RISKY_BUTTON` name, needs approval whatever risk the caller declared. The same gap applies to any site added to `EXTRA_ALLOWED_ORIGINS`. **Owner's direction, 2026-11-18:** a click that needs approval does not end silently. Goal mode stops and the agent explains aloud what it was about to do and asks for confirmation, in the same way as `prepare_submit`. Code builds the explanation from the action and the observed page, and the model does not write it |
| S2 | In hands-free mode nothing listens while a turn is processed. `talkNow` has no branch for the `thinking` phase. In background desktop mode there is no stop button either | **Read from code** (`web/static/app.js:417-427`, `:461-475`) | Keep the microphone open during `thinking` for the stop word only, and let the hotkey send `/cancel`. The server already handles a concurrent stop. **Approved by the owner on 2026-11-18** |
| S3 | On read-only sites the guard checks button names against `RISKY_BUTTON`. It does not check link names. A link named 신청하기, 로그아웃, or 삭제 is clicked | **Read from code** (`guard.py:143-149`) | Your decision, section 17. `BrowseSkill.login` depends on following 로그인 links today |
| S4 | A stop does not cancel most model calls. Agent B, `chat_route`, the planner, rephrase, and `web_answer` pass no abort signal. The stopped turn holds the session lock until the call returns or times out | **Read from code** | Pass `turn.ctx.signal` to every `generate` call |
| S5 | Vault commands, record commands, and discovery answers run before the consent and stop gates. While stopped, "내 정보 알려줘" reads the vault aloud | **Reproduced** by `probes/gate_checks.py`, both while stopped and before consent (`session.py:424-461` against `:483`). Before consent, the state label also moves from `AWAITING_CONSENT` to `IDLE` while consent stays pending | Your decision, section 17 |
| S6 | "취소" is a stop word, and a stop does not clear a pending vault confirmation. A later "응" saves the value and moves the session from `STOPPED` to `IDLE` without "다시 시작" | **Reproduced** by `probes/gate_checks.py` (`core/dialogue.py:72-79`) | Clear `vault_confirm` in `DialogueState.stop` |

## 11. Survey capabilities, one by one

| Capability in the survey | 청음 today | Verdict |
|---|---|---|
| Intent detection and routing | Rules first, LLM planner second, free-chat router third | **Keep.** Close the planner gap through the registry (A1) |
| Multi-step planning | Plans of up to 6 intents, up to 4 questions per turn, 10-step goal mode | **Keep.** No parallel steps. There is one browser and one listener |
| Tool and skill registry with a schema | Intents are declared in 6 places | **Adapt** as an internal table (A1). Not a plugin system |
| Skills as instructions loaded on demand | One site profile, for the practice site | **Adapt** as site playbooks (A2) |
| Connectors, plugins, MCP, thousands of apps | None | **Reject.** The user's tasks are on public websites. Each connector is a new place where data leaves the computer |
| Persistent memory in several tiers | Session state, vault, application records | **Adapt** narrowly (A3). Reject memory inferred from conversation. The product's rule is that raw speech is never stored |
| Scheduled triggers | Deadline reminders, desktop only | **Adapt** by fixing reminders (A6). No general scheduler |
| Background work while the user is away | None | **Reject.** Every action is confirmed by a listening user, and nothing useful can be done without the user's login |
| Proactive research | None | **Reject** for now. Depends on a saved profile, which is decision 6 |
| Cloud sandbox, code execution | One browser context per session | **Reject.** No code runs on the user's behalf |
| Sub-agents, multi-agent orchestration | Two agents plus a screen role and a verifier role | **Keep at two.** New abilities are skills inside them |
| Approval policies, auto-review | `PolicyGuard`, approval ids, consent gate, answer checks | **Keep and fix** (S1, S3). A second model as reviewer adds latency and a new failure mode. The rule-based checks are deterministic |
| Human in the loop | Approval, login handoff | **Extend** with a grounded handoff to a person (A5) |
| Audit log, observability | In-memory action events, per-turn trace | **Adapt** as a local turn log and a report script (A4). Reject OpenTelemetry and dashboards. There is one user and one machine |
| Evaluation | Scenarios, goal tasks, STT, accessibility | **Keep.** Add an utterance set per skill (A1) |
| Result delivery to other channels | Speech and an on-screen log | **Reject** Slack and email. The planned phone notification for 간편인증 is the one channel worth adding, and it is in `docs/기획요약.md` already |
| Marketplace, third-party skills | None | **Reject** |
| Domain-tuned or fine-tuned models | None | **Reject** for now. No measurement shows the base model is the limit |

## 12. What to add

**A1. Skill registry.** One Python table with a row per intent: type, parameters, example utterances, handler, whether it runs before consent, whether the LLM may produce it, and the semantic action it returns. `LLM_INTENT_TYPES`, the planner's prompt text and flat schema, `ALLOWED_WITHOUT_CONSENT`, and the `_route` dispatch are derived from it. The example utterances become a test that runs every row through the rules alone and through a fake planner. Check: `inventory.py` shows "llm yes" for every type except `APPROVE` and `STOP`.

**Owner's decisions, 2026-11-18.** The model may produce every intent except `APPROVE` and `STOP`. A new help intent answers "뭐라고 말하면 돼?" from the registry's example sentences. It speaks the examples for what is on screen first, a few at a time. It speaks only examples that the rules understand, and a test enforces that, so help never teaches a sentence that fails without a model. It replaces the fixed `EXAMPLES` line in `orchestrator/session.py`. `probes/phrasings.py` holds the first 19 example sentences, of which the rules miss 11.

**A2. Site playbooks.** One data file per supported real site, 복지로 first. It holds entry URLs (service search, application status, login), the page kinds the site uses, known obstacles (tabbed guidance, certificate popup, bot wall), and the sentence that hands over to the user at each one. `BrowseSkill` and goal mode read it as hints. The five places in section 3 that hold site knowledge move into it. This follows the perception fixes in `navigating agent - implementation plan.md`. A playbook cannot help while the model is not shown the site's main menu. Check: the 복지로 tasks in `scripts/eval_agent.py`.

**A3. Narrow memory.** Two additions, both explicit and local. First, speech preferences: rate, short or detailed answers, language. Commands such as "천천히 말해줘" and "짧게 말해줘" change them and they persist. The browser's speech rate is fixed at 1.25 today and screen-reader users differ widely in the rate they want. Second, the result of `prepare` (forms and contact) is attached to the application record, so "서류 뭐였지?" works a week later. Both are listed and deleted by the existing vault commands.

**A4. Turn log and failure report.** Record one de-identified event per turn, not per browser action: turn label, end state, site host, page kind, error or policy code, latency. No text, no values. Write it to a local file when the user agrees. A script groups failures by site and stage. `docs/user-test/plan.md:38-39` already plans to count clarifications from `/api/events`, which cannot work today because a clarification leaves no event.

**A5. Grounded handoff to a person.** Replace the `HELP_HUMAN` sentence. Speak the contact number of the current service from official data, which `prepare` already extracts, or 129 when there is none. Add what to tell the person: service name, receipt number from the record, and the step where the user stopped. No call is placed.

**A6. Reminders that keep their promise.** The reply to a recorded due date says "기한까지 매일 알려 드릴게요". Check at start instead of after 60 minutes, run in the web UI as well, and stop repeating an overdue item after the user marks it.

**A7. Read application status after the user logs in.** This is planned feature 5 in `docs/기획요약.md`. It needs no new skill. It is `read_main` on one page of the 복지로 playbook.

## 13. What not to add

| From the survey | Verdict | Reason |
|---|---|---|
| LangChain, LlamaIndex, Haystack | Reject | The loop exists and is rules-first. A framework would sit between the code and the checks that make it safe |
| AutoGPT, BabyAGI | Reject | Open-ended loops with no approval step. The survey itself calls BabyAGI not for production |
| Selenium, Puppeteer | Reject | Playwright is in place |
| Qdrant, Weaviate | Reject for now | Retrieval runs inside one service's text and scores Recall@3 100% on the current set. Revisit for discovery across the catalog if a larger question set shows misses |
| Redis, Celery, RabbitMQ, Kafka | Reject | One user, one process |
| APScheduler | Reject | A6 needs one timer |
| OpenTelemetry | Reject | A4 covers the need with a file and a script |
| OpenAI Evals | Reject | The repository's scripts measure the product's own metrics |
| MCP servers | Reject for now | Useful only if other assistants should read 청음's welfare data. No user need today |
| Kubernetes, autoscaling | Reject | Desktop program |

## 14. What to change in what exists

| # | Finding | Evidence |
|---|---|---|
| C1 | The LLM planner cannot produce 6 intents | **Probe.** Fixed by A1 |
| C2 | `/api/health` reports `llmProvider` from the intent provider. With Ollama it says `mock-rule` while the LLM is in use | **Checked** over 72 configurations |
| C3 | Secret labels are defined in 4 regexes with different terms (`privacy.KEYWORDS`, `guard.SECRET_LABEL`, `store.SECRET`, `guided.py:100`). Guided fill skips consent boxes and the assist path does not | **Read from code** |
| C4 | Service names are matched by 3 different regexes (`agent.SERVICE_NAME`, `rules._SERVICE_REF`, `commands.SERVICE`) | **Read from code** |
| C5 | `START_APPLICATION` is tied to 장애인연금 in the rule and in the planner prompt | **Read from code** (`rules.py:200`, `llm_planner.py:109`) |
| C6 | Error messages name the practice site on real sites: the navigation failure text and the `RECOVERING` text | **Read from code** (`agent.py:82`, `session.py:493`) |
| C7 | Popups on real sites cannot be closed by voice. `observe.js` leaves dialog buttons out of the button list | **Read from code** (`observe.js:131`) |
| C8 | The 12-action cap is shared by all goal-mode steps, so a run can be refused before step 10 | **Read from code** |
| C9 | After a discovery list, "1번은 얼마 받아?" asks which service is meant | **Not reproduced** |
| C10 | A pending discovery question takes any utterance that contains a region or an age. "부산 날씨 알려줘" becomes a profile answer | **Not reproduced** |
| C11 | The consent text can misstate where audio goes. With no server STT it names OpenAI. With `STT_BASE_URL` it says audio stays on this computer without checking the URL | **Read from code** (`app.js:60`, `app.py:46`) |
| C12 | After an interruption the first 0.6 to 0.9 seconds of the user's speech are not recorded | **Read from code**, not timed |
| C13 | The catalog source is always labelled "API 실시간" with today's date, also when it is the saved fixture | **Read from code** (`agents/welfare/agent.py:19-25`) |
| C14 | `numpy`, `av`, `onnxruntime`, and `tokenizers` are imported but not declared. They arrive through `faster-whisper` | **Read from code** |
| C15 | `README.md` cites `reports/agent-qa.md`, which does not exist, and an intent-match figure that is not in `reports/stt-eval.md` | **Read from files** |

## 15. What to cut

| # | Cut | Evidence | Note |
|---|---|---|---|
| X1 | `OpenAICompatibleIntentProvider` and its direct HTTP call (`llm_planner.py:118-179`) | In all 72 configurations, whenever this class is built, `deps.llm` is also set, and `understand` then uses the planner. Only `scripts/check_llm.py` and tests reach it | Keep `RuleBasedIntentProvider`. Fixes C2 |
| X2 | Action type `scroll` and target key `testId` | **Probe.** No emitter | Depends on decision 1. Keep `focus`, because fix 1b moves focus to a button before asking. Keep `VERIFY_FAILED`, because unit 3 of `navigating agent - implementation plan.md` uses it |
| X3 | Session states `LISTENING`, `PAUSED`, `DONE` | **Probe.** Only UI labels remain | Depends on decision 1 |
| X4 | `TurnResult.pendingActions` (always 0) and `mockOnly` (always true, never read by the UI). Two evaluation checks on them cannot fail | **Read from code** (`session.py:551`, `evaluation/__init__.py:210-221`) | Depends on decision 1 |
| X5 | `HELP_HUMAN` as a fixed "unsupported" sentence | | Replaced by A5 |
| X6 | `POST /api/audio/transcribe` and `GET /api/welfare/services` | Only tests call them. The first has no session or consent check | Decision 8 |
| X7 | Dead helpers: `WelfareInformationAgent.data_mode`, `FixtureWelfareDataProvider.notice`, `GroundedAnswer.count`, `Match.reasons`, profile key `living`, `LANG_BCP47`, `EventSink`, `VAULT_KEYS`, `LlmConfig.timeoutMs`, `SiteLinks.login`, `SiteProfile.id`, `FieldProfile.options`, `ExecutionAdapter`, the `max_steps` and `time_budget_ms` parameters of `Autopilot`, `AutopilotResult.steps`, the speech built by `application_context` | Reviewers' greps found no reader for each | Delete in one pass with the test suite as the check |

Not cut. Local STT stays an option and does not become the default until its gates pass. Clap detection, `OPEN_BROWSER`, and the three "where am I" intents stay. No evidence says they hurt, and only a user test can say whether they help.

---

# Part 3. Order, decisions, and where to edit

## 16. Proposed order

**Status, 2026-11-18.** The owner chose the order 1a, S2, vault fixes (S5 and S6), A1 with a help command, then 1b (real-site login). All five are built in the main checkout and not committed. The decision trail is `.audit/agreed-fixes.tsv`. Navigation units 0 to 2 were built separately by another session on branch `feat/navigation` in `../voice-welfare-nav`. The original table follows.

Each stage ends with a check that can be rerun.

| Stage | Work | Check |
|---|---|---|
| 0 | S1, S2, S4, S6. S3 and S5 after your decisions | `goal_submit_check.py` shows a denial or an approval request. `gate_checks.py` shows an empty vault after "응". New tests for S2 and S4 |
| 1 | A1 registry. X1, X7. X2 to X4 after decision 1 | `inventory.py`. Test suite. Utterance set per skill |
| 2 | A4 turn log. A6 reminders. A3 speech preferences | Report script output on a recorded session. Reminder test |
| 3 | A2 복지로 playbook, after the perception units of `navigating agent - implementation plan.md`. A7. A5 | 복지로 tasks in `scripts/eval_agent.py`, on your go, because it calls a paid model and real sites |
| 4 | A3 checklist on records. C-items not yet covered | Tests |

## 17. Decisions for the owner

1. **Is the TypeScript original still the reference?** CLAUDE.md says to match its behavior and its REST paths. If yes, X2 to X4 stay as they are. If this repository now leads, cut them.
2. **Risky link names on read-only sites (S3).** Block them, ask the user first, or leave as is. I recommend asking first for names that match `RISKY_BUTTON`, with 로그인 allowed because the login handoff depends on it.
   **Owner's direction, 2026-11-18.** On real sites, consequential buttons are not refused. The agent moves to the button, says what it did and why, asks for an explicit go word, and then clicks. The stated goal is that blind users depend less on other people. Login is in scope, for ID and password pages. 간편인증 and certificate login are skipped for now. Real application submission is not settled yet. The agent still never hears or types passwords, one-time codes, or resident numbers, and never bypasses a CAPTCHA or a bot wall. `CLAUDE.md` and `docs/기획요약.md` still describe the old hand-over rule.
3. **Vault and record commands before consent and while stopped (S5).** **Decided by the owner on 2026-11-18.** One rule with no exceptions. Every personal command, record command, discovery answer, and guided-fill answer waits behind both the consent gate and the stop gate. "멈춰" clears all six waits in `DialogueState`, and the stop reply says what was dropped, for example a pending vault save.
4. **Health terms as secrets.** "제 병명은 녹내장이에요" is refused as a secret today (`privacy.py:38`). For a product whose users describe a disability to find benefits, this may refuse the core use case. The alternative is to redact the term before any model sees it and still let discovery use the fact that a condition was stated.
5. **Persist the turn log (A4).** On by consent, off by default, or not at all.
6. **Save the discovery profile.** Age, disability, and income are asked again in every session. Saving them is convenient and sensitive. I recommend not saving until a user asks for it in a test.
7. **First playbook site (A2).** I recommend 복지로.
8. **Unused routes (X6).** Cut, or keep for a planned client.

## 18. Where to edit

| To change | Edit |
|---|---|
| A spoken command | Pattern in `understanding/rules.py` (order matters). Type in `core/turn.py` `INTENT_MODELS`. `LLM_INTENT_TYPES` and the prompt in `understanding/llm_planner.py`. Branch in `orchestrator/session.py` `_route`. `ALLOWED_WITHOUT_CONSENT` in `safety/gates.py`. Test in `tests/unit/test_parser.py` |
| What happens before intents (acknowledgements, filler, vague requests, question splitting) | `understanding/filters.py` |
| Free-chat routes | `understanding/chat.py` and `_free_chat` in `orchestrator/session.py` |
| What a form or browse skill says or does | `agents/web/skills/form.py`, `browse.py`, `guided.py` |
| Screen descriptions and one-time hints | `speech/screen.py` |
| Particles, date reading, chunk size | `speech/phrasing.py` |
| Fixed phrases in four languages | `FIXED` in `language/i18n.py` |
| A known site name | `KNOWN_SITES` in `understanding/sites.py` |
| What may be clicked or typed | `RISKY_BUTTON`, `SECRET_LABEL`, and the tier rules in `safety/guard.py`. Allowed origins through `EXTRA_ALLOWED_ORIGINS` |
| What counts as a secret | `KEYWORDS` in `safety/privacy.py`, `TIER1_KIND` in `safety/pii_model.py` |
| Answer checks | `safety/verify.py` |
| Goal-mode prompt, actions, limits | `agents/web/autopilot.py` |
| What the model sees of a page | Caps in `agents/web/digest.py` and `agents/web/browser/observe.js` |
| Practice form fields | `practice_site/site/apply.html` and `agents/web/profile.py`, together |
| Discovery questions and scoring | `agents/welfare/discovery.py` |
| Welfare answers and their fallbacks | `agents/welfare/agent.py`, `agents/welfare/rag.py` |
| Vault fields and commands | `personal/store.py`, `PART` and `parse_personal_command` in `personal/commands.py` |
| What the agent is waiting for | Named actions in `core/dialogue.py` |
| STT and TTS providers | `voice/config.py` and `.env` |
| Speech detection, interruption, claps | Constants at the top of `web/static/mic.js` |
| Playback and signal tones | `web/static/speaker.js` |
| REST routes | `server/app.py` |
| Session assembly and environment variables | `server/runtime.py` |
| Tray, hotkey, background mode | `apps/desktop/main.cjs` |
