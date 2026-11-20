# Candidate 4: scope-first screen explanation and desktop control

## Problem

청음 acts on one kind of surface today: a web page with a URL. Every guard, approval, and "what is on screen" answer keys on that URL. Two new needs share one constraint. The screen must be described from pixels as well as text, and desktop windows have no URL. The owner decided that screenshots go to OpenAI, that clicks stay by name, and that the model never writes a command.

Grounding shows four constraints this design must honor. `Observation.url` is required and `Action` is strict (`core/actions.py:76`). `PolicyGuard.tier_of` reads only the origin, and a pseudo-scheme gets tier `none` (`safety/guard.py:93`). `OpenAIStructuredLlm.generate` takes `user: str` and has no image part (`core/llm.py:98`). `redact_text` cuts a page to a stub, so text and picture would get different privacy treatment (`safety/privacy.py:165`).

## Usage (caller's view)

The consumer is the skill that answers the user. Three call sites:

```python
# 1. "화면 그림으로 설명해줘" on a web page (BrowseSkill.screen)
got = await explainer.explain(web_scope, ExplainRequest(source="picture", question=text), ctx)
#  got.speech       -> "화면 그림을 보고 설명할게요. ..."
#  got.used         -> "picture" | "text" | "refused"
#  got.names        -> ["신청하기", "다음"]  (already matched to the live outline)

# 2. "탐색기에서 다운로드 폴더 열어줘" (desktop, File Explorer)
out = await desktop.run(parse_desktop_action({"op": "open_folder", "name": "다운로드"}), ctx)
#  out.status -> "ok" | "needs-approval" | "not-found" | "policy-denied"
#  out.speech -> "다운로드 폴더를 열었어요. 파일 12개가 있어요."

# 3. "그거 열어줘" right after an explanation
out = await desktop.run(parse_desktop_action({"op": "open_item", "name": "보고서.hwp"}), ctx)
#  The name is matched on the live folder listing, never on the picture.
```

The caller never passes a coordinate, a path, or a command. Names come from the live listing.

## Shape

**Scope is the one key.** A `Scope` replaces the URL as the thing a guard, a fingerprint, and an answer refer to. A web scope is the origin plus path from `SiteProfile`. A desktop scope is an `AppEntry` id plus a window handle. Tier, masking, approval, and the action log all read `Scope`. `PolicyGuard` keeps its URL logic and is not changed.

**Two sources, one explainer.** `perception/` defines a `ScreenSource` Protocol: `read(scope) -> ScreenRead` (text, names, flags) and `picture(scope, masks) -> bytes`. The web adapter implements it next to `observe()` (`agents/web/browser/__init__.py:566`), using `page.screenshot(mask=..., style=HIDE_CURSOR, scale="css")`. The desktop port implements it with `PrintWindow` on the one window. `perception` imports only `core` and `safety`, so no layer rule breaks. `ScreenExplainer.explain` is the only public method. It hides the gate, capture, masking, redaction, the vision call, and verification. The gate is a pure function, `decide_picture(read, request) -> PictureDecision`.

**Picture gate fails closed.** No picture is taken when `auth_page_kind` is not `other` (`agents/web/auth_page.py:55`), when `digest.BLOCKED` matches (`agents/web/digest.py:17`), when the read finds a sensitive value (`detect_sensitive`), when a web page has an iframe, or when a desktop window title matches a login or verification word. The reply names the reason in Korean. CAPTCHA images in an iframe are therefore never sent.

**Masks come from anchors, not pixels.** Web masks are `input, textarea, select, [type=password], iframe`. Desktop masks are the bounding rectangles of UIA `Edit` and password controls. The picture is refused, not masked, when a sensitive value is found in the text read. Pixels have no equivalent of `redact_text`.

**Answers from pictures are checked against text only.** The vision call returns `{summary, names}` under a strict schema with no action field. `unsupported_numbers` (`safety/verify.py:169`) checks numbers above 10 against the text read of the same scope. An image-only number is removed and the speech says so. Each name must equal a live outline or listing name, or it is dropped. The speech always starts with "화면 그림을 보고 설명할게요", so the user knows the source.

**Desktop is a sibling agent, not a web extension.** `agents/desktop/` has its own strict `DesktopAction` (ops: `open_app`, `open_folder`, `list`, `open_item`, `read_window`, `go_up`). The ops form a closed set. `DesktopGuard` (`safety/desktop_guard.py`) takes its tier from the `APPS` table and confines folders to known user folders. It returns the same `{allowed, code, reason}` shape as `PolicyGuard`. The approval kind is `desktop`, with a fingerprint over scope, op, target name, and folder path, but not the window title.

**Names are the address.** The model chooses an op and a name. Code turns the name into an entry in the current listing (filesystem for Explorer, UIA for windows). An unknown or ambiguous name asks back. `open_item` is confirmed aloud before it runs, because it starts an external program.

**Invariants in types.** `DesktopAction` is strict, so `path` or `command` is rejected at parse (same as `Action`). `Tier` is a `Literal`. `DesktopPort` is a Protocol with a fake for tests. Real Windows calls sit behind it, so every unit test runs offline.

**What the system does not do.** No pixel click. No picture on every step. No whole-desktop capture. No delete, rename, move, or write. No executable open. No CAPTCHA reading or bypass. No vision output used as an instruction.

## Synthesis decision

Not applicable. This is candidate 4. The arena synthesis fills this section.

## Tradeoffs accepted

- We accept a second guard (`DesktopGuard`) and a second action contract, in exchange for not widening `Action` or `PolicyGuard` to non-URL surfaces.
- We accept that pictures of iframe pages are refused, in exchange for never sending a CAPTCHA frame.
- We accept that numbers seen only in a picture are dropped, in exchange for keeping the existing number check meaningful.
- We accept four new intents, which moves the registry count from 37 to 41, in exchange for named, testable entry points.
- We accept that `DESCRIBE_SCREEN` gets a new `source` parameter instead of a new intent for pictures, so the user still says one thing.
- We accept that `바탕화면에 뭐 있어?` will route to desktop folder listing instead of the browser describe path, which changes an existing rule result.

## Alternatives considered

- **Extend `PolicyGuard` with an app tier.** Rejected. `Observation`, `ActionType`, the fingerprint, and `TurnResult.accessMode` are all web-shaped. Adding a tier source would touch every one of them, and the `null`-origin trap would return.
- **Drive Explorer through UIA for everything.** Rejected for listing. A minimized window exposes only its title bar (probe-facts). The filesystem is deterministic. UIA stays for window reading and focus.
- **Vision answer returns click coordinates.** Rejected by decision. It would also break name-addressed verification.
- **Pixel-level masking by detecting text in the image.** Rejected. There is no reliable pixel analogue of `redact_text`, so refusing is safer than masking.
- **One screenshot per step, always on.** Rejected by decision and by cost.

This was not the only viable shape. Other shapes are in other candidates.

## Implementation reconciliation

None yet.

## Open questions and risks

- Does the owner's OpenAI vision model accept strict `json_schema` together with an image part? Should the vision role fall back to the WEB role when that role is already OpenAI?
- Should a `바탕화면` phrase route to the desktop folder or to the browser? Current rule order (`rules.py:177`, `:198`) gives `DESCRIBE_SCREEN`.
- Should opening a document (non-executable) need approval, or only launching an app?
- Risk: does `PrintWindow` return usable pixels for Explorer and for Windows 11 UWP apps (Calculator, Notepad) when the window is covered?
- Risk: will vision names match `InteractiveItem.name` strings well enough to be useful, or will most be dropped?
- Risk: does `_run`'s action log accept a desktop host? Its API was not verified.

## Next implementation step

Add `images` to `OpenAIStructuredLlm.generate` (`core/llm.py:98`) and prove the request body with an `httpx.MockTransport` test. Nothing else depends on it, and it is the first owner-visible risk.
