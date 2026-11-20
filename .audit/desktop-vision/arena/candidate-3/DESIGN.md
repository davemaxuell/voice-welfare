# DESIGN: picture explanations and desktop apps for 청음 (candidate 3)

Stub detail is in `sketch/`. Build order is in `PLAN.md`. The app list is in `APPS.md`.

## Problem

청음 sees the web through one DOM snapshot and acts through one guarded path. No pixel and no desktop call exists in `src/`. Two facts make the shape non-obvious.

- The web assumption is deep. `Observation.url` is required (`core/actions.py:189`). The guard tiers by URL origin only (`safety/guard.py:93`, `:116`), and a non-http scheme has origin `"null"` (`core/jsutil.py:108-111`). The approval fingerprint keys on origin and path (`agents/web/approval.py:17`). `_finish` and `_approve` read `self.web` (`orchestrator/session.py:597`, `:1127`).
- Pixels have no redaction. `redact_text` cuts text (`safety/privacy.py:165`). A typed name is on screen as well as in the DOM.

All fixed decisions in `TASK.md` stand.

## Usage (caller's view)

What the blind user hears. The first slice is Explorer: no network, no consent, no cost.

```
User: 파일 탐색기 열어줘
청음: 파일 탐색기를 열었어요. 어느 폴더로 갈까요? 다운로드, 문서, 바탕 화면, 사진 중에서 말씀해 주세요.
User: 다운로드 폴더 열어줘
청음: 다운로드 폴더예요. 폴더 2개, 파일 14개가 있어요. 최근 것부터, 이력서 PDF 파일, ... 더 들으시려면 '더'라고 하세요.
User: 사진으로 화면 설명해줘        (web page, later slice)
청음: '복지로' 화면의 사진을 OpenAI에 보내서 설명해 드릴 수 있어요. 이름이나 번호를 적는 칸은 가려서 보내요. 보낼까요?
User: 응
청음: 사진으로 보면 위쪽에 '긴급 안내' 팝업이 떠 있어요. 눌러 볼 수 있는 것: 닫기. (AI가 사진을 보고 말하는 거라 틀릴 수 있어요.)
```

What the code reads. These call sites are the spec, and the sketch is derived from them.

```python
# BrowseSkill.screen: the picture extends the text answer, never replaces it
advice = self.sight.advise(facts_from_view(view), text, ctx.grants)   # pure: text | ask | both | refuse
seen = await self.sight.describe(self.web, facts, text, ctx)          # capture, look, verify, label

# AppSkill.open_item: no model ever sees a file name
out = await self.agent.open_item("다운로드", ctx)                      # AppOutcome(view=WindowView)
return draft("APP_OPEN", "open-item", speak_window(out.view), surface="app", page="app:explorer",
             access="full", historySpeech="폴더 내용을 읽어 줬어요.")
```

## Shape

**Seven types carry it.**

1. `MaskedShot` (`core/vision.py`). A picture that cannot exist without a complete `MaskReport`. No public bytes. Only `OpenAIVisionLlm` reads it.
2. `ScreenFacts` (`core/vision.py`). What text already knows about a screen, web or app. The picture path sees only this and a `ShotSource`.
3. `AppSpec` table (`core/apps.py`). One row per app: spoken names, tier, verbs, fixed launch argv. It is `KNOWN_SITES` (`understanding/sites.py:22`) and `allowedOrigins` in one row.
4. `AppAction` and `WindowView` (`core/desktop.py`). Strict named verbs addressed by `place` or `folder` plus one `name`. No coordinates, handle or free text.
5. `DesktopPort` (`agents/desktop/port.py`). The only OS boundary. `NullPort` turns the feature off. `FakeDesktopPort` tests it.
6. `ApprovalKind` table (`orchestrator/approvals.py`). One row per kind: world to re-observe, what was not done, what runs. It replaces three `if` branches and `NOT_DONE` (`session.py:73`, `:1142-1149`), which raises `KeyError` on a new kind.
7. `APP_OPEN` session state. The one fact that says which screen the user is on. Web turns return `BROWSING`, app turns return `APP_OPEN`, and `_finish` commits it (`session.py:593`). No separate focus field.

**Picture path.** `plan_shot(view)` is pure. It refuses blocked, login and verification screens (`digest.py:17`, `auth_page.py:55`). Otherwise it plans: mask every input and iframe, mask each line `detect_sensitive` flags, hide the cursor overlay (`cursor.js:18`). The Playwright adapter runs the plan on its own tab, so "the explained window only" is structural. A flagged line it cannot find means no capture. Capture is an `Action` of type `capture`, so it passes the guard, writes the sealed action log and obeys the turn limit. Pixels never enter `Action` or `ActionResult`. The first picture asks aloud through the approval slot (kind `shot`). The grant is one set owned by the orchestrator, and STOP clears it.

**Answer path.** `Sight.describe` calls `VisionModel.look`, then `compose` checks the answer. The summary keeps only numbers found in page text, title, the user's words or a verbatim quote. Otherwise it is dropped and the quotes are read as "사진에 이렇게 적혀 있어요". A quote with a URL absent from page text is dropped. Text aimed at an AI gets the existing caution (`speech/screen.py:123-127`). The schema has no action, URL or coordinate field. Speech starts with "사진으로 보면", after the text answer.

**Acting on a picture.** The model lists control labels. Code intersects them with `outline.items` names. The user hears "눌러 볼 수 있는 것" for the intersection only, and pressing goes through `follow_link` by name (`agents/web/agent.py:190`). Picture-only items are described, never pressed.

**Desktop path.** `agents/desktop` is a sibling of `agents/web` with its own contracts and a shared door.

- One door. `PolicyGuard.check` dispatches on `type`. App tier comes from `PolicyConfig.apps`, built from `APPS`. Paths are checked against known-folder roots with `within_roots` (realpath), in the guard and again before the effect. A file opens only if its extension is on an allow-list. `.exe`, `.lnk` and scripts are refused with a spoken reason.
- One run path. `GuardedExecutor` is `WebExecutionAgent._run` (`agent.py:499-559`) extracted, so LOG_FAILED, the TIMEOUT retry rule and the action log exist once.
- One log, one `ActionResult`, one approval slot with the 120 s TTL. `ExecutedAction.action` takes `Action | AppAction`.
- Explorer is driven by the filesystem. `os.scandir` is the truth. The window only follows through Shell COM `Navigate2`, best effort. UIA is not used for Explorer: a minimized window exposes no items (probe-facts), and a UIA click hides the path from the guard.
- No name reaches a model. File names are spoken from rules (`speech/apps.py`), and `historySpeech` keeps them out of `_history`, which feeds the planner (`session.py:601`, `:707`).

**Utterances.** Four new intent rows: `OPEN_APP`, `APP_OPEN_ITEM`, `APP_LIST`, `APP_UP`. One rule block goes before `READ_DOWNLOAD` (`rules.py:176`) and `DESCRIBE_SCREEN` (`rules.py:197`). Today "다운로드 폴더에 뭐 있어?" reads as browser downloads and "바탕화면에 뭐 있어?" as a screen description. `Place.bare_ok` keeps "다운로드 읽어줘" as `READ_DOWNLOAD` (`intents.py:167`). A `topic_param` column replaces the hand branches in `flat_to_intent` (`llm_planner.py:72-89`). A row with `tier="none"` answers "아직 열 수 없어요", so "메모장 열어줘" no longer becomes a Naver search.

**Explain this window.** `DESCRIBE_SCREEN` routes by state (`session.py:1233`). In `APP_OPEN`, `AppSkill.describe` re-reads the folder and narrates by rules. Apps marked `picture_ok` reuse `Sight` with `capture_window` (PrintWindow of that one window, UIA edit boxes masked) in stage 3.

**Depth.** `Sight` has two methods and hides policy, mask contract, model call, abort, verification and labels. `DesktopAgent` has five verbs and hides guard, path rules, window sync and log. `Win32Port` has six calls and hides threads, COM and timeouts.

**Encoded.** An unmasked picture is unconstructible. An unknown verb, app, coordinate or path-bearing name fails `AppAction` validation. `test_layers.py` keeps `core` importing nothing and keeps `agents.web` and `agents.desktop` apart. AST tests count `MaskedShot(` sites (two adapters), OS imports (one file) and `ask_approval` kinds (all in the table).

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- A spoken list may differ from what Explorer shows (libraries, OneDrive placeholders). In exchange the guard sees every path and tests run offline.
- A second contract (`AppAction`) sits beside `Action`. In exchange no fake URL scheme leaks into the web guard.
- U1 touches `_run`. In exchange both worlds share one run path.
- Code cannot prove a number read from a picture. We label every picture answer and limit image-only numbers to verbatim quotes.
- One spoken question precedes the first picture, and again after STOP. Opening a file always asks. Reading its text does not.

## Alternatives considered

- **Pseudo-URL `uia://explorer/...` through the web contracts.** Tier `none`, and adding `"null"` to `allowedOrigins` makes every non-http URL `full`. It hides the path from the guard.
- **UIA-driven Explorer.** A minimized window shows 0 items, an invoked `.exe` runs code the guard never saw, the first call costs 643 ms, and tests need a real desktop.
- **Image parts in `generate(user: str)`.** `FakeLlm` and `scripted()` assume a JSON string (`tests/conftest.py:98`, `:129`), the WEB role may be a local text model, and a plain part cannot carry proof of masking.
- **A second guard for apps.** Two doors drift. One `check` with two branches is one door.
- **A sticky `DialogueState.app` field.** Every route back to the web must remember to clear it. State already holds the fact.

## Implementation reconciliation

None yet.

## Open questions and risks

- Does strict `json_schema` work with an image on the owner's model, and what are p50 latency and cost? (S1)
- Does `page.screenshot` return promptly on a background tab of headed shared Chrome? (S2)
- Does Shell COM `Navigate2` follow a minimized Explorer window from a worker thread? If not, is "창으로 보여줘" on request enough? (S3)
- Should STOP revoke the picture grant? The sketch says yes.
- Is an extra "열까요?" before opening a file acceptable to blind users?

## Next implementation step

Run spikes S1 and S3 in parallel, then U0: move `ExecContext` into `core/execctx.py`.
