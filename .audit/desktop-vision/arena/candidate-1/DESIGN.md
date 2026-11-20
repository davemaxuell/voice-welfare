# Candidate 1: a sibling desktop agent and one guarded picture call

## Problem

청음 reads a page from one DOM snapshot and acts only through `WebExecutionAgent._run` (`agents/web/agent.py:499`). The owner wants two more things: an OpenAI picture of the screen for what text cannot reach, and named control of desktop apps, File Explorer first. Every seam is web-shaped. `Observation.url` is required (`core/actions.py:189`). The guard tiers by URL origin (`safety/guard.py:116`). The fingerprint keys on origin plus path (`agents/web/approval.py:57`). `_approve` re-observes the browser (`orchestrator/session.py:1127`). `_finish` falls back to the browser view (`session.py:597`). `ExecutedAction.action` is the web `Action` (`core/turn.py:161`). `generate` takes `user: str` (`core/llm.py:98`). Fixed: no coordinates, no model-written commands, confirm aloud then act, on-demand pictures of one masked window, labelled image answers, no CAPTCHA or credentials, Windows only, offline tests.

## Usage (caller's view)

What the user hears:

```
"다운로드 폴더에 뭐 있어?"  → "다운로드 폴더에 파일 23개, 폴더 2개가 있어요. 최근 바뀐 순서로 읽을게요. 1번 기초연금 안내 PDF 파일, 오늘. …"
"1번 읽어줘"                → PDF text, read in chunks ("계속 읽어줘").
"신청서 파일 열어줘"         → "'다운로드' 폴더의 '신청서.hwp' 파일을 열려고 해요. 인터넷에서 받은 파일이라 열기 전에 여쭤봐요. 열려면 '진행해', …"
"진행해"                    → opens once; "'신청서.hwp'를 열었어요. 새 창 '신청서.hwp - 한글'이 떴어요."
"설치 파일 열어줘"           → "'설치.exe'는 프로그램 파일이라 말로 실행하지 않아요. 앱은 '파일 탐색기 열어줘'처럼 이름으로 말씀해 주세요."
(browser) "화면 사진으로 설명해줘" → "화면 그림을 보고 말씀드릴게요. 기초연금 인상 안내 포스터예요. … 34만 2,510원은 그림에서만 보이는 숫자라 확인하지 못했어요. …"
(Alt+Tab to another app) "이 창 설명해줘" → "'카카오톡' 창이에요. 제가 조작할 수는 없고 읽어 드리기만 해요. …"
```

Call sites:

```python
# orchestrator/session.py ROUTES: one route per intent, surface decided once per turn
"LIST_ITEMS": lambda s, i, t: s.desktop.list_items(i.get("target"), i["more"], t.focus, t.ctx),
"DESCRIBE_SCREEN": lambda s, i, t: s.desktop.describe(t.text, t.focus, t.ctx) if _on_desktop(t) else s.browse.screen(t.text, t.ctx),

# agents/web/skills/browse.py BrowseSkill.screen: a skill never touches bytes, base64 or schemas
source = choose_source(asked=picture_request(text), text_chars=len(d.main), visuals=visuals(view), refused=refused, mode=self.picture.mode)
answer = await self.picture.explain(self.web.shot_source(view), ctx, session_state=self.dialogue.state)

# orchestrator/session.py _approve: one gate, two owners
owner = self.desktop if approval.get("surface") == "desktop" else self._web_approvals
checked = await owner.recheck(approval, turn.ctx)          # changed → drop and say what changed; 2 min → ask again
with turn.ctx.granted(ids):
    return await owner.run_approved(approval, turn.ctx)
```

## Shape

**Data first.** Six types carry the design. The sketch has them with Korean docstrings.

- `DesktopAction` (`core/desktop.py`) is a strict sibling of `Action`. Its `type` is one of six verbs: `launch_app`, `show_folder`, `select_item`, `open_file`, `read_file`, `focus_window`. Its target is an `AppId`, a `PlaceId` and name parts copied from a listing. There is no path string and no coordinate, so neither a model nor an utterance can name an arbitrary file or point. `ExecutedAction.action` becomes a union discriminated by `type`.
- `DesktopView` (`agents/desktop/model.py`) is rebuilt on every observe and never synced. Folder content comes from the filesystem. The Explorer window's folder and selection come from the Shell automation API. Foreign windows give UIA names.
- `Focus` says which surface a turn talks about. `resolve_focus` is a pure function of the foreground window now and `FocusMemory`, which only `_finish` writes. A user who switched windows wins. 청음's own window or an unchanged foreground keeps the last surface.
- `ShotSubject` and `MaskedShot` (`core/shot.py`). A `MaskedShot` cannot be built without a complete `MaskReport`. A capture that cannot mask returns `CaptureRefusal`. Unmasked pixels have no type to travel in (type-system-discipline).
- `PictureAnswer` (`vision/picture.py`) holds finished speech with a fixed label, the numbers text could not confirm, and the visible names that equal observed item names.
- `Rechecked` (`core/context.py`, beside the moved `ExecContext`) is what an approval owner returns to the single gate.

**Load-bearing decisions.**

1. *Desktop is a sibling agent with the web agent's discipline.* `DesktopAgent._run` is guard, log "before", path re-check, `DesktopPort.execute`, log "after", re-observe. Only the port builds OS calls. `resolve_in_place` re-checks the real path under the known folder right before each call, as `_resolve_ref` re-checks role and name (`browser/__init__.py:516`). Per boundary-discipline.
2. *The guard tiers by app identity.* A registry entry matches process image plus window class, never title. Registered apps are `control` with a per-app verb set. Other windows are `describe`. Credential and certificate windows are `none`. Executables and shortcuts are denied with a spoken alternative. Macro documents and files carrying the internet zone mark need confirmation. Risk still only goes up.
3. *Explorer is driven by path, not clicks.* The filesystem is the content model: complete, not virtualized, testable on `tmp_path`. Shell.Application moves and selects the real window so a screen reader or helper sees the same thing. UIA reads only windows that have no API.
4. *One approval gate.* `_approve` keeps the 2-minute TTL and the "what changed" sentence. Owners recheck and run. The web owner holds today's `click/assist/submit` dispatch, so the `NOT_DONE[kind]` KeyError trap (`session.py:73`) goes away. The desktop fingerprint holds verb, place, name parts, the entry's size and mtime, and the spoken question. Window titles stay out, as body text does today.
5. *A picture is one deep call.* `ScreenPicture.explain(source)` runs shot policy, masked capture, the OpenAI call with an image part, parsing, PII filtering of the output, number labelling and name matching. Masks come from what 청음 already observed. Web: every input, contenteditable, cross-origin frame and text block where `detect_sensitive` fires. Desktop: editable and password controls and names with personal data. Mask rectangles never leave the capture code.
6. *Words.* Four rows join `INTENTS` (`OPEN_APP`, `LIST_ITEMS`, `OPEN_ITEM`, `READ_ITEM`) under a new help group 컴퓨터, reusing the `target`, `name` and `more` parameters so the flat LLM schema does not change. One rule block sits after `CLEAR_LOGIN` (`rules.py:174`). It fires only on app or place names or on 파일, 폴더, 문서. Numbered picks stay `UNKNOWN`. `_unknown` gives them to whichever skill last read a numbered list (`listed_at`, compared at read time, per separate-before-serializing).

**The task's questions, answered.**

| Question | Answer |
|---|---|
| Image to model | `generate(..., images=())` puts a content list in the user message. A new `LLM_VISION_*` role is built only for OpenAI. The WEB role is never sent an image. |
| Who captures and masks | Web adapter `capture(plan)` and `WindowsDesktop.capture_window`. Pure `plan_masks` and `should_mask` decide from observed fields and `detect_sensitive`. |
| Picture or text | `choose_source`: asked, or text under 200 chars with visuals, else text. Never in `page_intro` or the goal loop. Picture speech always starts "화면 그림을 보고 말씀드릴게요." or "그림으로 보면,". |
| CAPTCHA, login, verification | `refuse_capture` before (BLOCKED, captcha frames, `auth_page_kind`, password fields, `AUTH_HANDOFF`, credential windows). The model's `blocked` flag after discards the reading. |
| Numbers, injection | Numbers missing from observed text are spoken as unconfirmed, not dropped, because an image notice has no text alternative. The schema has no action field. Vision text never enters `_understand`. Approval words stay rule-only. |
| Acting on a picture | Only vision labels equal to observed `outline.items` names are offered. The user says the name and `follow_link` matches it as today. |
| Desktop placement | Sibling `agents/desktop` with `DesktopGuard`, `DesktopAction`, its own fingerprint, the shared action log and `ExecContext`. `TurnResult` reports it through `SurfaceReport`. |
| App naming | `understanding/apps.py` mirrors `sites.py`. `agents/desktop/registry.py` holds launch and match specs. Both assert they cover `core.desktop.AppId` at import. |
| Tests | `FakeDesktop` (memory windows, real `tmp_path` folders) and `FakeVision`. Real Chromium stays offline. |
| First felt slice | "다운로드 폴더에 뭐 있어?" then "1번 읽어줘". Filesystem only. No COM, no OpenAI. |

**Interface depth.** Skills see `DesktopAgent` (observe, launch, show, point_at, open, read) and `ScreenPicture.explain`. COM threading, Windows 11 Explorer tabs, DPI, PrintWindow, Zone.Identifier, mask painting, data URLs and strict schemas all sit behind them.

**Not done.** No coordinates. No generic UI clicks. No file writes, moves or deletes. No programs launched from files. No picture on every step. No typing into desktop apps in v1.

## Synthesis decision

Not applicable. This is one candidate.

## Tradeoffs accepted

- We accept two execution agents with parallel shapes in exchange for contracts that each mean one thing.
- We accept an owner indirection in `_approve` in exchange for one TTL and recheck gate for every surface.
- We accept listing from the filesystem, which may differ from Explorer's sort and view settings, in exchange for complete and testable listings.
- We accept a six-folder sandbox (no USB, no drive roots) in exchange for a small, auditable guard.
- We accept speaking unconfirmed image numbers with a label instead of dropping them.
- We accept masking every cross-origin frame whole, which hides embedded viewers from the picture, because their text cannot be scanned for personal data.
- We accept a focus heuristic that can misread one case: 청음 opened a web page whose window stayed behind, then the user left and came back to the same window.
- We accept that file names never reach LLM history (a `history` sentence replaces them), so "쉽게 말해줘" after a listing rephrases a summary.

## Alternatives considered

- **Generalize the web contract.** UIA elements become `InteractiveItem`s, `click` takes a RuntimeId ref, and the guard tiers a `uia://` pseudo-origin. It lost on depth: it is a generic UI clicker, not named actions. It inherits the `"null"` origin trap (`jsutil.py:108`). Every caller must learn UIA virtualization, and listings come back incomplete.
- **Drive Explorer through UIA.** It lost because a minimized window exposes only its title bar (probe-facts) and the file list virtualizes. The filesystem answers the same questions exactly.
- **A 청음-owned folder cursor.** It lost to deriving the folder from the window each time, because blind users also move with the keyboard and a synced cursor goes stale.
- **Change `user: str` to `str | list`.** It lost to a keyword `images` argument, which leaves every text caller and `FakeLlm` untouched.

## Implementation reconciliation

Empty until implementation starts.

## Open questions and risks

- Should vision text stay in `_history` as data, or be replaced by a code sentence like file names are?
- Is auto-picture on thin pages acceptable, or should it ask "그림으로 볼까요?" first?
- Should unconfirmed image numbers about welfare amounts be spoken at all?
- Should the sandbox include removable drives and the OneDrive root?
- A picture call may take several seconds (S1 measures it). Should 청음 say "화면을 보고 있어요" first, or play the working tone?
- In desktop mode, should the browser save downloads into the Windows Downloads folder so "받은 파일" and "다운로드 폴더" mean one place?
- Risk: Windows 11 Explorer tabs share one HWND, so mapping a window to its active folder needs S3.
- Risk: foreground lock may keep new windows behind. The plan measures it and has a spoken fallback.

## Next implementation step

Run spikes S1 to S6, then U0: move `ExecContext`, `read_document` and `BLOCKED` down a layer with no behavior change.
