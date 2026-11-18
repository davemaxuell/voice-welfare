# Orchestrator split: synthesized design

Goal (the user's): every stage of the voice pipeline has one obvious home. `orchestrator/session.py` (2,388 lines) keeps only orchestration: session lifecycle and public API, queue/epoch/stop, the language wrapper, gates, `_process_korean` sequencing, `_finish`, `_run_plan`, the `_answer_many` loop, `_route` dispatch, `_unknown`, Agent B glue, the B→A hand-off. Behavior does not change. The pin is the full pytest suite (271 tests) plus the scenario report compared with timing removed.

Four candidate designs were written in parallel (Opus, Fable, Sonnet, Haiku) and all converged on one shape. The base is the Fable candidate (`scratchpad/arena/candidate-fable/`); grafts and rejections are listed at the end.

## Shape

**One shared mutable object: `core/dialogue.py::DialogueState`.** It holds the session state (`_state` today) and the six waiting slots. Read-only from outside (properties, no setters, `__slots__`); it changes only through named moves, and each move's docstring lists its callers. Slot values stay the dicts they are today (no new record types), so the edit is mechanical.

| Today | Read | Move (writers) |
|---|---|---|
| `_state` | `state` | `commit(state)`: `_finish` only |
| `_pending` | `approval`, `confirmation`, `expects_confirmation` | `ask_approval(p)`, `clear_approval()`, `value_filled(fid)` (also voids approval), `navigated(on_form)`, `stop()` |
| `_awaiting_field_id` | `awaiting` | `ask_value(fid)`, `value_filled(fid)`, `drop_value_wait()`, `navigated(on_form)`, `stop()` |
| `_clarification` | `clarification` | `ask_which(value, candidates)`, `clear_choice()`, `stop()` |
| `_profile_asking` | `profile_question` | `ask_profile(slot)`, `profile_done()` |
| `_personal_pending` | `vault_confirm` | `ask_vault_confirm(cmd)`, `take_vault_confirm()` |
| `_guided` | `guided` | `start_guided(...)`, `end_guided()` (the progress dict itself is mutated by GuidedFill, as today) |

`stop()` clears only approval, awaiting and clarification, exactly like `_stop` today. The other three survive a stop (open question for the user, not changed here).

Every other piece of state keeps one owner:

| State | Owner |
|---|---|
| `_history`, `_last_semantic`, `_epoch`, `_controller`, `_lock`, `_lang`, `_consent`, `_grounded` (tests read it), `_profile`, `_approvals` (the set PolicyGuard reads through ExecContext) | `SessionOrchestrator` |
| `_reading`, `_listed_links`, `_reading_text` | `BrowseSkill` |
| `_last_field_id` | `FormSkill` |
| `_hints_given` (`_once`) | `Narrator` |
| `_understood_by` | none: `Understanding.understand` returns `Understood(intents, by)` |

**Collaborators, not mixins, not a context bag.** Each extracted piece is a class built once per session in `SessionOrchestrator.__init__` with exactly what it needs. Per-turn data arrives as `ctx: ExecContext` (stop signal, trace, approvals) plus the utterance text when the handler inspects it. No collaborator receives `Turn` or the orchestrator, so none can reach epoch, history or another collaborator's state. LLM access is late-bound: collaborators hold `deps` (or a callable) and read `deps.llm` at call time, because tests replace `deps.llm`, `deps.practice_mode` and `deps.welfare.llm` after the session is built. Agent B and the vault reach Agent A skills only as injected callables, so `agents/web/skills` imports neither `agents/welfare` nor `personal`.

**`_guide_next`.** It splits into a pure `next_step(view) -> NextStep(speech, field_id)` and one effectful `FormSkill.ask_next(view)`, the only place that turns a next-step question into `dialogue.ask_value`. `_describe_screen` loses its last line (the guide tail) and its caller appends `ask_next`, so the spoken text is byte-identical. Every former caller calls `ask_next` at the same position it called `_guide_next`.

**Approval stays a gate in the orchestrator.** `_approve` reads `dialogue.approval`, grants with `with ctx.granted(ids):` (a small context manager on ExecContext replacing the add/try/finally/discard blocks), and calls the form skill to run the approved action. Guided fill keeps granting itself, as today (flagged, not fixed).

## Module map

| New file | Receives |
|---|---|
| `core/dialogue.py` | `DialogueState` |
| `speech/phrasing.py` | `josa`, `speak_label` (from agents/web/profile.py), `speak_date` (from personal/commands.py), `_chunk_text`, `READ_CHUNK`, `_display` → `readback` |
| `speech/screen.py` | `Narrator`: `_once`, `_describe_field`, `_describe_buttons`, `_describe_view`, `_describe_screen` (minus guide tail), `_describe_page`, `_popup_name`, `_main_chunk`, `_brief_screen`, `_page_intro`, `_summarize_body` |
| `agents/web/skills/common.py` | `_browse_state`, `_is_form_open`, `_not_open`, `_outcome_failure` |
| `agents/web/skills/form.py` | `FormSkill`: `next_step` + `ask_next`, `_form_state`, `_assist_fill_request`, `_fill`, `_resolve`, `_fill_one`, `_read_field`, `_resolve_for_read`, `_edit_field`, `_next`, `_prev`, `_after_step_move`, `_review_values`, `_review`, `_prepare_submit`, `_reject`, the execution half of `_approve`, field choice of `_explain` |
| `agents/web/skills/browse.py` | `BrowseSkill`: `_mock_sites`, `_after_navigation`, `_search_url`, `_open_site`, `_follow_link`, `_back`, `_readable_text`, `_read_main`, `_list_links`, `_search`, `_resume`, `_screen`, `_current_step`, `_about_site`, `_web_answer`, `_run_goal`, `_login`, `_auth_done`, `LINKS_PER_PAGE` |
| `agents/web/skills/guided.py` | `GuidedFill`: `_start_guided`, `_guided_question`, `_guided_answer`, the start trigger |
| `personal/dialogue.py` | `PersonalDialogue`: vault confirm + vault/record commands from `_personal_turn`, `reminders` body |
| `understanding/filters.py` | `is_question_like`, `_short_reply`, the filler strip, `_vague_question`, the LLM split half of `_answer_many` |
| `understanding/understand.py` | `Understanding` (`_understand`, `merge_fills`) returning `Understood` |
| `understanding/chat.py` | prompt, schema and LLM call of `_free_chat` (dispatch stays in the orchestrator) |
| `orchestrator/handoff.py` | only if session.py is still over ~850 lines at the end: `_start_application`, `_open_application` |

Layering: `core ← safety ← speech.phrasing ← agents/web ← speech.screen ← agents/web/skills ← orchestrator`. `speech/__init__` re-exports `phrasing` only, and `agents/web/__init__` does not import `skills`, so no cycle forms.

## Units (each ends with the full suite green; marked * also diff the scenario report)

- **U1*** `core/dialogue.py` + `tests/unit/test_dialogue.py`. Inside the still-single class, replace `_state` and the six slots with `self.dialogue` reads and named moves. No method moves.
- **U2*** Still inside the class: split `_guide_next` into `next_step` + `_ask_next`; drop the tail from `_describe_screen` and append it at its caller. Add `ExecContext.granted`.
- **U3** `speech/phrasing.py`; delete the old definitions and exports in the same unit.
- **U4** `speech/screen.py` Narrator.
- **U5*** `agents/web/skills/common.py` + `form.py` FormSkill; `_approve` shrinks to the gate.
- **U6*** `agents/web/skills/browse.py` BrowseSkill.
- **U7*** `agents/web/skills/guided.py` + `personal/dialogue.py` + the precedence chain in `_process_korean`.
- **U8*** `understanding/filters.py`, `understand.py`, `chat.py`.
- **U9*** Measure session.py; `handoff.py` only if needed; a small import-direction test; docs (CLAUDE.md, README.md, docs/architecture-check.md).

Every unit moves code and deletes the old method in the same change. No forwarding wrappers, no compatibility aliases.

## Synthesis decision

- Base: Fable. All four candidates converged on DialogueState-in-core + constructor-injected collaborators + immediate writes + a single named writer for the `_guide_next` side effect. Fable's version adds the fewest new owners, keeps `Turn` out of the skills (they get `ctx`), and does the only semantic refactor (`_guide_next`) before any file move so later units are cut-and-paste.
- Grafted from Opus: `Understood(intents, by)` as a return value; the injected-consult rule (B callables inside A skills); a rerunnable scenario-diff script per unit.
- Grafted from Sonnet: introduce DialogueState moves one family at a time inside U1 so each family is checked; the stop asymmetry documented in `stop()`.
- Grafted from Haiku: nothing structural; its note that `ExecContext.is_stopped` reads the live STATE (a STOPPED session refuses actions until a turn finishes) is preserved as-is.
- Rejected: typed records for slot values (Opus) because they change every access site for no behavior gain; extra owner classes for history, epoch, hints, reading cursor and grounding (Sonnet, Haiku) because the orchestrator owning them is already one owner each; moving `Turn`/`ExecContext` into core (Opus) because skills take `ctx` and need no `Turn`; renaming the `s._grounded` test (Sonnet, Haiku) because tests stay untouched.

Cross-judge (Fable model, read-only, scored the four blind as A-D): base B = Fable 25/30, Opus 23, Sonnet 18, Haiku 12. Agreement with my pick. Its corrections, adopted:

- Intent label on the exception path. Today `_personal_turn` and the guided path set `turn.intentType` before they await, so an exception still reports `GUIDED_FILL` / `VAULT_CONFIRM` in the RECOVERING result. The new chain keeps the label written before the await (a narrow `label` callback, or the orchestrator sets it before calling), never only after return.
- Guided fold. A guided answer that folds (the user said something else) still falls through to the guided-start check on the same utterance, as today.
- `next_step` is module-private in `form.py`, so only `ask_next` can produce the next-step question.
- Every unit runs `bash .audit/check_unit.sh <unit>` (full suite + scenario diff), not only the starred ones.
- U1 goes in two phases: plain-attribute rename first (suite green), then moves one slot family at a time, then read-only.
- `short_reply` returns its result and a "drop clarification" flag; nothing under `understanding/` writes DialogueState.
- `ExecContext.is_stopped` keeps reading the session state live.

## Open questions for the user (behavior, not changed here)

- Should "멈춰" also end guided fill, the vault yes/no and the profile question? Today they survive a stop.
- Should guided fill go through the same approval step as the one-shot assist? Today it grants itself.

## Implementation reconciliation

What landed differs from the design above in these places. Each unit's check output is in `.audit/runs/<unit>/`.

- **U1.** As designed: `core/dialogue.py` with `__slots__`, read-only properties and named moves; `tests/unit/test_dialogue.py` adds 12 tests (271 → 283).
- **U2.** `next_step` became module-private `_next_step` returning `NextStep(speech, field_id)`; `_ask_next` is the only next-step `ask_value` writer. `ExecContext.granted(ids)` replaced the three add/try/finally blocks.
- **U3/U4.** `speech/phrasing.py` also took `chunk_text` and `READ_CHUNK` (public names). `Narrator` reads `deps.llm` and `deps.web` at call time; its async methods take `ctx`.
- **U5.** The Draft builder `_d` moved to `agents/web/skills/common.py` under its old name so moved lines stayed byte-identical; U7 moves it to `core/turn.py` as `draft`. `_approve` is the gate only; the execution halves are `FormSkill.assist_approved` and `submit_approved`, each called inside `ctx.granted`. `_explain` stays in the orchestrator and writes the field cursor through `FormSkill.field_explained(fid)`, the one writer next to the read-only `last_field_id`.
- **U6.** `BrowseSkill` takes `official_text` (Agent B's `readable_service`) as an injected callable. `screen` and `login` take the utterance as an argument. A new `listed_link(index)` serves `_unknown`. `browse.py` imports `understanding.sites`, so the layering gains `agents/web/skills → understanding` (understanding imports only core, no cycle). The two reading resets stay distinct (`after_navigation` clears reading and links; the URL checks in `read_main`/`list_links` clear reading only).
- **Harness.** The first U6 run failed 47 tests because another session's pytest owned the mock site on :5174 and it went away mid-run. `check_unit.sh` now refuses to start when :5174 is already served.
- **U7.** `_d` became `core/turn.py::draft()` (codemod over 112 calls). The first run failed 3 tests because locals named `draft` in form.py shadowed the function; they became `reply`. `GuidedFill` splits the answer into a sync `active()` (ends guided fill if the page changed) and `answer(text, ctx)`, and the start into `wants_start(text)` and `start(ctx)`, so the orchestrator writes `GUIDED_FILL` before any await. `PersonalDialogue` has `confirm(text)`, `run(cmd)` and `saved_for(label)` (GuidedFill's injected vault lookup). The precedence chain is inline in `_process_korean`. A differential probe (15 sessions, 71 turns, exception paths included) gave identical output on the pre-U7 tree and the new one.
- **U8.** `short_reply` split as classification only (`short_reply_kind` in `understanding/filters.py`); the reply and the `clear_choice()` write stay in the orchestrator, instead of a ShortReply record with a drop flag. `Understanding.understand` takes an `IntentContext`, the awaited field (a one-attribute protocol), `clarifying: bool`, the page title, recent dialogue and a `trace` callable, and returns `Understood`; the UI path builds `Understood([forced], "ui")`. The LLM call of free chat is `understanding/chat.py::chat_route`. One `SIMPLE_TEXT_SCHEMA` lives in `core/llm.py`. The two `_text_of` helpers stay separate because i18n's strips whitespace and session's does not.
- **U9.** session.py ended at 996 lines, over the ~850 mark, but `orchestrator/handoff.py` was not created. The two hand-off methods read and write `_grounded` (owned by the orchestrator, read by a test), use the turn id, traces, `deps.practice_mode`, Agent B and four collaborators. A separate class would need all of that passed in, which is the context bag this design rejected. Everything left in session.py is on the "keeps only orchestration" list above. `tests/unit/test_layers.py` pins the package import directions as an allowlist and checks the table has no cycle.
