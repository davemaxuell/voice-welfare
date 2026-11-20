# Design: one vocabulary, two surfaces

Candidate 2. Bare paths are under `sketch/src/cheongeum/`. A path with a line number points at the repo.

## Problem

청음 sees a screen only as DOM text and acts only inside a browser. The web assumption is hard-wired in four places: the guard's tier comes from a URL origin (`safety/guard.py:116`), `_approve` re-observes through `self.web` (`orchestrator/session.py:1127`), `_finish` reports `self.web.current_view` (`:597`), and `ExecutedAction.action` accepts only the web `Action` (`core/turn.py:159`). Two more facts shape the design. `generate` takes `user: str` and the WEB role may be a text-only local model (`core/llm.py:98`). Pixels have no `redact_text`, so a mask can only come from what 청음 already knows about the screen.

## Usage (caller's view)

The user learns two new kinds of sentence. Everything else is the vocabulary they already use on the web.

```
"문서 폴더 열어줘"        → "문서 폴더를 열었어요. 폴더 2개, 파일 14개가 있어요. 최근 것부터 1번 진단서.pdf, 2번 …"
"진단서 열어줘" / "1번"   → "진단서.pdf를 열었어요. 내용을 들으려면 '읽어줘'라고 하세요."
"목록 더 알려줘" · "읽어줘" · "뒤로 가줘" · "화면 설명해줘"   → same intents as on the web
"화면 사진으로 설명해줘"  → "화면 사진을 보고 말씀드려요. 큰 공지 그림이 있어요. … 숫자는 사진에서 읽은 것이라
                            틀릴 수 있어요. 여기서 누를 수 있는 것은 1번 '자세히 보기'예요."
"1번 눌러줘"              → the existing follow_link path, by name
```

```python
# 1. ROUTES: shared verbs go to whichever surface is in front
"FOLLOW_LINK": lambda s, i, t: s.front.follow_link(i["name"], t.ctx),
"LOOK":        lambda s, i, t: s.front.look(t.text, t.ctx),
"OPEN_FOLDER": lambda s, i, t: s._desk_or_off(lambda d: d.open_folder(i["place"], t.ctx)),

# 2. a skill gets a masked picture or a reason, never raw bytes
out = await self.web.capture(ctx)                    # WebOutcome.shot: Picture | Refused
seen = await self.eyes.describe(out.shot, question=text, title=view["title"],
                                names=picture_names(view), sources=picture_sources(view), ctx=ctx)
self._listed_links = list(seen.pressable)            # "1번 눌러줘" already works

# 3. the desktop skill opens something by a spoken name
out = await self.desk.open_entry("진단서", ctx)      # DeskOutcome: ok | needs-approval | unconfirmed | ...
```

## Shape

**The front surface.** The orchestrator keeps one fact: which surface the user is on. It is the `platform` of the last view a skill returned (`"pc"` or `"desktop"`), written only in `_finish`. `BrowseSkill` and the new `DeskSkill` share seven method names (`Front`, `orchestrator/session.py`), so five existing intents route to `s.front` and a folder is navigated with web words. Three intents are new: `OPEN_FOLDER`, `OPEN_APP`, `LOOK` (37 to 40 rows). Leaving the web surface drops the form's value wait, so a word said in a folder is never typed into a field.

**Pictures are sealed.** `core/picture.py` defines `Picture`, which exists only after masking, and `Shot = Picture | Refused`. `Picture.masked` is the only constructor. A structure test allows exactly two callers, the two adapter `capture` functions. `VisionLlm.see` accepts only a `Picture` and is a different method from `generate`, so a text model cannot be handed an image. `create_vision_llm` returns `None` unless the provider is `openai` (role `LLM_VISION_*`). No contract holds a coordinate. Mask rectangles live inside an adapter between tree read and paint.

**The mask is derived, then enforced in the page.** `mask_plan(view, known_private)` is pure. It names every field, the personal values found in page text by `private_values` (the value half of `redact_text`), the user's vault values, and values 청음 typed this session. `mask.js` stamps those elements, every live input and every iframe. If a private string cannot be located, or a CAPTCHA attribute is present, no picture is taken. Before that, `picture_refusal(view)` refuses login, verification, blocked and application-form screens. Capture is a guarded action (`"capture"`), so it is rate-limited, logged, and visible in `TurnResult.actions`.

**What the model may decide.** One paragraph of description and indexes into a name list that code built. `Eyes.describe` (`speech/picture.py`) redacts the text, labels numbers absent from DOM text, discards the answer when the model reports a CAPTCHA or login, and builds the lead and cautions in code. The speech sets `flags.fromImage` and is replaced by a placeholder in the history the planner reads.

**The app table is the allowlist.** `core/apps.py` holds `APPS` and `PLACES`, the desktop analogue of `INTENTS` and `KNOWN_SITES`. One row gives an app its names, launch recipe, tier, picture policy and named acts. The guard's tier (`app_tier`), the resolver (`understanding/apps.py`), the rule vocabulary and the OS call all derive from it. `DeskAction` (`core/desk.py`) is a strict union by `type` with no path string, command line or key chord. A folder is a `FolderRef`, a place plus names seen in a listing. `folders.safe_path` alone turns one into a path and checks containment after `resolve()`.

**One gate, one guarded run, one approval skeleton.** `PolicyGuard.check_desk` sits in the same class and shares the first four checks. `safety/run.py` holds `guarded_run`, the body of today's `_run` (`agents/web/agent.py:499`), and both agents call it. `_approve` changes in three spots: where it re-observes, which fingerprint function it calls, and where it dispatches. All three follow from whether the pending action is a desk action.

**File Explorer: the filesystem is the truth, the window is the display.** 청음 lists with `os.scandir` and opens with `os.startfile`. The Explorer window is told to show and select the same item. 청음 never reads the window's list. The unmeasured virtualized list leaves the critical path, and the tests run on a temp folder with `FakeDesktop` on any OS.

**Interface depth.** Skills see `capture(ctx)`, `open_entry(name, ctx)` and `describe(picture, ...)`. Behind them sit refusal rules, mask derivation, DOM stamping and cleanup, the guard, the action log, window lookup, path containment, file-kind risk, open verification and number labelling. `DesktopPort` has eleven methods. That is wide, but it is the OS boundary and the only thing a fake replaces.

**Explaining a desktop window.** `DeskSkill.look` captures that one window by handle, masks every editable control, and calls the same `Eyes`. An app whose row says `picture="ask"` is photographed only after a spoken question and a go word.

## Synthesis decision

Left for the arena.

## Tradeoffs accepted

- We accept moving `ExecContext` and the body of `_run` in exchange for one guarded-run implementation. It refactors the most safety-critical web function.
- We accept that the Explorer window may lag 청음's position in exchange for a listing that is complete, fast and testable.
- We accept picture masking narrower than `redact_text` (values, not everything after a keyword) in exchange for pictures that are not mostly black. Refusing whole screen classes pays for it.
- We accept speaking image-only numbers with a caution instead of dropping them. The owner chose labelling.
- We accept a `DESKTOP` session state and one state-conditioned rule ("진단서 열어줘" in a folder) in exchange for no item-level intents.

## Alternatives considered

- **Extend the web `Action` with desktop verbs and a pseudo-URL tier.** Smallest diff. It makes `click` plus `app` representable, and `uia://` has origin `"null"`, which invites adding `"null"` to `allowedOrigins`. Rejected.
- **A standalone desktop pipeline with its own guard, approval gate and one intent per verb.** Simple to build. The user gets two vocabularies and the next contributor gets two copies of every safety rule. Rejected.
- **Drive Explorer through UI Automation.** Faithful to "control the app". It depends on unmeasured list virtualization and a restored window. Rejected for Explorer, kept for other apps' named controls.
- **Add `images=` to `generate`.** One method. Every fake and every text-only role would then accept an image. Rejected.

## Implementation reconciliation

Empty until implementation starts.

## Open questions and risks

- Should the real Downloads folder and 청음's own download list (`READ_DOWNLOAD`, `understanding/rules.py:176`) become one thing?
- Is narrower masking for pictures acceptable, given the refusals above?
- May 청음 photograph a window of an app outside the table after asking aloud, or never?
- Does `page.screenshot` work on a background tab of shared Chrome, and does the owner's model accept an image with strict `json_schema`? Both are spikes.
- Can an existing Explorer window be navigated and told to select a file without UI Automation? If not, each folder opens a new window.

## Next implementation step

Run spikes S1 to S3 in `PLAN.md`, then build `core/picture.py` and `OpenAIVisionLlm` with its payload test.
