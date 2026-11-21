# Live Progress Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a long task, the screen shows a short status line as the phase changes, and GPT Live 1.1 speaks one plain update after each finished step and when a candidate answer is about to be checked.

**Architecture:** The autopilot already records a factual step sentence on `Progress`. A new activity sits beside that sentence. `gpt-6-luna` (`STACK.utility`) rewrites only the supplied phase and names into one short line; a fixed Korean line shows immediately and is kept if the model is late, empty, or claims success the step did not have. Conversation mode sends the line to the existing GPT Live session as commentary, so the voice is `gpt-live-1.1`. Dictate mode shows the same line and speaks it through the existing speak path. The factual step sentence stays what "어디까지 했어" reads.

**Tech Stack:** TypeScript, `StructuredLlm` (`src/core/llm.ts`), `Progress`, the VoiceEdge commentary channel, the status panel in `web/src/App.tsx`.

**Spec:** This plan is the spec. It continues `feat/gpt-live-1.1-speech`, where `STACK.voice` is already `gpt-live-1.1`. Do not implement it on a tree whose conversation model is still `gpt-live-1`.

## Global Constraints

- Spoken progress in conversation mode is `session.commentary.append` on the current Live session. That session's model is `gpt-live-1.1`. Do not call another speech model for these updates.
- The rewrite model is `STACK.utility` (`gpt-6-luna`). It receives only the phase, a site or tool name, the action, a target of at most 20 characters, and whether the step worked. It does not receive page text, the user's sentence, or a secret.
- User-facing lines are Korean, one sentence, polite. The English examples in the request ("thinking", "pulling information from", "running tool calling", "I got an answer… I will be checking it") are the meanings of the five phases below, not the strings to show.
- A failed or unconfirmed step must not be described as done. If the model does that, use the fixed line.
- `localSpeechOnly` sentences are unchanged. Sound cues are unchanged. The 15-second progress gap no longer drops a finished step; the "user just spoke" pause stays.

## Review Focus

1. **A failed click.** The model says the page opened. The user hears and sees the fixed "누르려고 했어요" line, not the model's claim. Pinned in Task 1.
2. **Page text or a secret offered as a name.** The utility request body does not contain it. Pinned in Task 1.
3. **Two steps a few seconds apart.** Both are spoken. The old 15-second hold does not swallow the second. Pinned in Task 2.
4. **A late rewrite.** The phase has already moved on. The late sentence does not replace the new line. Pinned in Task 1.
5. **The user is still talking.** The text line updates, and no commentary is sent until they have been quiet for 1.5 seconds. Pinned in Task 2.

---

### Task 1: Activity line, with a fast rewrite and a fixed fallback

**Files:**
- Create: `src/speech/activity.ts`
- Modify: `src/core/progress.ts`
- Test: `tests/unit/activity.test.ts`
- Test: `tests/unit/core-progress.test.ts`

**Interfaces:**
- Consumes: `StructuredLlm.generate({ system, user, schemaName, schema, signal })` from `src/core/llm.ts`. `STACK.utility`.
- Produces:
  - `export type ActivityPhase = "thinking" | "pulling" | "tool" | "checking" | "step"`
  - `export interface ActivityFact { phase: ActivityPhase; source?: string; action?: string; target?: string; ok?: boolean }`
  - `export function fixedActivity(fact: ActivityFact): string`
  - `export async function describeActivity(llm: StructuredLlm | undefined, fact: ActivityFact, signal?: AbortSignal): Promise<string>`
  - `Progress.note(text: string, speak: boolean): void` stores the line without counting as a factual step. `snapshot()` adds `activity: string | null` and `activitySpoken: boolean`. `latest` stays the last `add` sentence. `note` bumps `seq`.

Fixed lines, exact:

| phase | line |
| --- | --- |
| thinking | 생각하는 중이에요. |
| pulling, no source | 내용을 가져오는 중이에요. |
| pulling, source `복지로` | 복지로에서 내용을 가져오는 중이에요. |
| tool | 요청한 일을 실행하는 중이에요. |
| checking | 답을 찾았어요. 화면과 맞는지 확인할게요. |
| step, ok false, action click, target 신청 | '신청'을 누르려고 했어요. |
| step, ok true, action click, target 신청 | '신청'을 눌렀어요. |

`describeActivity` shows nothing itself. It asks `gpt-6-luna` for `{ "line": string }` under schema name `activity_line`. The system text says the line is one polite Korean sentence and must not claim a result the fact does not mark `ok: true`. The user message is `JSON.stringify` of the fact with `target` cut to 20 characters and `source` cut to 40. Empty model output, a thrown call, or a line that says something was opened, found, or finished while `ok` is not `true`, returns `fixedActivity(fact)`. A call still in flight after a newer `note` is ignored by the caller in Task 2; this task's test covers that rule with a tiny helper `settleActivity(current: number, request: number, line: string, fixed: string): string` that returns `line` only when `current === request`, otherwise `fixed`.

- [ ] **Step 1: Write the failing tests**

Assert every fixed line in the table. Assert `describeActivity` with a fake `generate` that returns `{ line: "복지로를 열었어요." }` for `{ phase: "step", action: "click", target: "신청", ok: false }` yields `'신청'을 누르려고 했어요.` Assert the `user` payload of that call does not contain `비밀번호는 556677` even if a caller stuffed it into `source` longer than 40 characters: the sent source is the first 40 characters only, and the test's source is `"비".repeat(40)` so the secret placed after those 40 characters is absent. Assert `settleActivity(2, 1, "늦은 문장", "생각하는 중이에요.")` is the fixed line. Assert `snapshot()` after `add` then `note("생각하는 중이에요.", false)` has `latest` equal to the added sentence, `activity` equal to the note, and `activitySpoken` false.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/unit/activity.test.ts tests/unit/core-progress.test.ts`

Expected: FAIL because `describeActivity` and `note` are not defined.

- [ ] **Step 3: Implement `fixedActivity`, `describeActivity`, and `Progress.note`**

Put the phase table in `fixedActivity`. `describeActivity` uses `STACK.utility` only as the model the caller already constructed; it does not read the environment. Reject a success claim with this test: if `ok !== true` and the line matches `/열었|찾았|끝났|완료|눌렀/`u, use the fixed line.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command. Expected: PASS. Then `npm run test:unit`. Expected: the existing progress tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/speech/activity.ts src/core/progress.ts tests/unit/activity.test.ts tests/unit/core-progress.test.ts
git commit -m "feat: describe a task phase in one short line"
```

---

### Task 2: One spoken update per finished step

**Files:**
- Modify: `src/agents/web/autopilot.ts` (the step loop around the `iterations++` and `onStep` calls)
- Modify: `src/agents/web/skills/browse.ts` (`stepSentence` call site only)
- Modify: `src/server/voice_edge.ts` (`narrate`)
- Test: `tests/unit/voice-edge.test.ts`
- Test: `tests/unit/browse-skill.test.ts` or the existing autopilot unit test that already watches `onStep`

**Interfaces:**
- Consumes: `Progress.note`, `describeActivity`, `fixedActivity`, `ActivityFact` from Task 1. `stepSentence` stays the factual `add`.
- Produces: while a goal run is in progress, `progress.snapshot().activity` changes to the fixed line for `thinking` before the step decision, `pulling` with the current site label before the page is read, and `tool` before the action runs. A finished iteration `add`s `stepSentence` and `note`s the activity line with `speak: true`. The moment a candidate answer is accepted for grounding, `note(fixedActivity({ phase: "checking" }), true)` runs before the check. `describeActivity` may replace that note only through `settleActivity` while the seq it started from is still current. `narrate` sends `{ activity: snapshot.activity }` on the loopback socket whenever `activity` changes, and sends `session.commentary.append` of that same text only when `activitySpoken` is true. It does not wait 15 seconds. It still waits until `transcript.updated` is at least 1.5 seconds ago before the commentary. It does not append the factual `latest` sentence as a second commentary.

- [ ] **Step 1: Write the failing tests**

In the voice-edge monitor test, start a turn whose progress notes `"생각하는 중이에요."` with `speak: false`, then notes `"'신청'을 눌렀어요."` with `speak: true`, less than 15 seconds later. Expect one socket message `{ activity: "생각하는 중이에요." }` and no commentary for it, then `{ activity: "'신청'을 눌렀어요." }` and exactly one commentary of that sentence. A second spoken note three seconds later is also one commentary. While `transcript.updated` is less than 1.5 seconds ago, the activity message is still sent and the commentary is not, until the quiet time has passed.

In the browse or autopilot test, one failed click (`ok: false`, target `신청`) records `latest` from `stepSentence` and an activity that `describeActivity` could not turn into a success claim. Assert the utility `user` payload has no page paragraph: pass a page whose main text contains `비밀번호는 556677` and assert the recorded generate user does not contain `556677`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit tests/unit/voice-edge.test.ts tests/unit/browse-skill.test.ts -t "activity|progress"`

Expected: FAIL because `narrate` still speaks `latest` on the 15-second gap and no activity message exists.

- [ ] **Step 3: Implement the phase notes and the commentary rule**

Call `note(fixedActivity(fact), false)` at the three non-spoken phases, then start `describeActivity` without awaiting it ahead of the browser action. On completion, `note(settleActivity(...), speak)` only if this run's seq is unchanged. Await nothing in the step loop except the work the loop already awaits. Spoken phases are `checking` and `step` only.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same command, then `npm run test:unit`. Expected: PASS, including the existing test that a long task speaks each new progress step. Update that test's expectation from the 15-second commentary of `latest` to one commentary of the spoken activity per finished step.

- [ ] **Step 5: Commit**

```bash
git add src/agents/web/autopilot.ts src/agents/web/skills/browse.ts src/server/voice_edge.ts tests/unit/voice-edge.test.ts tests/unit/browse-skill.test.ts
git commit -m "feat: speak one update after each finished step"
```

---

### Task 3: Show the same line on screen

**Files:**
- Modify: `web/src/api.ts` (`ProgressSchema`)
- Modify: `web/src/voice-edge.ts` (`SocketMessageSchema`, `LiveCallbacks`)
- Modify: `web/src/conversation.ts` (`watchProgress` and the live `result` handler's neighbor)
- Modify: `web/src/view.ts` and `web/src/App.tsx` (the work-status list)
- Test: `tests/unit/ui-view.test.ts` or the existing view test that renders the status panel
- Test: `tests/e2e/api.test.ts` progress assertion, only if it snapshots the whole JSON

**Interfaces:**
- Consumes: `snapshot().activity` and `activitySpoken` from Task 1. Socket messages `{ activity: string }` from Task 2.
- Produces: `ProgressSchema` accepts `activity: string | null` and `activitySpoken: boolean`. The status panel has a row whose `dd` id is `st-activity`, `aria-live="polite"`, showing `activity` and hidden when it is null. Dictate mode's `watchProgress` sets that row from the poll. When `activitySpoken` is true it speaks `activity` through the existing `sayWhileBusy` path and does not also speak `latest`. Conversation mode sets the same row from `{ activity }` and does not start a second speaker for it, because the Live session is already saying it.

- [ ] **Step 1: Write the failing test**

Render the status view with `activity: "내용을 가져오는 중이에요."` and expect the `st-activity` text. Render `activity: null` and expect the row hidden. A progress poll fixture `{ running: true, seq: 2, spoken: true, latest: "이전 문장", activity: "요청한 일을 실행하는 중이에요.", activitySpoken: false }` updates the row and does not call the speak function. The same fixture with `activitySpoken: true` calls speak once with that activity string.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit tests/unit/ui-view.test.ts -t "activity"`

Expected: FAIL because the row and the schema field do not exist.

- [ ] **Step 3: Implement the row, the schema, and the two clients**

Keep the existing state, step, title, and access rows. The activity row is the first row inside `.work-status`.

- [ ] **Step 4: Run the test to verify it passes**

Run the same command, then `npm run test:unit`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/api.ts web/src/voice-edge.ts web/src/conversation.ts web/src/view.ts web/src/App.tsx tests/unit/ui-view.test.ts tests/e2e/api.test.ts
git commit -m "feat: show the task phase while work continues"
```
