# Screen pictures and desktop apps: plan

Written 2026-11-18. Status: plan only. No code is written. It waits for the owner's go and five decisions listed at the end.

## Goal

청음 works only inside a browser today, and it only reads page text. This plan adds two things the owner called essential.

1. **Pictures to explain the screen.** When the user asks, 청음 takes a picture of the screen it is explaining, sends it to OpenAI, and says what it shows. This reaches what page text cannot: photos, notices posted as images, charts, layout, a popup covering the page.
2. **Reach beyond the browser.** 청음 opens folders and files and controls basic desktop apps by voice. File Explorer is first.

## Decisions this plan is built on

- Pictures go to OpenAI. Owner decision, 2026-11-18.
- Clicks stay by name. No contract gains a screen position, and a picture answer never becomes one.
- The model never writes a command. Desktop control is a fixed set of named actions. Code builds every OS call from a table.
- Consequential actions follow "confirm aloud, then act".
- Pictures are taken on request, of one window, with personal details masked first.
- An answer read from a picture is labelled as such when spoken.
- CAPTCHA, login, identity verification and passwords stay out, as today.
- Windows first. Elsewhere the desktop feature is off.

## What the user will be able to say

```
"다운로드 폴더에 뭐 있어?"   → "다운로드 폴더에 파일 23개, 폴더 2개가 있어요. 최근 것부터 1번 기초연금 안내 PDF 파일, 오늘. …"
"1번 읽어줘"                 → reads the PDF or HWPX text in chunks. No window needed.
"목록 더 알려줘" · "뒤로 가줘" → the same words as on the web, now inside a folder.
"신청서 파일 열어줘"          → "'다운로드' 폴더의 '신청서.hwp'를 열려고 해요. 인터넷에서 받은 파일이라 여쭤봐요. 열려면 '진행해'라고 하세요."
"설치 파일 열어줘"            → "'설치.exe'는 프로그램 파일이라 말로 실행하지 않아요."
"화면 사진으로 설명해줘"      → "사진으로 보면 위쪽에 '긴급 안내' 팝업이 있어요. … 숫자는 사진에서 읽은 것이라 확인하지 못했어요. 누를 수 있는 것은 1번 '닫기'예요."
"1번 눌러줘"                 → the existing click path, by name.
"메모장 열어줘" (not built yet) → "메모장은 아직 열 수 없어요." It no longer becomes a Naver search.
```

## Shape

The design keeps one of everything that guards the user: one guard, one run path, one approval gate, one action log. The desktop gets its own strict action type next to the web one.

**Desktop**

- **App table** (`core/apps.py`). One row per app: spoken names, access tier, allowed verbs, the fixed launch recipe, and the picture policy. One row per folder place: 다운로드, 문서, 바탕 화면, 사진, 음악, 동영상. This table is the allowlist, the name resolver's source, and the source of the OS call. A row with tier `none` gives the "아직 열 수 없어요" answer.
- **App action** (`core/desktop.py`). A strict type with a closed verb list. Its target is an app id, a place id, and names copied from a folder listing. It holds no path string, no command line, no key chord, no window handle and no coordinates. One function turns a place plus names into a real path and checks that it stays inside the place.
- **Guard.** `PolicyGuard.check` gains one branch for app actions. The tier comes from the app table, where today it comes only from a URL origin. Programs, scripts and shortcuts are refused with a spoken reason. Files marked as downloaded from the internet and unknown file kinds ask first.
- **Run path.** The body of today's `WebExecutionAgent._run` moves into one shared executor. Both agents call it, so the action log rule, the retry rule and the stop check exist once.
- **Approvals table** (`orchestrator/approvals.py`). One row per approval kind: which world to re-observe, what was not done, what runs, and what "거절" says. This also fixes two traps that exist today: a new approval kind raises `KeyError` in `NOT_DONE`, and refusing any new kind says "모의접수를 하지 않았어요".
- **File Explorer is driven through the file system.** The folder listing comes from the file system: complete, fast, and testable on a temp folder. The Explorer window is told to show the same folder, best effort. Measured on this PC: a minimized Explorer window exposes only its title bar to UI Automation, so reading the window's list is not reliable.
- **OS boundary** (`agents/desktop/port.py`). One small interface holds every Windows call. A null version turns the feature off. A fake version backs the tests.
- **Which screen the user is on** is the session state. A new state `APP_OPEN` sits beside `BROWSING`. Existing words (목록 더, 뒤로, 화면 설명, 1번) are routed by that state, so the user learns few new sentences.

**Pictures**

- **Sealed picture** (`core/picture.py`). A `Picture` exists only after masking. Only the two capture functions can build one, and a structure test enforces that. The vision model has its own method that accepts only a `Picture`. The text method keeps `user: str`, so a text-only local model can never be handed an image.
- **New model role** `LLM_VISION_*`. It is built only when the provider is OpenAI.
- **Mask plan.** A pure function decides what to hide from what 청음 already observed: every input, every embedded frame, the visual cursor, and each text block where personal details are detected. The page marks its text blocks and the existing detector judges them. If a block that must be hidden cannot be located, no picture is taken.
- **Refusals.** Login, identity-verification, blocked and CAPTCHA screens are refused before capture. If the model reports a CAPTCHA or a login in what it saw, the answer is discarded.
- **Capture is a guarded action.** It passes the guard, the turn limit and the sealed action log like a click does.
- **What the model may return.** One description, and index numbers into a list of names that code built from the observed items. It cannot return a new name, an action, an address or a position. Names it picked are offered as "누를 수 있는 것", and pressing goes through the existing name-based click.
- **Answer checks.** The description is passed through the personal-detail filter. Numbers that the page text does not contain are spoken with a label. The answer always says it came from a picture. Picture text never enters intent understanding, and the planner's history gets a code-written placeholder.

## Build order

Every unit ends with the full test suite green. No unit edits `demo_scenarios.json`. No test calls OpenAI or touches a real desktop.

**Spikes first.** Each ends in a number or a yes/no.

| Id | Question | Decides |
|---|---|---|
| S1 | Does the owner's OpenAI model accept an image with a strict schema? Latency and cost at two image sizes, on Korean notices. | Image size, timeout, whether auto-pictures are affordable. Needs the owner's go: it uses the API key. |
| S2 | Does a screenshot work on a background tab of shared Chrome, with masks landing on the right pixels? | Whether pictures work in Chrome mode without bringing the window forward. |
| S3 | Can Explorer be told to show a folder and select a file through the Shell interface, including Windows 11 tabs and minimized windows? | Whether the window follows 청음, or each folder opens a new window. |
| S4 | Rule parity: run the real rule parser over every existing example in every state, plus the new sentences. | The exact new rules. No existing sentence may change meaning. |
| S5 | Do UI Automation rectangles line up with captured pixels at 100% and 150% display scaling? | Whether app-window pictures can be masked. |
| S6 | Listening test: 20 real file names read aloud. | How extensions and underscores are spoken. |

**Milestone 0. Safe ground (no behavior change).**

| Unit | What | Check |
|---|---|---|
| U0 | Move `ExecContext` into `core`. | Suite green, no test file changes. |
| U1 | Extract the shared executor from `_run`. | Parity table: retry only for low-risk unapproved timeouts, `LOG_FAILED`, aborted, counter, log rows. |
| U2 | Approvals table with the three existing kinds. | Spoken sentences byte-identical. Structure test: every approval kind used is in the table. |

**Milestone 1. Folders by voice, read only.** File system only: no window control, no OpenAI.

| Unit | What | Check |
|---|---|---|
| U3 | App table, app action, guard branch. | Table tests: coordinates, path strings, `..`, a symlink out of a place, programs and unknown apps are all refused. |
| U4 | New sentences and intents. | S4 parity table, registry tests at the new count. |
| U5 | Pure listing and narration. | Temp-folder tests: hidden files skipped, recent first, ambiguous names ask back. S6 sign-off. |
| U6 | Agent, skill, wiring with the fake port. | End-to-end: list, "1번 읽어줘", more, back, stop mid-list, no file name in model history, one fixed sentence when the feature is off. |

*First thing a user can feel:* "다운로드 폴더에 뭐 있어?" then "1번 읽어줘".

**Milestone 2. The Explorer window and opening files.**

| Unit | What | Check |
|---|---|---|
| U7 | Windows port: known folders, launch, show folder. | Opt-in test on a temp folder. Server still imports with the Windows library missing. |
| U8 | Open a file after confirming aloud. | Asks then opens once. A file changed after the question is not opened. Programs refused. Two minutes later it asks again. Stop clears it. |

**Milestone 3. Picture explanations on the web.**

| Unit | What | Check |
|---|---|---|
| U9 | Picture type and vision client. | Request body has one image part and a strict schema. A non-OpenAI provider builds nothing. |
| U10 | Mask plan, refusals, capture in the adapter. | Pixel tests on the practice site: typed text, a resident number paragraph and a frame are black; the cursor is absent; login and CAPTCHA pages are never captured. |
| U11 | Answer checks and the spoken answer. | Out-of-range indexes dropped, CAPTCHA answer discarded, unconfirmed numbers labelled, personal details removed. |
| U12 | Wiring: "화면 사진으로 설명해줘", then "1번 눌러줘". | End-to-end with a fake vision model. The click goes through the name-based path. |
| U13 | Vision quality check on 10 saved pages, opt-in, real OpenAI. | Report: refusal correctness, latency, cost, number accuracy. Gate for turning pictures on. |

*Second thing a user can feel:* a notice posted as an image is read aloud.

**Milestone 4. More apps and pictures of app windows.** One app per unit, in the order below. Adding an app should need one table row plus tests. If it needs more, the table is wrong and the design is revisited.

## Apps, in proposed order

| # | App | The user's need | Example | Risk |
|---|---|---|---|---|
| 1 | 파일 탐색기 | Find a file someone sent, hear it, open it. | "문서 폴더 열어줘" | Low. No delete, move or rename. |
| 2 | 소리와 컴퓨터 상태 | Volume, battery, Wi-Fi, time, without finding the tray. | "소리 키워줘", "배터리 얼마나 남았어?" | Low. Volume never goes to silent, since a silent 청음 strands the user. |
| 3 | 열린 창 목록 | Know what is open and get back to it. | "지금 열린 창 뭐 있어?" | Low. Titles of other apps are not sent to any model. |
| 4 | 메모 | Leave a short note and hear it later. | "메모해줘 내일 10시 주민센터" | Medium. Notes are saved as files by code, not typed into a window. Secrets are refused. |
| 5 | 문서·사진 설명 | Hear what a scanned document or a photo shows. | "이 문서 사진으로 설명해줘" | High for privacy. Nothing in a photo can be masked, so it asks every time. |
| 6 | 음악·동영상 | Play from the Music folder. | "음악 폴더 1번 틀어줘" | Low. "멈춰" stays 청음's stop word. |
| 7 | 설정 | Reach sound, text size, contrast, Wi-Fi pages. | "글자 크게 하는 설정 열어줘" | Medium. A fixed list of pages. Each switch asks first. |
| 8 | 메모장, 계산기 | Dictate into a window, press buttons by name. | "메모장 열어줘" | Medium. Proves named control of a real window. |

Later, with an owner decision first: 카카오톡 (reading only at first), old HWP documents, mail. Never: banking, certificates, identity-verification apps.

## How this plan was chosen

Four independent designs were written from the same brief and the same grounding, and an independent judge scored them. Scores: 26, 25, 24 and 15 out of 30. All four agreed on a strict separate action type for the desktop, the file system as the source for Explorer, an app table as the allowlist, and refusing pictures of login and CAPTCHA screens.

- **Base: candidate 3.** One guard, one run path, the smallest OS interface, and the approvals table that closes two existing traps.
- **From candidate 2:** the sealed picture with its own model method, index-only answers, a place plus names instead of a path, existing words working inside folders, and dropping the form's value wait when the user leaves a form.
- **From candidate 1:** the read-only folder slice as the first thing a user feels, marking text blocks for masking, the internet-download check before opening a file, notes saved as files, and three of the spikes.
- **From candidate 4:** the picture decision as one pure table test.
- **Rejected:** a second guard and a second run path (rules drift apart); an image argument on the text model method (a text model could be handed an image); refusing every page with an embedded frame (many real pages have one, so pictures would rarely work); choosing web or desktop by guessing from the front window (a wrong guess describes the wrong screen); rules that depend on which screen is open (the judge found "복지로 열어줘" said inside a folder would be read as a file name).

The four design packages, the grounding and the judge's rubric were in `.audit/desktop-vision/` and were removed in the 2026-11-24 doc cleanup. They remain in commit `cf1a482`.

## Risks

- **Masking is narrower than the text filter.** Personal details inside an image on the page cannot be detected before capture. The defences are refusing whole screen kinds, masking what is known, and filtering the answer.
- **The refactors touch the most safety-critical code** (`_run`, `_approve`). Milestone 0 exists so that they land alone, with parity tests, before any feature.
- **Windows facts are unmeasured** until the spikes run. Each spike has a fallback that keeps the feature, with less polish.
- **Another session is editing this checkout** (the cursor work in `browser/__init__.py`). Capture adds methods to that file, so the work should start from a clean base.

## Decisions for the owner

1. **Numbers seen only in a picture.** Recommended: speak them with a label. A notice posted as an image has no text to check against, so dropping them defeats the purpose.
2. **A question before sending a picture.** Recommended: none when the user asks for a picture, because the request is the consent, and the consent text will say pictures go to OpenAI. Ask "사진으로 볼까요?" only when 청음 itself wants to add a picture on a page with little text.
3. **What "다운로드 폴더" means.** Recommended: the Windows Downloads folder. In the desktop app the browser saves there too, so "받은 파일" and "다운로드 폴더" are one place.
4. **Opening a document.** Recommended: reading a file's text never asks. Opening it in its program asks when the file came from the internet or its kind is unknown.
5. **The app order above,** and whether spike S1 may run. S1 makes about 15 small OpenAI calls.
