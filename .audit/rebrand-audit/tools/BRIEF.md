# Rebrand audit brief (shared by every worker; do not edit)

## Goal

The repo at `C:\Users\user\Desktop\voice-welfare` is 청음 (code name `cheongeum`), a Korean voice web agent. Until today it described itself as a tool for blind people (시각장애인). The owner has rebranded it to serve **정보취약계층**: 고령층, 장애인, 저소득층, 농어민, 결혼이민자, and anyone else who finds it hard to use public services on the web alone. Blind users remain one group inside that audience, so working without looking at the screen stays a design requirement. Features are not being changed by this audit.

The owner asked: "find which parts need changes, do not miss any". Your job is to read every file in your slice **in full** and report every place that needs to change, or should be considered, because of the rebrand. This is read-only. Do not edit any repo file. Do not run tests, servers, or the app (other sessions share port 5174).

Read `CLAUDE.md` and `docs/기획요약.md` first for product context (both already rebranded).

## Already changed in this session (verify, don't re-report unless wrong)

`CLAUDE.md` lines 7 and 58; `README.md` lines 1-4 and 173; `pyproject.toml` description; `docs/기획요약.md` (title, 한 줄 정의, new 대상 section, 문제, 채널 확장 line, 검증 계획 line); `docs/user-test/plan.md` lines 1-3; `docs/superpowers/specs/2026-11-18-sound-cues-design.md` line 5; `scripts/run_scenarios.py` "측정하지 않은 것" first bullet; `apps/desktop/main.cjs` line 18 comment; LLM system prompts in `understanding/chat.py`, `agents/web/autopilot.py` (SYSTEM), `agents/welfare/agent.py` (RAG_SYSTEM and the service_brief prompt), `language/i18n.py` (both translate prompts), `orchestrator/session.py` (rephrase prompt), `speech/screen.py` (page_summary prompt), `core/picture.py` (PICTURE_SYSTEM), and the `ScreenOutline` docstring in `core/actions.py`. If one of these now reads badly or is inconsistent, report it.

## What counts as a finding

Use exactly one category per row.

- **ID** (identity wording). Text that names blind or visually impaired people as THE audience, user, or persona of 청음, or that describes 청음's purpose narrowly for them. Look for 시각장애, 시각 장애, 맹인, 전맹, 저시력, 눈이 보이지, 보이지 않아서, 화면을 볼 수 없, 화면낭독기 사용자, blind, visually impaired, low vision, VI user, screen reader user, and paraphrases. NOT a finding: blind users mentioned correctly as one group among 정보취약계층; real welfare program names or official data (e.g. a program for 시각장애인); comments about screen-reader compatibility that stay true.
- **ASSUME** (blind-only behavior or UX). Code, UI, flow, timing, or default that is built on the premise that the user cannot see the screen or runs a screen reader, and that therefore serves a sighted but digitally inexperienced user (an older adult, a migrant, someone with low literacy) badly. Say what the assumption is, who it fails, and the concrete effect. Example shape: "after the login handoff TTS goes silent so the screen reader can read the field; a user with no screen reader hears nothing".
- **PLAIN** (plain language). User-facing Korean text, meaning text spoken by TTS or shown in the UI, plus LLM prompt instructions that dictate the wording users hear, that uses words a 정보취약계층 user may not know. Candidates: 링크, 탭, 팝업, URL, 주소창, 브라우저, 스크롤, 클릭, 다운로드, 업로드, 캡처, 세션, 모드, 에이전트, 프로필, 포커스, 초점, 핸드오프, 인계, 단축키, 본문, 비식별, 토큰, API, LLM, TTS, STT, English words, and abbreviations. Use judgment: 버튼, 사이트, 화면, 로그인 are common enough; report when a plainer phrase clearly exists. One row per string, every string, not samples. Log messages, exception text never shown to users, and code comments are NOT user-facing.
- **GAP** (audience coverage gap). A feature, list, data set, setting, test plan, or evaluation whose scope leaves out a 정보취약계층 group in a way that matters. Examples to check: supported conversation languages against the main languages of 결혼이민자 in Korea; 맞춤 찾기 questions that cannot express a group's situation; help text and example phrases; STT evaluation sentences and speakers; evaluation personas and scenarios; user-test recruitment and tasks; consent and onboarding flow; speech rate, volume, repetition; text size, contrast, and visual feedback in the UI. State the group, what is missing, and the evidence in the file.
- **META** (names and metadata). Product names, titles, package or app metadata, installer text, tray text, app ids, doc titles, diagrams, file names that encode the old audience.
- **COUPLED** (tests and fixtures that pin text). A test or fixture that asserts a string or behavior you reported elsewhere (ID, ASSUME, PLAIN), so changing that code means changing this test. Name the code location it pins.

Severity, one per row:
- **must**: contradicts the new purpose or would mislead a reader about who 청음 is for.
- **should**: hurts or leaves out part of the new audience; a change is advisable.
- **consider**: a judgment call or product decision; give the trade-off in `why`.

For dated records (research notes, `drafts/research results/`, past plans), report ID findings as `consider` and say in `why` whether the doc is a dated record to leave or a forward plan that future work will follow.

Do not report: stale numbers or facts unrelated to the audience, code quality, bugs unrelated to the rebrand.

## How to read

Read every file in your slice from first line to last with the Read tool (use offset/limit for long files and continue until the end). Grep alone does not count. For `.docx`, extract text with `python -I -c "import zipfile,re,sys; x=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode(); print(re.sub(r'<[^>]+>',' ',x))" <path>` and read all of it. For JSON data, read it all.

## Output

Write one UTF-8 TSV file at the path your brief gives you. No header. Tab-separated, 7 columns, no tabs or newlines inside a field:

`path	line	category	severity	excerpt	why	suggestion`

- `path`: repo-relative with forward slashes, exactly as in your slice list.
- `line`: 1-based line number (use the first line for multi-line strings), or `-`.
- `excerpt`: at most 120 characters of the actual text.
- `why` and `suggestion`: at most 200 characters each. `suggestion` may be Korean.

For EVERY file in your slice, also write exactly one coverage row:

`path	-	CHECKED	-	<number of finding rows for this file>	<full|chunks|docx-text>	-`

A file with no findings still gets its CHECKED row with 0. Write the file once at the end, or append as you go; either way the final file must contain all rows.

## Final message

Reply with: the output path, the number of files checked, finding counts per category, and the three findings you think matter most. Nothing else.
